import {
  type ArchiveCredentialFences,
  type ArchiveObjectLease,
  ArchiveServiceError,
  type ArchiveUploadPlan,
  type ArchiveUploadSessionSnapshot,
  type ArchiveUploadSessionStore,
} from "@invoxim/core";
import { z } from "zod";
import { readEnvelopeVersion } from "../security/cipher";
import { archiveSafe as safe } from "./boundary";
import { archiveObjectAuthorization } from "./objects";
import { archiveUploadPlanSchema } from "./plans";

const maximumVersion = 2147483646;
const localSessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const integer = z.number().int().safe().nonnegative();
const version = integer.min(1).max(maximumVersion);
const planSchema = archiveUploadPlanSchema;
const referenceSchema = z.strictObject({
  ciphertext: z.string().min(1).max(40000),
  keyVersion: version,
  expiresAt: integer.min(1),
});
const planClause =
  " AND (planned_file_id=? AND parent_id=? AND workspace_marker=? AND original_mime=? AND original_size=? AND original_sha256=?)";
const fields =
  "reference_ciphertext,key_version,version,expires_at,uploaded_bytes";
interface SessionRow {
  reference_ciphertext: string;
  key_version: number;
  version: number;
  expires_at: number;
  uploaded_bytes: number;
}
function snapshot(
  row: SessionRow,
  plan: ArchiveUploadPlan,
): ArchiveUploadSessionSnapshot {
  if (
    !referenceSchema.safeParse({
      ciphertext: row.reference_ciphertext,
      keyVersion: row.key_version,
      expiresAt: row.expires_at,
    }).success ||
    !version.safeParse(row.version).success ||
    !integer.max(plan.size).safeParse(row.uploaded_bytes).success ||
    readEnvelopeVersion(row.reference_ciphertext) !== row.key_version
  )
    throw new ArchiveServiceError("CONFLICT");
  return {
    ciphertext: row.reference_ciphertext,
    keyVersion: row.key_version,
    version: row.version,
    expiresAt: row.expires_at,
    uploadedBytes: row.uploaded_bytes,
  };
}
/** Durable metadata only; no plaintext session URL or original bytes are accepted. */
export function createArchiveUploadSessionStore(
  db: D1Database,
): ArchiveUploadSessionStore {
  function guard(
    context: Parameters<ArchiveUploadSessionStore["read"]>[0],
    lease: ArchiveObjectLease,
    plan: ArchiveUploadPlan,
    credentials: Required<ArchiveCredentialFences>,
  ) {
    if (
      !planSchema.safeParse(plan).success ||
      !credentials?.mailbox ||
      !credentials.storage
    )
      throw new ArchiveServiceError("INVALID_INPUT");
    const now = Date.now();
    if (
      !integer.safeParse(now).success ||
      now > Number.MAX_SAFE_INTEGER - localSessionLifetimeMs
    )
      throw new ArchiveServiceError("UNAVAILABLE");
    const parent = archiveObjectAuthorization(context, lease, now, credentials);
    return {
      sql: `${parent.sql}${planClause}`,
      values: [
        ...parent.values,
        plan.fileId,
        plan.parentId,
        plan.workspaceMarker,
        plan.mimeType,
        plan.size,
        plan.sha256,
      ],
      now,
    };
  }
  async function read(
    ...args: Parameters<ArchiveUploadSessionStore["read"]>
  ): Promise<ArchiveUploadSessionSnapshot | null> {
    const [context, lease, plan, credentials] = args;
    const current = guard(context, lease, plan, credentials);
    const row = await db
      .prepare(
        `SELECT ${fields} FROM archive_upload_sessions s WHERE s.user_id=? AND s.object_id=? AND EXISTS(SELECT 1 FROM archive_objects WHERE ${current.sql})`,
      )
      .bind(context.userId, lease.id, ...current.values)
      .first<SessionRow>();
    if (row) return snapshot(row, plan);
    // Absence is distinct from refused authority, including when the lease expires during the read.
    const latest = guard(context, lease, plan, credentials);
    const eligible = await db
      .prepare(
        `SELECT 1 AS authorized FROM archive_objects WHERE ${latest.sql}`,
      )
      .bind(...latest.values)
      .first();
    if (!eligible) throw new ArchiveServiceError("CONFLICT");
    return null;
  }
  async function save(
    ...args: Parameters<ArchiveUploadSessionStore["save"]>
  ): Promise<ArchiveUploadSessionSnapshot | null> {
    const [context, lease, plan, expectedVersion, reference, credentials] =
      args;
    const current = guard(context, lease, plan, credentials);
    if (
      !integer.max(maximumVersion).safeParse(expectedVersion).success ||
      !referenceSchema.safeParse(reference).success ||
      reference.expiresAt <= current.now ||
      reference.expiresAt > current.now + localSessionLifetimeMs ||
      readEnvelopeVersion(reference.ciphertext) !== reference.keyVersion
    )
      throw new ArchiveServiceError("INVALID_INPUT");
    const row = await db
      .prepare(
        `INSERT INTO archive_upload_sessions(user_id,object_id,reference_ciphertext,key_version,version,expires_at,uploaded_bytes)
      SELECT ?,?,?,?,1,?,0 WHERE EXISTS(SELECT 1 FROM archive_objects WHERE ${current.sql}) AND (?=0 OR EXISTS(SELECT 1 FROM archive_upload_sessions WHERE user_id=? AND object_id=? AND version=?))
      ON CONFLICT(user_id,object_id) DO UPDATE SET reference_ciphertext=excluded.reference_ciphertext,key_version=excluded.key_version,version=archive_upload_sessions.version+1,expires_at=excluded.expires_at,uploaded_bytes=0 WHERE archive_upload_sessions.version=? AND archive_upload_sessions.version<? AND archive_upload_sessions.key_version<=excluded.key_version RETURNING ${fields}`,
      )
      .bind(
        context.userId,
        lease.id,
        reference.ciphertext,
        reference.keyVersion,
        reference.expiresAt,
        ...current.values,
        expectedVersion,
        context.userId,
        lease.id,
        expectedVersion,
        expectedVersion,
        maximumVersion,
      )
      .first<SessionRow>();
    return row ? snapshot(row, plan) : null;
  }
  async function checkpoint(
    ...args: Parameters<ArchiveUploadSessionStore["checkpoint"]>
  ): Promise<boolean> {
    const [context, lease, plan, sessionVersion, uploadedBytes, credentials] =
      args;
    const current = guard(context, lease, plan, credentials);
    if (
      !version.safeParse(sessionVersion).success ||
      !integer.max(plan.size).safeParse(uploadedBytes).success
    )
      throw new ArchiveServiceError("INVALID_INPUT");
    const result = await db
      .prepare(
        `UPDATE archive_upload_sessions SET uploaded_bytes=? WHERE user_id=? AND object_id=? AND version=? AND expires_at>? AND uploaded_bytes<=? AND EXISTS(SELECT 1 FROM archive_objects WHERE ${current.sql})`,
      )
      .bind(
        uploadedBytes,
        context.userId,
        lease.id,
        sessionVersion,
        current.now,
        uploadedBytes,
        ...current.values,
      )
      .run();
    return result.meta.changes === 1;
  }
  return {
    read: (...args) => safe(() => read(...args)),
    save: (...args) => safe(() => save(...args)),
    checkpoint: (...args) => safe(() => checkpoint(...args)),
  };
}
