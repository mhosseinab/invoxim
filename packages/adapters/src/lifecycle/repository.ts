import type {
  AccountDeleteRequest,
  DeleteDataRequest,
  DisconnectRequest,
} from "@invoxim/contracts";
import type {
  DeletionMarker,
  LifecycleRepository,
  LifecycleSession,
  TenantContext,
} from "@invoxim/core";
import { LifecycleError } from "@invoxim/core";
import {
  previewArguments,
  previewSnapshot,
  previewSql,
  projectPreview,
} from "./graph";

const MAX = 2_147_483_646;
async function hash(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function createLifecycleRepository(
  db: D1Database,
  now: () => number = Date.now,
): LifecycleRepository {
  const live =
    "EXISTS(SELECT 1 FROM session s JOIN profiles p ON p.user_id=s.userId WHERE s.id=? AND s.userId=? AND s.expiresAt>? AND p.status='active')";
  function authority(session: LifecycleSession) {
    return [session.sessionId, session.tenant.userId, now()];
  }
  async function existing<T>(
    tenant: TenantContext,
    route: string,
    key: string,
    input: unknown,
  ): Promise<T | null> {
    const found = await db
      .prepare(
        "SELECT body_hash,result_json FROM lifecycle_commands WHERE user_id=? AND route=? AND key=?",
      )
      .bind(tenant.userId, route, key)
      .first<{ body_hash: string; result_json: string }>();
    if (!found) return null;
    if (found.body_hash !== (await hash(JSON.stringify(input))))
      throw new LifecycleError("CONFLICT");
    return JSON.parse(found.result_json) as T;
  }
  function commandGuard(
    userId: string,
    route: string,
    key: string,
    executor: string,
  ) {
    return db
      .prepare(
        "SELECT executor FROM lifecycle_commands WHERE user_id=? AND route=? AND key=? AND executor=?",
      )
      .bind(userId, route, key, executor);
  }
  async function authorizeDeletion(
    session: LifecycleSession,
    request: AccountDeleteRequest,
  ) {
    const row = await db
      .prepare(
        `SELECT user_id FROM profiles WHERE user_id=? AND status='active' AND version=? AND version<? AND ${live}`,
      )
      .bind(session.tenant.userId, request.version, MAX, ...authority(session))
      .first();
    if (!row) throw new LifecycleError("CONFLICT");
  }
  async function beginDeletion(
    session: LifecycleSession,
    request: AccountDeleteRequest,
    marker: DeletionMarker,
  ) {
    const requestGuard =
      "EXISTS(SELECT 1 FROM lifecycle_deletions WHERE user_id=? AND scope='account' AND target_id='account' AND request_id=?)";
    await db.batch([
      db
        .prepare(
          `UPDATE profiles SET status='deleting',version=version+1,updated_at=? WHERE user_id=? AND status='active' AND version=? AND version<? AND ${live}`,
        )
        .bind(
          now(),
          session.tenant.userId,
          request.version,
          MAX,
          ...authority(session),
        ),
      db
        .prepare(
          "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at) SELECT ?,'account','account',?,? WHERE EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='deleting' AND version=?) ON CONFLICT DO NOTHING",
        )
        .bind(
          marker.userId,
          marker.requestId,
          marker.deletedAt,
          marker.userId,
          request.version + 1,
        ),
      db
        .prepare(`DELETE FROM session WHERE userId=? AND ${requestGuard}`)
        .bind(marker.userId, marker.userId, marker.requestId),
      db
        .prepare(
          `UPDATE connections SET state='disconnected',scheduling_state='paused',next_sync_at=NULL,credential_ciphertext=NULL,credential_key_version=NULL,generation=generation+1,credential_version=credential_version+1 WHERE user_id=? AND ${requestGuard}`,
        )
        .bind(marker.userId, marker.userId, marker.requestId),
      db
        .prepare(
          `UPDATE ai_settings SET encrypted_key=NULL,key_version=NULL,status='deleted',generation=generation+1 WHERE user_id=? AND ${requestGuard}`,
        )
        .bind(marker.userId, marker.userId, marker.requestId),
      db
        .prepare(
          `UPDATE processing_consents SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND ${requestGuard}`,
        )
        .bind(marker.deletedAt, marker.userId, marker.userId, marker.requestId),
      db
        .prepare(
          `UPDATE jobs SET status='canceled',lease_id=NULL,lease_expires_at=NULL,fence=fence+1,outcome_code='account_deleted' WHERE user_id=? AND status NOT IN ('completed','terminal','canceled') AND ${requestGuard}`,
        )
        .bind(marker.userId, marker.userId, marker.requestId),
      db
        .prepare(
          `UPDATE sync_states SET stage='canceled' WHERE user_id=? AND ${requestGuard}`,
        )
        .bind(marker.userId, marker.userId, marker.requestId),
    ]);
    const saved = await db
      .prepare(
        "SELECT user_id,deleted_at,request_id FROM lifecycle_deletions WHERE user_id=? AND scope='account' AND request_id=?",
      )
      .bind(marker.userId, marker.requestId)
      .first();
    if (!saved) throw new LifecycleError("CONFLICT");
    return marker;
  }
  async function acknowledgeJournal(marker: DeletionMarker) {
    await db
      .prepare(
        "UPDATE lifecycle_deletions SET journal_ack=1 WHERE user_id=? AND scope='account' AND target_id='account' AND request_id=? AND deleted_at=? AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='deleting')",
      )
      .bind(marker.userId, marker.requestId, marker.deletedAt, marker.userId)
      .run();
  }
  async function disconnect(
    session: LifecycleSession,
    id: string,
    request: DisconnectRequest,
    key: string,
  ) {
    const result = {
      generation: request.generation + 1,
      recordsRetained: true as const,
      localCredentialsRemoved: true as const,
      remoteRevocation: "not_attempted" as const,
    };
    const route = `disconnect:${id}`;
    const normalizedRequest = {
      ...request,
      revokeProviderAccess: request.revokeProviderAccess ?? false,
    };
    const replay = await existing<typeof result>(
      session.tenant,
      route,
      key,
      normalizedRequest,
    );
    if (replay) return replay;
    const executor = crypto.randomUUID();
    const user = session.tenant.userId;
    const guard =
      "EXISTS(SELECT 1 FROM lifecycle_commands WHERE user_id=? AND route=? AND key=? AND executor=?)";
    const args = [user, route, key, executor];
    await db.batch([
      db
        .prepare(
          `INSERT INTO lifecycle_commands(user_id,route,key,body_hash,executor,result_json,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM connections WHERE user_id=? AND id=? AND kind='mailbox' AND state!='disconnected' AND generation=? AND credential_version=? AND generation<? AND credential_version<?) AND ${live} ON CONFLICT DO NOTHING`,
        )
        .bind(
          user,
          route,
          key,
          await hash(JSON.stringify(normalizedRequest)),
          executor,
          JSON.stringify(result),
          now(),
          user,
          id,
          request.generation,
          request.credentialVersion,
          MAX,
          MAX,
          ...authority(session),
        ),
      db
        .prepare(
          `UPDATE connections SET state='disconnected',scheduling_state='paused',next_sync_at=NULL,credential_ciphertext=NULL,credential_key_version=NULL,generation=generation+1,credential_version=credential_version+1 WHERE user_id=? AND id=? AND ${guard}`,
        )
        .bind(user, id, ...args),
      db
        .prepare(
          `UPDATE processing_consents SET revoked_at=? WHERE user_id=? AND connection_id=? AND revoked_at IS NULL AND ${guard}`,
        )
        .bind(now(), user, id, ...args),
      db
        .prepare(
          `UPDATE jobs SET status='canceled',lease_id=NULL,lease_expires_at=NULL,fence=fence+1,outcome_code='mailbox_disconnected' WHERE user_id=? AND connection_id=? AND status NOT IN ('completed','terminal','canceled') AND ${guard}`,
        )
        .bind(user, id, ...args),
      db
        .prepare(
          `UPDATE sync_states SET stage='canceled' WHERE user_id=? AND connection_id=? AND ${guard}`,
        )
        .bind(user, id, ...args),
      db
        .prepare(
          `DELETE FROM mailbox_refresh_leases WHERE user_id=? AND connection_id=? AND ${guard}`,
        )
        .bind(user, id, ...args),
      db
        .prepare(
          `DELETE FROM mailbox_oauth_intents WHERE user_id=? AND connection_id=? AND ${guard}`,
        )
        .bind(user, id, ...args),
    ]);
    if (!(await commandGuard(user, route, key, executor).first())) {
      const replayed = await existing<typeof result>(
        session.tenant,
        route,
        key,
        normalizedRequest,
      );
      if (replayed) return replayed;
      throw new LifecycleError("CONFLICT");
    }
    return result;
  }
  async function preview(tenant: TenantContext, id: string) {
    return projectPreview(await previewSnapshot(db, tenant, id));
  }
  async function deleteData(
    session: LifecycleSession,
    id: string,
    request: DeleteDataRequest,
    key: string,
  ) {
    const route = `delete-data:${id}`;
    const user = session.tenant.userId;
    const result = {
      status: "cleanup_pending" as const,
      driveFilesDeleted: false as const,
    };
    const replay = await existing<typeof result>(
      session.tenant,
      route,
      key,
      request,
    );
    if (replay) return replay;
    const snapshot = await previewSnapshot(db, session.tenant, id);
    const projection = await projectPreview(snapshot);
    if (
      projection.generation !== request.generation ||
      projection.fingerprint !== request.previewFingerprint
    )
      throw new LifecycleError("CONFLICT");
    const executor = crypto.randomUUID();
    const args = [user, route, key, executor];
    const guard =
      "EXISTS(SELECT 1 FROM lifecycle_commands WHERE user_id=? AND route=? AND key=? AND executor=?)";
    await db.batch([
      db
        .prepare(
          `INSERT INTO lifecycle_commands(user_id,route,key,body_hash,executor,result_json,created_at) SELECT ?,?,?,?,?,?,? WHERE (${previewSql()})=? AND ${live} AND NOT EXISTS(SELECT 1 FROM lifecycle_deletions WHERE user_id=? AND scope='connection' AND target_id=?) ON CONFLICT DO NOTHING`,
        )
        .bind(
          user,
          route,
          key,
          await hash(JSON.stringify(request)),
          executor,
          JSON.stringify(result),
          now(),
          ...previewArguments(user, id),
          snapshot,
          ...authority(session),
          user,
          id,
        ),
      db
        .prepare(
          `UPDATE connections SET state='disconnected',scheduling_state='paused',next_sync_at=NULL,credential_ciphertext=NULL,credential_key_version=NULL,generation=generation+1,credential_version=credential_version+1 WHERE user_id=? AND id=? AND ${guard}`,
        )
        .bind(user, id, ...args),
      db
        .prepare(
          `UPDATE processing_consents SET revoked_at=? WHERE user_id=? AND connection_id=? AND revoked_at IS NULL AND ${guard}`,
        )
        .bind(now(), user, id, ...args),
      db
        .prepare(
          `UPDATE jobs SET status='canceled',lease_id=NULL,lease_expires_at=NULL,fence=fence+1,outcome_code='source_data_deleted' WHERE user_id=? AND connection_id=? AND status NOT IN ('completed','terminal','canceled') AND ${guard}`,
        )
        .bind(user, id, ...args),
      db
        .prepare(
          `UPDATE sync_states SET stage='canceled' WHERE user_id=? AND connection_id=? AND ${guard}`,
        )
        .bind(user, id, ...args),
      db
        .prepare(
          `INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,journal_ack) SELECT ?,'connection',?,?,?,1 WHERE ${guard}`,
        )
        .bind(user, id, key, now(), ...args),
    ]);
    if (!(await commandGuard(user, route, key, executor).first()))
      throw new LifecycleError("CONFLICT");
    return result;
  }
  return {
    authorizeDeletion,
    beginDeletion,
    acknowledgeJournal,
    disconnect,
    preview,
    deleteData,
  };
}
