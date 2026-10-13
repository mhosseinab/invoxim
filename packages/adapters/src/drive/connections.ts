import {
  storageConnectionsResponseSchema,
  storageConnectionViewSchema,
  storageDisconnectRequestSchema,
  storageStartRequestSchema,
} from "@invoxim/contracts";
import {
  ArchiveServiceError,
  type ArchiveSession,
  MailboxError,
  requireRecentMailboxSession,
  type TenantContext,
} from "@invoxim/core";

export interface ConnectionRow {
  id: string;
  provider_subject: string;
  display_address: string;
  state: "connected" | "needs_reconnect" | "disconnected";
  generation: number;
  credential_version: number;
  credential_key_version: number | null;
  credential_ciphertext: string | null;
  archiving_enabled?: number;
}
export const MAX = Number.MAX_SAFE_INTEGER;
export const ARCHIVE_MAX = 2147483646;
export const fields =
  "id,provider_subject,display_address,state,generation,credential_version,credential_key_version,credential_ciphertext";
export const liveSession =
  "EXISTS(SELECT 1 FROM session WHERE id=? AND userId=? AND expiresAt>? AND createdAt<=? AND createdAt>=?)";
export const activeProfile =
  "EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')";
export function project(
  row: ConnectionRow,
  enabled = row.archiving_enabled === 1,
) {
  const configured =
    row.state === "connected" && row.credential_ciphertext !== null;
  return storageConnectionViewSchema.parse({
    id: row.id,
    provider: "google-drive",
    kind: "storage",
    address: row.display_address,
    state: row.state,
    generation: row.generation,
    credentialVersion: row.credential_version,
    configured,
    archivingEnabled: configured && enabled,
  });
}
export function sessionBindings(session: ArchiveSession, now = Date.now()) {
  return [session.sessionId, session.tenant.userId, now, now, now - 3600000];
}
export async function requireLiveDriveSession(
  db: D1Database,
  session: ArchiveSession,
) {
  const now = Date.now();
  requireRecentMailboxSession(session, now);
  const current = await db
    .prepare(
      `SELECT createdAt,expiresAt FROM session WHERE id=? AND userId=? AND ${activeProfile}`,
    )
    .bind(session.sessionId, session.tenant.userId, session.tenant.userId)
    .first<{ createdAt: number; expiresAt: number }>();
  if (!current || current.expiresAt <= now)
    throw new ArchiveServiceError("UNAUTHENTICATED");
  if (
    !Number.isSafeInteger(current.createdAt) ||
    current.createdAt > now ||
    now - current.createdAt > 3600000
  )
    throw new ArchiveServiceError("RECENT_AUTH_REQUIRED");
}
export async function readDriveConnection(
  db: D1Database,
  context: TenantContext,
  id: string,
) {
  return db
    .prepare(
      `SELECT ${fields} FROM connections WHERE user_id=? AND id=? AND kind='storage' AND provider='google-drive' AND ${activeProfile}`,
    )
    .bind(context.userId, id, context.userId)
    .first<ConnectionRow>();
}
async function boundary<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ArchiveServiceError) throw error;
    if (
      error instanceof MailboxError &&
      (error.code === "UNAUTHENTICATED" ||
        error.code === "RECENT_AUTH_REQUIRED")
    )
      throw new ArchiveServiceError(error.code);
    throw new ArchiveServiceError("UNAVAILABLE");
  }
}
/** Local metadata and unlink remain available without an OAuth client or credential cipher. */
export function createDriveConnectionsRepository(db: D1Database) {
  const live = (session: ArchiveSession) =>
    requireLiveDriveSession(db, session);
  const row = (context: TenantContext, id: string) =>
    readDriveConnection(db, context, id);
  function checkId(id: string) {
    if (!storageStartRequestSchema.safeParse({ connectionId: id }).success)
      throw new ArchiveServiceError("INVALID_INPUT");
  }
  async function list(context: TenantContext) {
    const result = await db
      .prepare(
        `SELECT ${fields},EXISTS(SELECT 1 FROM archive_settings a WHERE a.user_id=connections.user_id AND a.enabled=1 AND a.connection_id=connections.id AND a.connection_generation=connections.generation) AS archiving_enabled FROM connections WHERE user_id=? AND kind='storage' AND provider='google-drive' AND ${activeProfile} ORDER BY CASE state WHEN 'disconnected' THEN 1 ELSE 0 END,id LIMIT 11`,
      )
      .bind(context.userId, context.userId)
      .all<ConnectionRow>();
    return storageConnectionsResponseSchema.parse({
      connections: result.results.slice(0, 10).map((value) => project(value)),
      hasMore: result.results.length > 10,
    });
  }
  async function disconnect(
    session: ArchiveSession,
    id: string,
    expected: { generation: number; credentialVersion: number },
  ) {
    checkId(id);
    if (!storageDisconnectRequestSchema.safeParse(expected).success)
      throw new ArchiveServiceError("INVALID_INPUT");
    await live(session);
    const existing = await row(session.tenant, id);
    if (!existing) throw new ArchiveServiceError("NOT_FOUND");
    if (
      existing.state === "disconnected" &&
      existing.generation === expected.generation + 1 &&
      existing.credential_version === expected.credentialVersion + 1
    )
      return;
    if (
      existing.generation !== expected.generation ||
      existing.credential_version !== expected.credentialVersion ||
      existing.generation >= MAX ||
      existing.credential_version >= MAX
    )
      throw new ArchiveServiceError("CONFLICT");
    const mutation = db
      .prepare(
        `UPDATE connections SET state='disconnected',scheduling_state='paused',next_sync_at=NULL,credential_ciphertext=NULL,credential_key_version=NULL,generation=generation+1,credential_version=credential_version+1 WHERE user_id=? AND id=? AND kind='storage' AND provider='google-drive' AND generation=? AND credential_version=? AND state!='disconnected' AND generation<? AND credential_version<? AND ${liveSession} AND ${activeProfile} AND NOT EXISTS(SELECT 1 FROM archive_settings a WHERE a.user_id=connections.user_id AND a.enabled=1 AND a.connection_id=connections.id AND a.version>=?) RETURNING id`,
      )
      .bind(
        session.tenant.userId,
        id,
        expected.generation,
        expected.credentialVersion,
        MAX,
        MAX,
        ...sessionBindings(session),
        session.tenant.userId,
        ARCHIVE_MAX,
      );
    const clearSettings = db
      .prepare(
        "UPDATE archive_settings SET enabled=0,version=version+1,connection_id=NULL,connection_generation=NULL,disclosure_version=NULL,accepted_at=NULL WHERE user_id=? AND enabled=1 AND connection_id=? AND version<? AND EXISTS(SELECT 1 FROM connections WHERE user_id=? AND id=? AND kind='storage' AND provider='google-drive' AND state='disconnected' AND generation=? AND credential_version=? AND credential_ciphertext IS NULL)",
      )
      .bind(
        session.tenant.userId,
        id,
        ARCHIVE_MAX,
        session.tenant.userId,
        id,
        expected.generation + 1,
        expected.credentialVersion + 1,
      );
    const changed = await db.batch([mutation, clearSettings]);
    if (changed[0]?.results.length !== 1)
      throw new ArchiveServiceError("CONFLICT");
    await live(session);
  }
  return {
    list: (context: TenantContext) => boundary(() => list(context)),
    disconnect: (
      session: ArchiveSession,
      id: string,
      expected: { generation: number; credentialVersion: number },
    ) => boundary(() => disconnect(session, id, expected)),
  };
}
