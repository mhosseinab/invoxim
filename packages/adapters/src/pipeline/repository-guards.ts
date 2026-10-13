import type { JobLease } from "@invoxim/core";
export class PipelinePersistenceError extends Error {
  constructor(
    readonly code:
      | "INVALID_PIPELINE"
      | "PIPELINE_CONFLICT"
      | "PIPELINE_LIMIT"
      | "PIPELINE_UNAVAILABLE",
  ) {
    super(code);
    this.name = "PipelinePersistenceError";
  }
}
export interface Predicate {
  sql: string;
  values: (string | number | null)[];
}
export const LIVE_FROM = `jobs j JOIN profiles p ON p.user_id=j.user_id JOIN connections c ON c.user_id=j.user_id AND c.id=j.connection_id JOIN processing_consents pc ON pc.user_id=j.user_id AND pc.id=j.consent_id AND pc.connection_id=j.connection_id JOIN ai_settings a ON a.user_id=j.user_id JOIN discovery_source_jobs dj ON dj.user_id=j.user_id AND dj.job_id=j.id JOIN source_messages sm ON sm.user_id=dj.user_id AND sm.id=dj.source_message_id`;
export function liveWhere(lease: JobLease, now: number): Predicate {
  if (
    lease.context.authority !== "job" ||
    !["source-extract", "reprocess"].includes(lease.type) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(lease.fence) ||
    lease.fence < 0 ||
    !Number.isSafeInteger(lease.generation) ||
    lease.generation < 1
  )
    throw new PipelinePersistenceError("INVALID_PIPELINE");
  return {
    sql: `(j.user_id=? AND j.id=? AND j.status='leased' AND j.lease_id=?) AND (j.fence=? AND j.lease_expires_at>? AND j.connection_id=? AND j.connection_generation=?) AND (j.consent_id=? AND j.type IN ('source-extract','reprocess') AND p.status='active') AND (c.state='connected' AND c.scheduling_state='active' AND c.generation=j.connection_generation AND c.credential_ciphertext IS NOT NULL) AND (pc.revoked_at IS NULL AND pc.background_authorized=1 AND pc.accepted_at<=? AND pc.ai_settings_revision=a.revision AND pc.inference_destination=a.provider_id AND pc.disclosure_version=a.consent_version) AND (a.status='active' AND a.mode IS NOT NULL AND a.provider_id IS NOT NULL AND a.model_id IS NOT NULL AND a.config_version IS NOT NULL AND (a.mode='hosted' OR a.encrypted_key IS NOT NULL)) AND (sm.connection_id=c.id AND sm.generation=c.generation AND sm.available=1)`,
    values: [
      lease.context.userId,
      lease.jobId,
      lease.leaseId,
      lease.fence,
      now,
      lease.connectionId,
      lease.generation,
      lease.consentId,
      now,
    ],
  };
}
export function liveGuard(lease: JobLease, now: number): Predicate {
  const where = liveWhere(lease, now);
  return {
    sql: `EXISTS(SELECT 1 FROM ${LIVE_FROM} WHERE ${where.sql})`,
    values: where.values,
  };
}
export function cachedGuard(
  lease: JobLease,
  now: number,
  documentId: string,
  fingerprint: string,
): Predicate {
  const where = liveWhere(lease, now);
  return {
    sql: `EXISTS(SELECT 1 FROM ${LIVE_FROM} JOIN documents d ON d.user_id=sm.user_id AND d.source_message_id=sm.id JOIN ai_extractions e ON e.user_id=d.user_id AND e.document_id=d.id WHERE ${where.sql} AND (d.id=? AND e.run_key=? AND e.purpose='extraction' AND e.completed_at IS NOT NULL) AND (e.result_json IS NOT NULL AND e.content_hash=d.content_hash AND e.settings_revision=a.revision AND e.mode=a.mode) AND (e.destination_id=a.provider_id AND e.model_id=a.model_id AND e.config_version=a.config_version AND e.generation=a.generation AND e.credential_version=a.credential_version))`,
    values: [...where.values, documentId, fingerprint],
  };
}
export async function executeBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<"committed" | "stale"> {
  try {
    const result = await db.batch(statements);
    return result.at(-1)?.meta.changes === 1 ? "committed" : "stale";
  } catch (error) {
    if (error instanceof Error && /SQLITE_CONSTRAINT/.test(error.message))
      throw new PipelinePersistenceError("PIPELINE_CONFLICT");
    throw new PipelinePersistenceError("PIPELINE_UNAVAILABLE");
  }
}
