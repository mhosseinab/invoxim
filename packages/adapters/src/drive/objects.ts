import { hasControlCharacters } from "@invoxim/contracts";
import {
  type ArchiveObjectLease,
  type ArchiveObjectRequest,
  type ArchiveObjectStore,
  type ArchiveObjectWork,
  ArchiveServiceError,
  type ArchiveUploadPlan,
  type TenantContext,
} from "@invoxim/core";
import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !hasControlCharacters(value));
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const requestSchema = z.strictObject({
  documentId: identifier,
  storageConnectionId: identifier,
  settingsVersion: integer.min(1).max(2147483646),
});
const leaseSchema = z.strictObject({
  id: identifier,
  leaseId: identifier,
  fence: integer.min(1),
  expiresAt: integer.min(1),
});
const planSchema = z.strictObject({
  fileId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  parentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  workspaceMarker: z.string().regex(/^[A-Za-z0-9_-]{16,96}$/),
  mimeType: z.enum([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "message/rfc822",
  ]),
  size: integer.min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
// This correlated predicate is repeated on every lease/plan/commit mutation.
// Reconnecting to the same displayed address cannot revive an older authorization.
const current = `EXISTS(
 SELECT 1 FROM profiles p
 JOIN documents d ON d.user_id=p.user_id AND d.id=archive_objects.document_id
 JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id
 JOIN connections m ON m.user_id=s.user_id AND m.id=s.connection_id
 JOIN connections c ON c.user_id=p.user_id AND c.id=archive_objects.storage_connection_id
 JOIN archive_settings a ON a.user_id=p.user_id
 WHERE p.user_id=archive_objects.user_id AND p.status='active'
 AND d.source_message_id=archive_objects.source_message_id AND d.part_key=archive_objects.part_key
 AND d.content_hash=archive_objects.document_hash AND d.mime=archive_objects.document_mime AND d.byte_length=archive_objects.document_size
 AND s.available=1 AND s.provider_message_id=archive_objects.provider_message_id AND s.generation=archive_objects.mailbox_generation
 AND m.id=archive_objects.mailbox_connection_id AND m.generation=archive_objects.mailbox_generation
 AND m.kind='mailbox' AND m.state='connected' AND m.credential_ciphertext IS NOT NULL AND m.credential_key_version>0
 AND c.kind='storage' AND c.provider='google-drive' AND c.state='connected'
 AND c.generation=archive_objects.storage_generation AND c.provider_subject=archive_objects.storage_subject
 AND c.credential_ciphertext IS NOT NULL AND c.credential_key_version>0
 AND json_type(CASE WHEN json_valid(c.scopes) THEN c.scopes ELSE '[]' END)='array'
 AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(c.scopes) THEN c.scopes ELSE '[]' END) permission WHERE permission.type='text' AND permission.value='https://www.googleapis.com/auth/drive.file')
 AND a.enabled=1 AND a.version=archive_objects.settings_version AND a.connection_id=c.id AND a.connection_generation=c.generation AND a.disclosure_version=1
)`;
const leaseGuard = `user_id=? AND id=? AND state='pending' AND lease_id=? AND fence=? AND lease_expires_at=? AND lease_expires_at>? AND ${current}`;
interface WorkRow {
  id: string;
  document_id: string;
  source_message_id: string;
  provider_message_id: string;
  part_key: string;
  mailbox_connection_id: string;
  mailbox_generation: number;
  storage_connection_id: string;
  storage_generation: number;
  storage_subject: string;
  settings_version: number;
  lease_id: string;
  fence: number;
  lease_expires_at: number;
  planned_file_id: string | null;
  parent_id: string | null;
  workspace_marker: string | null;
  original_mime: string | null;
  original_size: number | null;
  original_sha256: string | null;
}
function work(row: WorkRow): ArchiveObjectWork {
  const parsedPlan =
    row.planned_file_id === null
      ? null
      : planSchema.parse({
          fileId: row.planned_file_id,
          parentId: row.parent_id,
          workspaceMarker: row.workspace_marker,
          mimeType: row.original_mime,
          size: row.original_size,
          sha256: row.original_sha256,
        });
  return {
    lease: leaseSchema.parse({
      id: row.id,
      leaseId: row.lease_id,
      fence: row.fence,
      expiresAt: row.lease_expires_at,
    }),
    documentId: row.document_id,
    sourceMessageId: row.source_message_id,
    providerMessageId: row.provider_message_id,
    partKey: row.part_key,
    mailboxConnectionId: row.mailbox_connection_id,
    mailboxGeneration: row.mailbox_generation,
    storageConnectionId: row.storage_connection_id,
    storageGeneration: row.storage_generation,
    storageSubject: row.storage_subject,
    settingsVersion: row.settings_version,
    plan: parsedPlan,
  };
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ArchiveServiceError) throw error;
    throw new ArchiveServiceError("UNAVAILABLE");
  }
}
/** Private adapter seam; callers supply a context derived from a session/internal job. */
export function createArchiveObjectStore(
  db: D1Database,
  options: { clock?: () => number; id?: () => string; leaseMs?: number } = {},
): ArchiveObjectStore {
  const clock = options.clock ?? Date.now,
    id = options.id ?? (() => crypto.randomUUID()),
    leaseMs = options.leaseMs ?? 60000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300000)
    throw new ArchiveServiceError("INVALID_INPUT");
  function now(): number {
    const value = clock();
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > Number.MAX_SAFE_INTEGER - leaseMs
    )
      throw new ArchiveServiceError("UNAVAILABLE");
    return value;
  }
  function nextId(): string {
    const result = identifier.safeParse(id());
    if (!result.success) throw new ArchiveServiceError("UNAVAILABLE");
    return result.data;
  }
  function leaseArguments(
    context: TenantContext,
    lease: ArchiveObjectLease,
    time = now(),
  ) {
    if (!leaseSchema.safeParse(lease).success)
      throw new ArchiveServiceError("INVALID_INPUT");
    return [
      context.userId,
      lease.id,
      lease.leaseId,
      lease.fence,
      lease.expiresAt,
      time,
    ];
  }
  async function request(
    context: TenantContext,
    value: ArchiveObjectRequest,
  ): Promise<string> {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) throw new ArchiveServiceError("INVALID_INPUT");
    const input = parsed.data;
    await db
      .prepare(
        `INSERT INTO archive_objects(id,user_id,document_id,source_message_id,provider_message_id,part_key,document_hash,document_mime,document_size,mailbox_connection_id,mailbox_generation,storage_connection_id,storage_generation,storage_subject,settings_version)
 SELECT ?,p.user_id,d.id,s.id,s.provider_message_id,d.part_key,d.content_hash,d.mime,d.byte_length,m.id,m.generation,c.id,c.generation,c.provider_subject,a.version
 FROM profiles p JOIN documents d ON d.user_id=p.user_id AND d.id=?
 JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id
 JOIN connections m ON m.user_id=s.user_id AND m.id=s.connection_id
 JOIN archive_settings a ON a.user_id=p.user_id
 JOIN connections c ON c.user_id=a.user_id AND c.id=a.connection_id
 WHERE p.user_id=? AND p.status='active' AND m.kind='mailbox' AND m.state='connected' AND s.available=1 AND s.generation=m.generation
 AND m.credential_ciphertext IS NOT NULL AND m.credential_key_version>0
 AND c.id=? AND c.kind='storage' AND c.provider='google-drive' AND c.state='connected' AND c.credential_ciphertext IS NOT NULL AND c.credential_key_version>0
 AND json_type(CASE WHEN json_valid(c.scopes) THEN c.scopes ELSE '[]' END)='array'
 AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(c.scopes) THEN c.scopes ELSE '[]' END) permission WHERE permission.type='text' AND permission.value='https://www.googleapis.com/auth/drive.file')
 AND a.enabled=1 AND a.version=? AND a.connection_generation=c.generation AND a.disclosure_version=1
 ON CONFLICT(user_id,document_id,storage_connection_id) DO NOTHING`,
      )
      .bind(
        nextId(),
        input.documentId,
        context.userId,
        input.storageConnectionId,
        input.settingsVersion,
      )
      .run();
    const existing = await db
      .prepare(
        `SELECT id FROM archive_objects WHERE user_id=? AND document_id=? AND storage_connection_id=? AND settings_version=? AND ${current}`,
      )
      .bind(
        context.userId,
        input.documentId,
        input.storageConnectionId,
        input.settingsVersion,
      )
      .first<{ id: string }>();
    if (!existing) throw new ArchiveServiceError("CONFLICT");
    return existing.id;
  }
  async function claim(
    context: TenantContext,
    value: string,
  ): Promise<ArchiveObjectWork | null> {
    if (!identifier.safeParse(value).success)
      throw new ArchiveServiceError("INVALID_INPUT");
    const time = now();
    const row = await db
      .prepare(
        `UPDATE archive_objects SET lease_id=?,lease_expires_at=?,fence=fence+1 WHERE user_id=? AND id=? AND state='pending' AND lease_expires_at<=? AND fence<9007199254740991 AND ${current} RETURNING *`,
      )
      .bind(nextId(), time + leaseMs, context.userId, value, time)
      .first<WorkRow>();
    return row ? work(row) : null;
  }
  async function savePlan(
    context: TenantContext,
    lease: ArchiveObjectLease,
    value: ArchiveUploadPlan,
  ): Promise<boolean> {
    const parsed = planSchema.safeParse(value);
    if (!parsed.success) throw new ArchiveServiceError("INVALID_INPUT");
    const plan = parsed.data;
    const result = await db
      .prepare(
        `UPDATE archive_objects SET planned_file_id=?,parent_id=?,workspace_marker=?,original_mime=?,original_size=?,original_sha256=? WHERE ${leaseGuard} AND planned_file_id IS NULL`,
      )
      .bind(
        plan.fileId,
        plan.parentId,
        plan.workspaceMarker,
        plan.mimeType,
        plan.size,
        plan.sha256,
        ...leaseArguments(context, lease),
      )
      .run();
    if (result.meta.changes === 1) return true;
    // An exact replay is safe. A different ID or byte identity never replaces the persisted plan.
    return (
      (await db
        .prepare(
          `SELECT 1 AS ready FROM archive_objects WHERE ${leaseGuard} AND planned_file_id=? AND parent_id=? AND workspace_marker=? AND original_mime=? AND original_size=? AND original_sha256=?`,
        )
        .bind(
          ...leaseArguments(context, lease),
          plan.fileId,
          plan.parentId,
          plan.workspaceMarker,
          plan.mimeType,
          plan.size,
          plan.sha256,
        )
        .first()) !== null
    );
  }
  async function authorized(
    context: TenantContext,
    lease: ArchiveObjectLease,
  ): Promise<boolean> {
    return (
      (await db
        .prepare(`SELECT 1 AS ready FROM archive_objects WHERE ${leaseGuard}`)
        .bind(...leaseArguments(context, lease))
        .first()) !== null
    );
  }
  async function complete(
    context: TenantContext,
    lease: ArchiveObjectLease,
  ): Promise<boolean> {
    const time = now();
    const argumentsList = leaseArguments(context, lease, time);
    const result = await db
      .prepare(
        `UPDATE archive_objects SET state='archived',remote_id=planned_file_id,archived_at=?,lease_id=NULL,lease_expires_at=0 WHERE ${leaseGuard} AND planned_file_id IS NOT NULL`,
      )
      .bind(time, ...argumentsList)
      .run();
    return result.meta.changes === 1;
  }
  return {
    request: (context, input) => safe(() => request(context, input)),
    claim: (context, id) => safe(() => claim(context, id)),
    savePlan: (context, lease, plan) =>
      safe(() => savePlan(context, lease, plan)),
    authorized: (context, lease) => safe(() => authorized(context, lease)),
    complete: (context, lease) => safe(() => complete(context, lease)),
  };
}
