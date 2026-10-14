import { hasControlCharacters } from "@invoxim/contracts";
import {
  type ArchiveFolderAuthorization,
  type ArchiveFolderLease,
  type ArchiveFolderPlan,
  type ArchiveFolderStore,
  ArchiveServiceError,
  type TenantContext,
} from "@invoxim/core";
import { z } from "zod";
import { archiveSafe as safe } from "./boundary";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !hasControlCharacters(value));
const integer = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const authorizationSchema = z.strictObject({
  connectionId: identifier,
  settingsVersion: integer.max(2147483646),
  generation: integer,
});
const proposalSchema = z.strictObject({
  fileId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  workspaceMarker: z.string().regex(/^[A-Za-z0-9_-]{16,96}$/),
});
const leaseSchema = authorizationSchema.extend({
  leaseId: identifier,
  fence: integer,
  expiresAt: integer,
  storageSubject: identifier,
});
// Repeated at every authorization boundary; a retained folder ID is never consent.
const eligible = `p.status='active' AND c.kind='storage' AND c.provider='google-drive'
 AND c.state='connected' AND c.credential_ciphertext IS NOT NULL AND c.credential_key_version>0
 AND json_type(CASE WHEN json_valid(c.scopes) THEN c.scopes ELSE '[]' END)='array'
 AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(c.scopes) THEN c.scopes ELSE '[]' END) permission WHERE permission.type='text' AND permission.value='https://www.googleapis.com/auth/drive.file')
 AND a.enabled=1 AND a.connection_id=c.id AND a.connection_generation=c.generation AND a.disclosure_version=1`;
function current(version: string, generation: string): string {
  return `EXISTS(SELECT 1 FROM profiles p
 JOIN connections c ON c.user_id=p.user_id AND c.id=archive_folders.connection_id
 JOIN archive_settings a ON a.user_id=p.user_id
 WHERE p.user_id=archive_folders.user_id AND c.provider_subject=archive_folders.storage_subject
 AND a.version=${version} AND c.generation=${generation} AND ${eligible})`;
}
const leaseGuard = `user_id=? AND connection_id=? AND state='planned' AND storage_subject=?
 AND lease_settings_version=? AND lease_generation=? AND lease_id=? AND fence=?
 AND lease_expires_at=? AND lease_expires_at>? AND ${current("archive_folders.lease_settings_version", "archive_folders.lease_generation")}`;
interface FolderRow {
  connection_id: string;
  storage_subject: string;
  planned_file_id: string;
  workspace_marker: string;
  state: "planned" | "ready";
  lease_id: string | null;
  fence: number;
  lease_expires_at: number;
  lease_settings_version: number | null;
  lease_generation: number | null;
}
function plan(row: FolderRow): ArchiveFolderPlan {
  return {
    connectionId: row.connection_id,
    storageSubject: row.storage_subject,
    fileId: row.planned_file_id,
    workspaceMarker: row.workspace_marker,
    name: "Invoxim Receipts",
    state: row.state,
  };
}
export function createArchiveFolderStore(
  db: D1Database,
  options: { clock?: () => number; id?: () => string; leaseMs?: number } = {},
): ArchiveFolderStore {
  const clock = options.clock ?? Date.now;
  const id = options.id ?? (() => crypto.randomUUID());
  const leaseMs = options.leaseMs ?? 60000;
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
  function validateAuthorization(value: ArchiveFolderAuthorization): void {
    if (!authorizationSchema.safeParse(value).success)
      throw new ArchiveServiceError("INVALID_INPUT");
  }
  function leaseArguments(
    context: TenantContext,
    lease: ArchiveFolderLease,
    time = now(),
  ) {
    if (!leaseSchema.safeParse(lease).success)
      throw new ArchiveServiceError("INVALID_INPUT");
    return [
      context.userId,
      lease.connectionId,
      lease.storageSubject,
      lease.settingsVersion,
      lease.generation,
      lease.leaseId,
      lease.fence,
      lease.expiresAt,
      time,
    ];
  }
  async function readCurrent(
    context: TenantContext,
    auth: ArchiveFolderAuthorization,
  ): Promise<ArchiveFolderPlan | null> {
    validateAuthorization(auth);
    const row = await db
      .prepare(
        `SELECT f.*,c.provider_subject AS authorized_subject FROM profiles p
      JOIN connections c ON c.user_id=p.user_id AND c.id=?
      JOIN archive_settings a ON a.user_id=p.user_id
      LEFT JOIN archive_folders f ON f.user_id=p.user_id AND f.connection_id=c.id
      WHERE p.user_id=? AND a.version=? AND c.generation=? AND ${eligible}`,
      )
      .bind(
        auth.connectionId,
        context.userId,
        auth.settingsVersion,
        auth.generation,
      )
      .first<FolderRow & { authorized_subject: string }>();
    if (!row) throw new ArchiveServiceError("CONFLICT");
    if (!row.connection_id) return null;
    if (row.storage_subject !== row.authorized_subject)
      throw new ArchiveServiceError("CONFLICT");
    return plan(row);
  }
  async function getOrPlan(
    context: TenantContext,
    auth: ArchiveFolderAuthorization,
    proposed: { fileId: string; workspaceMarker: string },
  ): Promise<ArchiveFolderPlan> {
    validateAuthorization(auth);
    if (!proposalSchema.safeParse(proposed).success)
      throw new ArchiveServiceError("INVALID_INPUT");
    await db
      .prepare(
        `INSERT INTO archive_folders(user_id,connection_id,storage_subject,planned_file_id,workspace_marker)
 SELECT p.user_id,c.id,c.provider_subject,?,? FROM profiles p
 JOIN connections c ON c.user_id=p.user_id AND c.id=? JOIN archive_settings a ON a.user_id=p.user_id
 WHERE p.user_id=? AND a.version=? AND c.generation=? AND ${eligible}
 ON CONFLICT(user_id,connection_id) DO NOTHING`,
      )
      .bind(
        proposed.fileId,
        proposed.workspaceMarker,
        auth.connectionId,
        context.userId,
        auth.settingsVersion,
        auth.generation,
      )
      .run();
    const row = await db
      .prepare(
        `SELECT * FROM archive_folders WHERE user_id=? AND connection_id=? AND ${current("?", "?")}`,
      )
      .bind(
        context.userId,
        auth.connectionId,
        auth.settingsVersion,
        auth.generation,
      )
      .first<FolderRow>();
    if (!row) throw new ArchiveServiceError("CONFLICT");
    return plan(row);
  }
  async function claim(
    context: TenantContext,
    auth: ArchiveFolderAuthorization,
  ) {
    validateAuthorization(auth);
    const time = now();
    const leaseId = identifier.safeParse(id());
    if (!leaseId.success) throw new ArchiveServiceError("UNAVAILABLE");
    const row = await db
      .prepare(
        `UPDATE archive_folders SET lease_id=?,lease_expires_at=?,lease_settings_version=?,lease_generation=?,fence=fence+1
 WHERE user_id=? AND connection_id=? AND state='planned' AND lease_expires_at<=? AND fence<9007199254740991 AND ${current("?", "?")} RETURNING *`,
      )
      .bind(
        leaseId.data,
        time + leaseMs,
        auth.settingsVersion,
        auth.generation,
        context.userId,
        auth.connectionId,
        time,
        auth.settingsVersion,
        auth.generation,
      )
      .first<FolderRow>();
    return row
      ? {
          plan: plan(row),
          lease: leaseSchema.parse({
            connectionId: row.connection_id,
            storageSubject: row.storage_subject,
            settingsVersion: row.lease_settings_version,
            generation: row.lease_generation,
            leaseId: row.lease_id,
            fence: row.fence,
            expiresAt: row.lease_expires_at,
          }),
        }
      : null;
  }
  async function authorized(
    context: TenantContext,
    lease: ArchiveFolderLease,
  ): Promise<boolean> {
    return (
      (await db
        .prepare(`SELECT 1 AS ready FROM archive_folders WHERE ${leaseGuard}`)
        .bind(...leaseArguments(context, lease))
        .first()) !== null
    );
  }
  async function complete(
    context: TenantContext,
    lease: ArchiveFolderLease,
  ): Promise<boolean> {
    const time = now();
    const result = await db
      .prepare(
        `UPDATE archive_folders SET state='ready',verified_at=?,lease_id=NULL,lease_expires_at=0,lease_settings_version=NULL,lease_generation=NULL WHERE ${leaseGuard}`,
      )
      .bind(time, ...leaseArguments(context, lease, time))
      .run();
    return result.meta.changes === 1;
  }
  return {
    readCurrent: (context, auth) => safe(() => readCurrent(context, auth)),
    getOrPlan: (context, auth, proposed) =>
      safe(() => getOrPlan(context, auth, proposed)),
    claim: (context, auth) => safe(() => claim(context, auth)),
    authorized: (context, lease) => safe(() => authorized(context, lease)),
    complete: (context, lease) => safe(() => complete(context, lease)),
  };
}
