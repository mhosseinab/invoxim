import { hasControlCharacters } from "@invoxim/contracts";
import {
  ArchiveServiceError,
  type ArchiveSession,
  type TenantContext,
} from "@invoxim/core";
import { z } from "zod";
import type {
  ArchiveBackfillLease,
  ArchiveBackfillPage,
  ArchiveBackfillStore,
  ArchiveBackfillView,
} from "../../../core/src/archive/backfill-types";
import { archiveMailboxPermissionSql } from "./dispatch-store";
import { archiveObjectEligibilitySql } from "./objects";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !hasControlCharacters(value));
const integer = z.number().int().safe().nonnegative();
const version = integer.min(1).max(2147483646);
const selectionSchema = z.strictObject({
  connectionId: identifier,
  generation: integer.min(1),
  settingsVersion: version,
});
const recentMs = 3600000;
const sessionSql = `EXISTS(SELECT 1 FROM session se JOIN profiles p ON p.user_id=se.userId WHERE se.id=? AND se.userId=? AND se.expiresAt>? AND typeof(se.createdAt)='integer' AND se.createdAt<=? AND se.createdAt>=? AND p.status='active')`;
const driveScope = `json_type(CASE WHEN json_valid(c.scopes) THEN c.scopes ELSE '[]' END)='array' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(c.scopes) THEN c.scopes ELSE '[]' END) permission WHERE permission.type='text' AND permission.value='https://www.googleapis.com/auth/drive.file')`;
const runAuthority = `EXISTS(SELECT 1 FROM profiles p JOIN archive_settings a ON a.user_id=p.user_id JOIN connections c ON c.user_id=a.user_id AND c.id=a.connection_id WHERE (p.user_id=archive_backfill_runs.user_id AND p.status='active') AND (a.enabled=1 AND a.version=archive_backfill_runs.settings_version AND a.disclosure_version=1 AND a.connection_id=archive_backfill_runs.connection_id AND a.connection_generation=archive_backfill_runs.storage_generation) AND (c.kind='storage' AND c.provider='google-drive' AND c.state='connected' AND c.generation=archive_backfill_runs.storage_generation AND c.provider_subject=archive_backfill_runs.storage_subject AND c.credential_ciphertext IS NOT NULL AND c.credential_key_version>0 AND ${driveScope}))`;
const mailScope = `length(m.scopes)<=4096 AND json_type(CASE WHEN json_valid(m.scopes) THEN m.scopes ELSE '[]' END)='array' AND json_array_length(CASE WHEN json_valid(m.scopes) THEN m.scopes ELSE '[]' END)<=16 AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(m.scopes) THEN m.scopes ELSE '[]' END) permission WHERE permission.type='text' AND ((m.provider='gmail' AND permission.value='https://www.googleapis.com/auth/gmail.readonly') OR (m.provider='outlook' AND permission.value='https://graph.microsoft.com/Mail.Read')))`;
const objectEligible = `${archiveObjectEligibilitySql()} AND ${archiveMailboxPermissionSql}`;
interface RunRow {
  id: string;
  connection_id: string;
  storage_generation: number;
  storage_subject: string;
  settings_version: number;
  snapshot_count: number;
  cursor_ordinal: number;
  has_more: number;
  state: string;
  revision: number;
  lease_id: string | null;
  lease_expires_at: number;
  fence: number;
}
function view(row: RunRow): ArchiveBackfillView {
  const parsed = z
    .strictObject({
      id: identifier,
      connectionId: identifier,
      generation: integer.min(1),
      settingsVersion: version,
      snapshotCount: integer.max(100),
      cursorOrdinal: integer.max(100),
      hasMore: z.boolean(),
      state: z.enum(["pending", "admission_complete", "canceled"]),
      revision: version,
    })
    .safeParse({
      id: row.id,
      connectionId: row.connection_id,
      generation: row.storage_generation,
      settingsVersion: row.settings_version,
      snapshotCount: row.snapshot_count,
      cursorOrdinal: row.cursor_ordinal,
      hasMore: row.has_more === 1,
      state: row.state,
      revision: row.revision,
    });
  if (!parsed.success) throw new ArchiveServiceError("UNAVAILABLE");
  return parsed.data;
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ArchiveServiceError) throw error;
    throw new ArchiveServiceError("UNAVAILABLE");
  }
}
/** Explicit frozen metadata membership; no provider, inference or financial access. */
export function createArchiveBackfillStore(
  db: D1Database,
  options: { clock?: () => number } = {},
): ArchiveBackfillStore {
  const clock = options.clock ?? Date.now;
  function now() {
    const time = clock();
    if (!integer.max(Number.MAX_SAFE_INTEGER - 60000).safeParse(time).success)
      throw new ArchiveServiceError("UNAVAILABLE");
    return time;
  }
  function sessionArgs(session: ArchiveSession, time: number) {
    return [
      session.sessionId,
      session.tenant.userId,
      time,
      time,
      Math.max(0, time - recentMs),
    ];
  }
  async function live(session: ArchiveSession) {
    if (session.tenant.authority !== "session")
      throw new ArchiveServiceError("UNAUTHENTICATED");
    const time = now();
    const row = await db
      .prepare(
        "SELECT se.createdAt FROM session se JOIN profiles p ON p.user_id=se.userId WHERE se.id=? AND se.userId=? AND se.expiresAt>? AND p.status='active'",
      )
      .bind(session.sessionId, session.tenant.userId, time)
      .first<{ createdAt: number }>();
    if (!row) throw new ArchiveServiceError("UNAUTHENTICATED");
    if (
      !integer.safeParse(row.createdAt).success ||
      row.createdAt > time ||
      row.createdAt < Math.max(0, time - recentMs)
    )
      throw new ArchiveServiceError("RECENT_AUTH_REQUIRED");
  }
  async function read(
    context: TenantContext,
    runId: string,
  ): Promise<ArchiveBackfillView> {
    if (!identifier.safeParse(runId).success)
      throw new ArchiveServiceError("INVALID_INPUT");
    const row = await db
      .prepare(
        "SELECT r.* FROM archive_backfill_runs r JOIN profiles p ON p.user_id=r.user_id WHERE r.user_id=? AND r.id=? AND p.status='active'",
      )
      .bind(context.userId, runId)
      .first<RunRow>();
    if (!row) throw new ArchiveServiceError("NOT_FOUND");
    return view(row);
  }
  async function start(...args: Parameters<ArchiveBackfillStore["start"]>) {
    const [session, selection] = args;
    if (!selectionSchema.safeParse(selection).success)
      throw new ArchiveServiceError("INVALID_INPUT");
    await live(session);
    const time = now(),
      id = crypto.randomUUID(),
      user = session.tenant.userId;
    await db.batch([
      db
        .prepare(
          `INSERT INTO archive_backfill_runs(user_id,id,connection_id,storage_generation,storage_subject,settings_version,created_at,snapshot_count,has_more)
        SELECT ?,?,c.id,c.generation,c.provider_subject,a.version,?,0,EXISTS(SELECT 1 FROM documents WHERE user_id=? ORDER BY id LIMIT 1 OFFSET 100)
        FROM archive_settings a JOIN connections c ON c.user_id=a.user_id AND c.id=a.connection_id WHERE (a.user_id=? AND a.enabled=1 AND a.version=? AND a.disclosure_version=1 AND a.connection_generation=c.generation) AND (c.id=? AND c.generation=? AND c.kind='storage' AND c.provider='google-drive' AND c.state='connected' AND c.credential_ciphertext IS NOT NULL AND c.credential_key_version>0 AND ${driveScope}) AND ${sessionSql}
        AND NOT EXISTS(SELECT 1 FROM archive_backfill_runs WHERE user_id=? AND state='pending')`,
        )
        .bind(
          user,
          id,
          time,
          user,
          user,
          selection.settingsVersion,
          selection.connectionId,
          selection.generation,
          ...sessionArgs(session, time),
          user,
        ),
      db
        .prepare(
          `INSERT INTO archive_backfill_items(user_id,run_id,ordinal,document_id) SELECT ?,?,row_number() OVER(ORDER BY id),id FROM (SELECT id FROM documents WHERE user_id=? ORDER BY id LIMIT 100) WHERE EXISTS(SELECT 1 FROM archive_backfill_runs WHERE user_id=? AND id=? AND state='pending' AND revision=1)`,
        )
        .bind(user, id, user, user, id),
      db
        .prepare(
          "UPDATE archive_backfill_runs SET snapshot_count=(SELECT count(*) FROM archive_backfill_items i WHERE i.user_id=archive_backfill_runs.user_id AND i.run_id=archive_backfill_runs.id),state=CASE WHEN EXISTS(SELECT 1 FROM archive_backfill_items i WHERE i.user_id=archive_backfill_runs.user_id AND i.run_id=archive_backfill_runs.id) THEN 'pending' ELSE 'admission_complete' END WHERE user_id=? AND id=? AND revision=1",
        )
        .bind(user, id),
    ]);
    await live(session);
    try {
      return await read(session.tenant, id);
    } catch (error) {
      if (error instanceof ArchiveServiceError && error.code === "NOT_FOUND")
        throw new ArchiveServiceError("CONFLICT");
      throw error;
    }
  }
  async function claim(
    context: TenantContext,
    runId: string,
  ): Promise<ArchiveBackfillLease | null> {
    if (!identifier.safeParse(runId).success)
      throw new ArchiveServiceError("INVALID_INPUT");
    const time = now(),
      leaseId = crypto.randomUUID();
    const row = await db
      .prepare(
        `UPDATE archive_backfill_runs SET lease_id=?,lease_expires_at=?,fence=fence+1 WHERE user_id=? AND id=? AND state='pending' AND lease_expires_at<=? AND fence<9007199254740991 AND revision<2147483646 AND ${runAuthority} RETURNING *`,
      )
      .bind(leaseId, time + 60000, context.userId, runId, time)
      .first<RunRow>();
    return row
      ? {
          context,
          runId,
          leaseId,
          fence: row.fence,
          expiresAt: row.lease_expires_at,
          revision: row.revision,
          cursorOrdinal: row.cursor_ordinal,
        }
      : null;
  }
  async function cancel(
    session: ArchiveSession,
    runId: string,
    revision: number,
  ) {
    if (
      !identifier.safeParse(runId).success ||
      !version.max(2147483645).safeParse(revision).success
    )
      throw new ArchiveServiceError("INVALID_INPUT");
    await live(session);
    await read(session.tenant, runId);
    const user = session.tenant.userId,
      time = now();
    const gate = `EXISTS(SELECT 1 FROM archive_backfill_runs WHERE user_id=? AND id=? AND revision=? AND state IN ('pending','admission_complete') AND fence<9007199254740991) AND ${sessionSql}
      AND NOT EXISTS(SELECT 1 FROM archive_dispatch q JOIN archive_objects o ON o.user_id=q.user_id AND o.id=q.object_id WHERE q.user_id=? AND q.backfill_run_id=? AND o.state='pending' AND (o.fence>=9007199254740991 OR q.dispatch_fence>=9007199254740991))`;
    const values = [
      user,
      runId,
      revision,
      ...sessionArgs(session, time),
      user,
      runId,
    ];
    try {
      await db.batch([
        db
          .prepare(
            `SELECT json(CASE WHEN ${gate} THEN 'true' ELSE 'denied' END) AS authorized`,
          )
          .bind(...values),
        db
          .prepare(
            "UPDATE archive_objects SET lease_id=NULL,lease_expires_at=0,fence=fence+1 WHERE user_id=? AND state='pending' AND EXISTS(SELECT 1 FROM archive_dispatch q WHERE q.user_id=archive_objects.user_id AND q.object_id=archive_objects.id AND q.backfill_run_id=?)",
          )
          .bind(user, runId),
        db
          .prepare(
            "UPDATE archive_dispatch SET status='canceled',outcome_code='canceled',dispatched_at=NULL,dispatch_fence=dispatch_fence+1 WHERE user_id=? AND backfill_run_id=? AND EXISTS(SELECT 1 FROM archive_objects o WHERE o.user_id=archive_dispatch.user_id AND o.id=archive_dispatch.object_id AND o.state='pending')",
          )
          .bind(user, runId),
        db
          .prepare(
            "UPDATE archive_backfill_runs SET state='canceled',revision=revision+1,fence=fence+1,lease_id=NULL,lease_expires_at=0 WHERE user_id=? AND id=? AND revision=?",
          )
          .bind(user, runId, revision),
      ]);
    } catch {
      await live(session);
      throw new ArchiveServiceError("CONFLICT");
    }
    return read(session.tenant, runId);
  }
  async function admitPage(
    lease: ArchiveBackfillLease,
  ): Promise<ArchiveBackfillPage> {
    if (
      !identifier.safeParse(lease.runId).success ||
      !identifier.safeParse(lease.leaseId).success ||
      !integer.min(1).safeParse(lease.fence).success ||
      !integer.min(1).safeParse(lease.expiresAt).success ||
      !version.max(2147483645).safeParse(lease.revision).success ||
      !integer.max(100).safeParse(lease.cursorOrdinal).success
    )
      throw new ArchiveServiceError("INVALID_INPUT");
    const gate = `(user_id=? AND id=? AND state='pending') AND (lease_id=? AND fence=? AND lease_expires_at=? AND lease_expires_at>?) AND (revision=? AND cursor_ordinal=? AND revision<2147483646) AND ${runAuthority}`;
    const gateArgs = (time: number) => [
      lease.context.userId,
      lease.runId,
      lease.leaseId,
      lease.fence,
      lease.expiresAt,
      time,
      lease.revision,
      lease.cursorOrdinal,
    ];
    const run = await db
      .prepare(`SELECT * FROM archive_backfill_runs WHERE ${gate}`)
      .bind(...gateArgs(now()))
      .first<RunRow>();
    if (!run) throw new ArchiveServiceError("CONFLICT");
    const members = await db
      .prepare(
        `SELECT i.ordinal,i.document_id,o.id AS previous_object_id,o.fence AS previous_object_fence,o.settings_version AS previous_settings_version,o.storage_generation AS previous_storage_generation,q.dispatch_fence AS previous_dispatch_fence,q.status AS previous_dispatch_status
        FROM (SELECT ordinal,document_id FROM archive_backfill_items WHERE user_id=? AND run_id=? AND ordinal>? ORDER BY ordinal LIMIT 5) i
        LEFT JOIN archive_objects o ON o.user_id=? AND o.document_id=i.document_id AND o.storage_connection_id=?
        LEFT JOIN archive_dispatch q ON q.user_id=o.user_id AND q.object_id=o.id ORDER BY i.ordinal`,
      )
      .bind(
        lease.context.userId,
        lease.runId,
        lease.cursorOrdinal,
        lease.context.userId,
        run.connection_id,
      )
      .all<{
        ordinal: number;
        document_id: string;
        previous_object_id: string | null;
        previous_object_fence: number | null;
        previous_settings_version: number | null;
        previous_storage_generation: number | null;
        previous_dispatch_fence: number | null;
        previous_dispatch_status: string | null;
      }>();
    const page = members.results.map((item) => ({
      ...item,
      objectId: crypto.randomUUID(),
      queueId: crypto.randomUUID(),
    }));
    const last = page.at(-1);
    const cursor = last?.ordinal ?? run.snapshot_count;
    const done = cursor >= run.snapshot_count;
    const payload = JSON.stringify(page),
      user = lease.context.userId,
      time = now();
    const membersSql = `json_each(?) page JOIN archive_backfill_items i ON i.user_id=? AND i.run_id=? AND i.ordinal=json_extract(page.value,'$.ordinal') AND i.document_id=json_extract(page.value,'$.document_id')`;
    const memberArgs = [payload, user, lease.runId];
    // Compare the bounded pre-batch snapshot before changing either object or delivery authority.
    const pageGuard = `NOT EXISTS(SELECT 1 FROM json_each(?) page
      LEFT JOIN archive_objects o ON o.user_id=? AND o.document_id=json_extract(page.value,'$.document_id') AND o.storage_connection_id=?
      LEFT JOIN archive_dispatch q ON q.user_id=o.user_id AND q.object_id=o.id
      WHERE NOT (o.id IS json_extract(page.value,'$.previous_object_id') AND o.fence IS json_extract(page.value,'$.previous_object_fence')
      AND o.settings_version IS json_extract(page.value,'$.previous_settings_version') AND o.storage_generation IS json_extract(page.value,'$.previous_storage_generation')
      AND q.dispatch_fence IS json_extract(page.value,'$.previous_dispatch_fence') AND q.status IS json_extract(page.value,'$.previous_dispatch_status')))`;
    // The sentinel deliberately aborts the entire native batch when the current lease/consent changed.
    let results: D1Result<{ admitted?: number; authorized?: string }>[];
    try {
      results = await db.batch<{ admitted?: number; authorized?: string }>([
        db
          .prepare(
            `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM archive_backfill_runs WHERE ${gate}) AND ${pageGuard} THEN 'true' ELSE 'denied' END) AS authorized`,
          )
          .bind(...gateArgs(time), payload, user, run.connection_id),
        db
          .prepare(
            `INSERT INTO archive_objects(id,user_id,document_id,source_message_id,provider_message_id,part_key,document_hash,document_mime,document_size,mailbox_connection_id,mailbox_generation,storage_connection_id,storage_generation,storage_subject,settings_version)
        SELECT json_extract(page.value,'$.objectId'),d.user_id,d.id,s.id,s.provider_message_id,d.part_key,d.content_hash,d.mime,d.byte_length,m.id,m.generation,c.id,c.generation,c.provider_subject,a.version
        FROM ${membersSql} JOIN archive_backfill_runs r ON r.user_id=i.user_id AND r.id=i.run_id JOIN documents d ON d.user_id=i.user_id AND d.id=i.document_id
        JOIN profiles p ON p.user_id=d.user_id JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id
        JOIN connections m ON m.user_id=s.user_id AND m.id=s.connection_id JOIN archive_settings a ON a.user_id=d.user_id JOIN connections c ON c.user_id=a.user_id AND c.id=a.connection_id
        WHERE (p.status='active' AND s.available=1 AND s.generation=m.generation AND m.kind='mailbox' AND m.state='connected' AND m.credential_ciphertext IS NOT NULL AND m.credential_key_version>0 AND ${mailScope})
        AND (a.enabled=1 AND a.disclosure_version=1 AND a.version=r.settings_version AND a.connection_id=r.connection_id AND a.connection_generation=r.storage_generation)
        AND (c.kind='storage' AND c.provider='google-drive' AND c.state='connected' AND c.generation=r.storage_generation AND c.provider_subject=r.storage_subject AND c.credential_ciphertext IS NOT NULL AND c.credential_key_version>0 AND ${driveScope})
        ON CONFLICT(user_id,document_id,storage_connection_id) DO UPDATE SET settings_version=excluded.settings_version,storage_generation=excluded.storage_generation,lease_id=NULL,lease_expires_at=0,fence=archive_objects.fence+1
        WHERE (archive_objects.state='pending' AND archive_objects.fence<9007199254740991 AND (archive_objects.settings_version<>excluded.settings_version OR archive_objects.storage_generation<>excluded.storage_generation))
        AND (archive_objects.storage_subject=excluded.storage_subject AND archive_objects.mailbox_connection_id=excluded.mailbox_connection_id AND archive_objects.mailbox_generation=excluded.mailbox_generation)
        AND (archive_objects.source_message_id=excluded.source_message_id AND archive_objects.provider_message_id=excluded.provider_message_id AND archive_objects.part_key=excluded.part_key AND archive_objects.document_hash=excluded.document_hash AND archive_objects.document_mime=excluded.document_mime AND archive_objects.document_size=excluded.document_size)
        AND NOT EXISTS(SELECT 1 FROM archive_dispatch q WHERE q.user_id=archive_objects.user_id AND q.object_id=archive_objects.id AND q.dispatch_fence>=9007199254740991)`,
          )
          .bind(...memberArgs),
        db
          .prepare(
            `INSERT INTO archive_dispatch(user_id,object_id,queue_id,status,dispatch_at,backfill_run_id)
        SELECT archive_objects.user_id,archive_objects.id,json_extract(page.value,'$.queueId'),'ready',?,? FROM ${membersSql}
        JOIN archive_objects ON archive_objects.user_id=i.user_id AND archive_objects.document_id=i.document_id AND archive_objects.storage_connection_id=?
        WHERE archive_objects.state='pending' AND ${objectEligible}
        ON CONFLICT(user_id,object_id) DO UPDATE SET status='ready',dispatch_at=excluded.dispatch_at,dispatched_at=NULL,dispatch_fence=archive_dispatch.dispatch_fence+1,failure_count=0,outcome_code=NULL,backfill_run_id=excluded.backfill_run_id
        WHERE archive_dispatch.dispatch_fence<9007199254740991 AND (archive_dispatch.status IN ('paused','canceled') OR
        (archive_dispatch.status IN ('ready','retry_wait') AND EXISTS(SELECT 1 FROM json_each(?) previous JOIN archive_objects restored ON restored.user_id=archive_dispatch.user_id AND restored.id=archive_dispatch.object_id
        WHERE restored.id=json_extract(previous.value,'$.previous_object_id') AND restored.fence=json_extract(previous.value,'$.previous_object_fence')+1
        AND (restored.settings_version<>json_extract(previous.value,'$.previous_settings_version') OR restored.storage_generation<>json_extract(previous.value,'$.previous_storage_generation')))))`,
          )
          .bind(time, lease.runId, ...memberArgs, run.connection_id, payload),
        db
          .prepare(
            `UPDATE archive_backfill_runs SET cursor_ordinal=?,state=?,revision=revision+1,lease_id=NULL,lease_expires_at=0 WHERE ${gate}`,
          )
          .bind(
            cursor,
            done ? "admission_complete" : "pending",
            ...gateArgs(time),
          ),
        db
          .prepare(
            `SELECT count(*) AS admitted FROM archive_dispatch q JOIN archive_objects o ON o.user_id=q.user_id AND o.id=q.object_id JOIN archive_backfill_items i ON i.user_id=o.user_id AND i.document_id=o.document_id AND i.run_id=q.backfill_run_id WHERE q.user_id=? AND q.backfill_run_id=? AND i.ordinal>? AND i.ordinal<=?`,
          )
          .bind(user, lease.runId, lease.cursorOrdinal, cursor),
      ]);
    } catch (error) {
      const unchanged = await db
        .prepare(
          `SELECT 1 AS allowed FROM archive_backfill_runs WHERE ${gate} AND ${pageGuard}`,
        )
        .bind(...gateArgs(now()), payload, user, run.connection_id)
        .first();
      if (!unchanged) throw new ArchiveServiceError("CONFLICT");
      throw error;
    }
    const admitted = results.at(-1)?.results[0];
    if (
      !admitted ||
      typeof admitted.admitted !== "number" ||
      !integer.max(page.length).safeParse(admitted.admitted).success
    )
      throw new ArchiveServiceError("UNAVAILABLE");
    return {
      admitted: admitted.admitted,
      skipped: page.length - admitted.admitted,
      cursorOrdinal: cursor,
      done,
    };
  }
  return {
    start: (...args) => safe(() => start(...args)),
    read: (...args) => safe(() => read(...args)),
    claim: (...args) => safe(() => claim(...args)),
    cancel: (...args) => safe(() => cancel(...args)),
    admitPage: (...args) => safe(() => admitPage(...args)),
  };
}
