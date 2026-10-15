import type { JobLease, LedgerPlan } from "@invoxim/core";
import { z } from "zod";
import { sourceNotDiscardedSql } from "../corrections/source-decision";
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
export function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (
    encoded === undefined ||
    new TextEncoder().encode(encoded).length > 262144
  )
    throw new PipelinePersistenceError("PIPELINE_LIMIT");
  return encoded;
}
export function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new PipelinePersistenceError("PIPELINE_CONFLICT");
  }
}
/**
 * P2: the single connection/consent "live" rule. Every job path must require
 * an active mailbox connection whose credentials are present and a
 * non-revoked background consent. Callers append `accepted_at<=?` with their
 * own bind, because some sites share that placeholder with other predicates.
 */
export function connectionConsentLiveSql(
  aliases: { connection?: string; profile?: string; consent?: string } = {},
): string {
  const c = aliases.connection ?? "c";
  const p = aliases.profile ?? "p";
  const pc = aliases.consent ?? "pc";
  return `${c}.kind='mailbox' AND ${c}.state='connected' AND ${c}.scheduling_state='active' AND ${c}.credential_ciphertext IS NOT NULL AND ${p}.status='active' AND ${pc}.revoked_at IS NULL AND ${pc}.background_authorized=1`;
}
/**
 * P1.5b / G2 / ext#12: the lease/consent "live" predicate. One fragment for
 * every path that must only proceed while a job lease is held and its
 * connection/consent is still live. Replaces the hand-copied guards in
 * jobs/store.ts, sources.ts and (via INT-5) the discovery runners, which had
 * drifted (Outlook skipped the disclosure/digest check).
 *
 * Joined form (default alias j): a WHERE fragment for a
 * "jobs j JOIN connections c ... JOIN profiles p ... JOIN processing_consents pc"
 * FROM clause (see LIVE_FROM). Bind order: userId, jobId, leaseId, fence, now,
 * connectionId, generation, consentId, now (accepted_at), then any binds
 * introduced by extras.
 *
 * Correlated form (alias.jobs = "jobs"): a WHERE fragment for the same joins
 * against an outer jobs row, with no lease binds. Bind order: now
 * (accepted_at), then extras binds.
 *
 * alias renames the joined tables. extras AND additional caller conditions
 * (job type filters, provider/scope checks, the disclosure/digest gate).
 */
export function leaseLive(
  options: {
    alias?: {
      jobs?: string;
      connection?: string;
      profile?: string;
      consent?: string;
    };
    extras?: readonly string[];
  } = {},
): string {
  const j = options.alias?.jobs ?? "j";
  const c = options.alias?.connection ?? "c";
  const p = options.alias?.profile ?? "p";
  const pc = options.alias?.consent ?? "pc";
  // `"jobs"` is the outer table name, not a join alias: correlate instead of
  // binding a held lease. The job store's live check reads an existing row.
  const link =
    j === "jobs"
      ? [
          `${c}.user_id=jobs.user_id`,
          `${c}.id=jobs.connection_id`,
          `${c}.generation=jobs.connection_generation`,
          `${pc}.id=jobs.consent_id`,
        ]
      : [
          `${j}.user_id=?`,
          `${j}.id=?`,
          `${j}.status='leased'`,
          `${j}.lease_id=?`,
          `${j}.fence=?`,
          `${j}.lease_expires_at>?`,
          `${j}.connection_id=?`,
          `${j}.connection_generation=?`,
          `${j}.consent_id=?`,
          `${c}.generation=${j}.connection_generation`,
        ];
  return [
    ...link,
    connectionConsentLiveSql({ connection: c, profile: p, consent: pc }),
    `${pc}.accepted_at<=?`,
    ...(options.extras ?? []),
  ].join(" AND ");
}
/**
 * P1.5c / P9: the current-document guard. Pins the job's current document by
 * id and requires the infer-stage / ready-or-extracted checks. Extracted
 * because the hand-copied forms had drifted (failDocument lacked the
 * stage/parse_state checks).
 *
 * `checkParseState: false` omits the parse_state predicate for batches that
 * write parse_state themselves (failDocument), where the full guard would
 * self-invalidate after the first statement.
 *
 * Bind order: userId, jobId, documentId.
 */
export function currentDocumentGuard(
  options: {
    alias?: { jobs?: string; documents?: string };
    checkParseState?: boolean;
  } = {},
): string {
  const j = options.alias?.jobs ?? "current";
  const d = options.alias?.documents ?? "d";
  const parseCheck =
    options.checkParseState === false
      ? ""
      : ` AND ${d}.parse_state IN('ready','extracted')`;
  return `EXISTS(SELECT 1 FROM discovery_source_jobs ${j} JOIN documents ${d} ON ${d}.user_id=${j}.user_id AND ${d}.source_message_id=${j}.source_message_id WHERE ${j}.user_id=? AND ${j}.job_id=? AND ${j}.pipeline_stage IN ('infer','reconcile') AND ${d}.id=? AND ${d}.pipeline_index=${j}.document_index${parseCheck})`;
}
/**
 * P1.5c / P9: the next-document guard. Verifies a successor document exists
 * at the given pipeline index.
 * Bind order: userId, jobId, nextDocumentIndex.
 */
export function nextDocumentGuard(
  aliases: { jobs?: string; documents?: string } = {},
): string {
  const j = aliases.jobs ?? "current";
  const d = aliases.documents ?? "d";
  return `EXISTS(SELECT 1 FROM discovery_source_jobs ${j} JOIN documents ${d} ON ${d}.user_id=${j}.user_id AND ${d}.source_message_id=${j}.source_message_id WHERE ${j}.user_id=? AND ${j}.job_id=? AND ${d}.pipeline_index=? AND ${d}.pipeline_index=${j}.document_index+1)`;
}
/**
 * P10: the active-profile EXISTS predicate. Purchase-views queries require an
 * active profile on the outer row's user.
 * Bind order: none (correlated on the outer alias).
 */
export function activeProfile(alias: string): string {
  return `EXISTS(SELECT 1 FROM profiles active WHERE active.user_id=${alias}.user_id AND active.status='active')`;
}
/**
 * P10: the active-profile EXISTS predicate in bound form. Use when the outer
 * query binds userId directly rather than correlating on an alias.
 * Bind order: userId.
 */
export const activeProfileSql =
  "EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')";
/**
 * O6: the session-live guard. A WHERE fragment over the `session` table: the
 * session exists for this user, has not expired, and the user's profile is
 * active. Unlike the Drive `liveSession` (D6) it has no recent-auth window.
 * Bind order: sessionId, userId, now, userId.
 */
export function sessionLiveWhere(
  session: { sessionId: string; userId: string },
  now: number,
): Predicate {
  return {
    sql: `id=? AND userId=? AND expiresAt>? AND ${activeProfileSql}`,
    values: [session.sessionId, session.userId, now, session.userId],
  };
}
/**
 * D5: the drive.file scope fragment. INT-4 migrates the drive call sites.
 * Bind order: none (correlated on the connection alias).
 */
export function driveFileScopeSql(alias = "c"): string {
  return `json_type(CASE WHEN json_valid(${alias}.scopes) THEN ${alias}.scopes ELSE '[]' END)='array' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(${alias}.scopes) THEN ${alias}.scopes ELSE '[]' END) permission WHERE permission.type='text' AND permission.value='https://www.googleapis.com/auth/drive.file')`;
}
/**
 * D5: the mailbox scope fragment. INT-4 migrates the drive call sites.
 * Bind order: none (correlated on the mailbox alias).
 */
export function mailboxScopeSql(alias = "m"): string {
  return `length(${alias}.scopes)<=4096 AND json_type(CASE WHEN json_valid(${alias}.scopes) THEN ${alias}.scopes ELSE '[]' END)='array' AND json_array_length(CASE WHEN json_valid(${alias}.scopes) THEN ${alias}.scopes ELSE '[]' END)<=16 AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(${alias}.scopes) THEN ${alias}.scopes ELSE '[]' END) permission WHERE permission.type='text' AND ((${alias}.provider='gmail' AND permission.value='https://www.googleapis.com/auth/gmail.readonly') OR (${alias}.provider='outlook' AND permission.value='https://graph.microsoft.com/Mail.Read')))`;
}
/**
 * P1: the one consent-review selection shape (SQL `json_object` projection).
 * Optional columns are nullable because the projection emits SQL NULL.
 */
export const processingSelectionSchema = z.strictObject({
  mode: z.enum(["hosted", "byok"]).nullable(),
  settingsRevision: z.number().int().positive(),
  providerId: z.string().min(1).max(120).nullable(),
  modelId: z.string().min(1).max(120).nullable(),
  configVersion: z.string().min(1).max(120).nullable(),
  policyVersion: z.number().int().nonnegative(),
  acceptedDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
/** P1: one projection for the owned processing-selection JSON. */
export function processingSelectionSql(
  aliases: { ai?: string; consent?: string } = {},
): string {
  const a = aliases.ai ?? "a";
  const pc = aliases.consent ?? "pc";
  return `json_object('mode',${a}.mode,'settingsRevision',${a}.revision,'providerId',${a}.provider_id,'modelId',${a}.model_id,'configVersion',${a}.config_version,'policyVersion',${a}.consent_version,'acceptedDigest',${pc}.accepted_configuration_digest)`;
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
    sql: `${leaseLive({ extras: ["j.type IN ('source-extract','reprocess')"] })} AND (pc.ai_settings_revision=a.revision AND pc.inference_destination=a.provider_id AND pc.disclosure_version=a.consent_version) AND (a.status='active' AND a.mode IS NOT NULL AND a.provider_id IS NOT NULL AND a.model_id IS NOT NULL AND a.config_version IS NOT NULL AND (a.mode='hosted' OR a.encrypted_key IS NOT NULL)) AND (sm.connection_id=c.id AND sm.generation=c.generation AND sm.available=1) AND ${sourceNotDiscardedSql("sm")}`,
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
/**
 * Single source-status derivation shared by `commit` and `skipDocument`
 * (P3/P0.5). A document whose parse_state is outside {ready, extracted} is
 * unresolved content and keeps the source at 'review', so a non-purchase skip
 * cannot discard a source that a financial commit would leave reviewable.
 */
export const SOURCE_STATUS_CASE = `CASE WHEN EXISTS(SELECT 1 FROM review_items r JOIN documents d ON d.user_id=r.user_id AND d.id=r.document_id WHERE r.user_id=source_messages.user_id AND d.source_message_id=source_messages.id AND r.status='open') OR EXISTS(SELECT 1 FROM documents d WHERE d.user_id=source_messages.user_id AND d.source_message_id=source_messages.id AND d.parse_state NOT IN('ready','extracted')) THEN 'review' WHEN EXISTS(SELECT 1 FROM documents d WHERE d.user_id=source_messages.user_id AND d.source_message_id=source_messages.id AND d.parse_state='ready') THEN 'discovered' WHEN EXISTS(SELECT 1 FROM documents d WHERE d.user_id=source_messages.user_id AND d.source_message_id=source_messages.id AND d.parse_state='extracted') THEN 'processed' ELSE 'unsupported' END`;
/**
 * Optimistic-concurrency guard over the plan's expected purchase versions.
 * `advanced` accounts for the version bump applied by the payment-state
 * UPDATE in the same batch.
 */
export function versionGuard(
  guard: Predicate,
  lease: JobLease,
  plan: LedgerPlan,
  advanced = false,
): Predicate {
  const expected = plan.expectedPurchases.map((purchase) => ({
    id: purchase.id,
    version:
      purchase.version +
      (advanced &&
      plan.paymentStates.some((state) => state.purchaseId === purchase.id)
        ? 1
        : 0),
  }));
  return {
    sql: `${guard.sql} AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM purchases WHERE user_id=? AND id=json_extract(expected.value,'$.id') AND version=json_extract(expected.value,'$.version') AND lifecycle_delete_connection_id IS NULL AND lifecycle_recompute_connection_id IS NULL))`,
    values: [...guard.values, json(expected), lease.context.userId],
  };
}
