/**
 * G1: one initial `source-extract` job per discovered source across
 * connection generations. The generation-scoped dedupe key alone lets a
 * reconnect re-enqueue (and re-bill) a source that an earlier generation
 * already queued, so Gmail and Outlook discovery share these fragments.
 *
 * `sourceId` is a scalar subquery selecting the source_messages id; it binds
 * userId, connectionId, providerMessageId.
 */

/** Bind order: userId, then the three `sourceId` binds. */
export function initialSourceJobAbsentSql(sourceId: string): string {
  return `NOT EXISTS(SELECT 1 FROM jobs initial JOIN discovery_source_jobs original ON original.user_id=initial.user_id AND original.job_id=initial.id WHERE initial.user_id=? AND original.source_message_id=${sourceId} AND initial.type='source-extract' AND substr(initial.dedupe_key,1,7)='source:')`;
}

/**
 * Scalar subquery for the job a source links to: this generation's new job,
 * or the earliest job already linked to the source.
 * Bind order: userId, connectionId, dedupeKey, then the three `sourceId` binds.
 */
export function initialSourceJobSql(sourceId: string): string {
  return `(SELECT initial.id FROM jobs initial WHERE initial.user_id=? AND initial.connection_id=? AND initial.type='source-extract' AND (initial.dedupe_key=? OR EXISTS(SELECT 1 FROM discovery_source_jobs original WHERE original.user_id=initial.user_id AND original.job_id=initial.id AND original.source_message_id=${sourceId})) ORDER BY initial.connection_generation,initial.id LIMIT 1)`;
}
