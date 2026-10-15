import {
  EXTRACTION_PROMPT_VERSION,
  extractionSchema,
} from "@invoxim/contracts";
import { validatePersistableAiResult } from "@invoxim/core";
import {
  CLASSIFICATION_DESTINATIONS,
  type ReceiptClassificationConfiguration,
} from "../ai/classification-config";
import {
  classificationDigestInputs,
  LOCAL_PARSER_POLICY,
  onboardingConfigurationDigest,
} from "../onboarding/configuration";
import type { ProcessingReviewMetadata } from "../onboarding/processing-readiness";
import {
  connectionConsentLiveSql,
  processingSelectionSchema,
  processingSelectionSql,
} from "../pipeline/repository-guards";

export interface OnboardingRecoveryRow {
  id: string;
  fence: number;
  status: string;
  consent_id: string;
  connection_generation: number;
  source_id: string | null;
  source_available: number | null;
  pipeline_stage: string | null;
  document_index: number | null;
  extraction_fingerprint: string | null;
  target_run: string | null;
  target_consent: string | null;
  target_generation: number | null;
  target_credential_version: number;
  ai_generation: number;
  ai_credential_version: number;
  processing_selection: string | null;
  prior_digest: string | null;
  cache_json: string | null;
  paid_work: number;
}
function completedClassificationSql() {
  const categories =
    extractionSchema.shape.records.element.shape.category.options
      .map((category) => `'${category}'`)
      .join(",");
  // Code-owned identifiers only; no configuration or request value enters this SQL.
  const destinations = CLASSIFICATION_DESTINATIONS.map(
    (entry) =>
      `(e.destination_id='${entry.destinationId}' AND e.model_id IN (${entry.modelIds.map((id) => `'${id}'`).join(",")}))`,
  ).join(" OR ");
  return `COALESCE((e.extraction_version='email-classification-v1' AND (${destinations}) AND e.result_json IS NOT NULL AND e.completed_at IS NOT NULL AND ev.state IN ('known','uncertain') AND json_valid(e.result_json) AND json_type(e.result_json)='object' AND (SELECT COUNT(*) FROM json_each(e.result_json))=3 AND json_extract(e.result_json,'$.status')='classified' AND json_type(e.result_json,'$.isReceipt') IN ('true','false') AND json_type(e.result_json,'$.category')='text' AND json_extract(e.result_json,'$.category') IN (${categories})),0)`;
}
// The existing tenant cursor selects two jobs. Every join below keeps that owner.
export const recoveryFromSql = `jobs j JOIN profiles p ON p.user_id=j.user_id JOIN connections c ON c.user_id=j.user_id AND c.id=j.connection_id LEFT JOIN discovery_source_jobs dj ON dj.user_id=j.user_id AND dj.job_id=j.id LEFT JOIN source_messages sm ON sm.user_id=dj.user_id AND sm.id=dj.source_message_id LEFT JOIN sync_states ss ON ss.user_id=j.user_id AND ss.id=j.sync_state_id LEFT JOIN processing_consents oldpc ON oldpc.user_id=j.user_id AND oldpc.id=j.consent_id LEFT JOIN import_runs r ON r.user_id=j.user_id AND r.connection_id=j.connection_id AND r.id=(SELECT rr.id FROM import_runs rr WHERE rr.user_id=j.user_id AND rr.connection_id=j.connection_id AND rr.onboarding_interval_key IS NOT NULL AND rr.connection_generation=c.generation AND rr.completed_at IS NULL AND (ss.import_run_id=rr.id OR (ss.sync_kind='incremental' AND ss.run_key='live' AND ss.slice_key='live') OR (sm.id IS NOT NULL AND oldpc.connection_id=rr.connection_id AND oldpc.background_authorized=1 AND oldpc.query_mode=rr.query_mode AND oldpc.revoked_at IS NOT NULL AND sm.received_at>=CASE WHEN length(rr.frozen_start)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',rr.frozen_start)=rr.frozen_start THEN unixepoch(rr.frozen_start)*1000+CAST(substr(rr.frozen_start,21,3) AS INTEGER) WHEN length(rr.frozen_start)=20 AND strftime('%Y-%m-%dT%H:%M:%SZ',rr.frozen_start)=rr.frozen_start THEN unixepoch(rr.frozen_start)*1000 ELSE NULL END) OR EXISTS(SELECT 1 FROM discovery_run_sources ds WHERE ds.user_id=rr.user_id AND ds.import_run_id=rr.id AND ds.source_message_id=sm.id)) ORDER BY rr.started_at DESC,rr.id LIMIT 1) LEFT JOIN processing_consents pc ON pc.user_id=r.user_id AND pc.id=r.consent_id LEFT JOIN ai_settings a ON a.user_id=j.user_id LEFT JOIN documents d ON d.user_id=dj.user_id AND d.source_message_id=dj.source_message_id AND d.pipeline_index=dj.document_index`;
export const recoveryProjectionSql = `j.id,j.fence,j.status,j.consent_id,j.connection_generation,sm.id AS source_id,sm.available AS source_available,dj.pipeline_stage,dj.document_index,dj.extraction_fingerprint,r.id AS target_run,pc.id AS target_consent,c.generation AS target_generation,c.credential_version AS target_credential_version,a.generation AS ai_generation,a.credential_version AS ai_credential_version,oldpc.accepted_configuration_digest AS prior_digest,CASE WHEN ${eligibleSql()} THEN ${processingSelectionSql()} END AS processing_selection,(SELECT COALESCE(json_group_array(json_object('key',e.run_key,'result',e.result_json,'version',e.extraction_version,'price',(SELECT price_snapshot FROM usage_events ev WHERE ev.user_id=e.user_id AND ev.run_key=e.run_key AND ev.state IN ('known','uncertain') ORDER BY ev.attempt_number DESC LIMIT 1))),'[]') FROM (SELECT * FROM ai_extractions ee WHERE ee.user_id=j.user_id AND ee.document_id=d.id AND ee.content_hash=d.content_hash AND ee.purpose='extraction' AND ee.result_json IS NOT NULL AND ee.completed_at IS NOT NULL AND ee.mode=a.mode AND ee.destination_id=a.provider_id AND ee.model_id=a.model_id AND ee.config_version=a.config_version AND ee.settings_revision=a.revision AND ee.generation=a.generation AND ee.credential_version=a.credential_version ORDER BY ee.created_at DESC,ee.run_key LIMIT 2) e) AS cache_json,EXISTS(SELECT 1 FROM ai_extractions e JOIN usage_events ev ON ev.user_id=e.user_id AND ev.run_key=e.run_key WHERE e.user_id=j.user_id AND e.document_id=d.id AND ev.state IN ('reserved','sent','known','uncertain','overrun') AND NOT (${completedClassificationSql()})) AS paid_work`;
function andSql(conditions: readonly string[]): string {
  if (conditions.length === 1) return conditions[0] ?? "0";
  const midpoint = Math.ceil(conditions.length / 2);
  return `(${andSql(conditions.slice(0, midpoint))} AND ${andSql(conditions.slice(midpoint))})`;
}
function eligibleSql() {
  return andSql([
    "r.id IS NOT NULL",
    // P2: one connection/consent live rule shared with pipeline guards.
    connectionConsentLiveSql(),
    "c.generation=r.connection_generation",
    "j.connection_generation<=c.generation",
    "(j.consent_id<>pc.id OR j.connection_generation<>c.generation)",
    "pc.accepted_configuration_digest IS NOT NULL",
    "pc.ai_settings_revision=a.revision",
    "pc.inference_destination=a.provider_id",
    "pc.disclosure_version=a.consent_version",
    "a.status='active'",
    "(a.mode='hosted' OR a.encrypted_key IS NOT NULL)",
    "(sm.id IS NULL OR (sm.connection_id=c.id AND sm.available=1 AND sm.generation<=c.generation))",
    "(j.status IN ('ready','retry_wait','leased','paused_auth','paused_budget') OR (j.status='canceled' AND j.outcome_code IN ('authorization-changed','mailbox_disconnected')))",
    "NOT EXISTS(SELECT 1 FROM lifecycle_deletions ld WHERE ld.user_id=j.user_id AND (ld.scope='account' OR (ld.scope='connection' AND ld.target_id=c.id)))",
  ]);
}
export interface RecoveryDecision {
  row: OnboardingRecoveryRow;
  digest: string;
  metadata: ProcessingReviewMetadata;
  fingerprint: string | null;
  blocked: boolean;
}
export async function reviewRecoveryRows(
  rows: readonly OnboardingRecoveryRow[],
  resolve: (metadata: ProcessingReviewMetadata) => Promise<string | null>,
  classification?: ReceiptClassificationConfiguration,
): Promise<readonly RecoveryDecision[] | null> {
  if (rows.length > 2) throw new Error("RECOVERY_LIMIT");
  const decisions: RecoveryDecision[] = [];
  for (const row of rows) {
    if (!row.processing_selection) continue;
    // P1: one selection schema shared with jobs/store and pipeline/repository.
    const metadata: ProcessingReviewMetadata = processingSelectionSchema.parse(
      JSON.parse(row.processing_selection),
    );
    const digest = await resolve(metadata);
    if (!digest || !metadata.mode) return null;
    let fingerprint = row.extraction_fingerprint,
      blocked = false;
    if (
      (row.pipeline_stage === "infer" || row.pipeline_stage === "reconcile") &&
      row.paid_work
    ) {
      const cache: {
        key: string;
        result: string;
        version: string;
        price: string | null;
      }[] = JSON.parse(row.cache_json ?? "[]");
      blocked = true;
      if (cache.length === 1 && row.prior_digest === digest) {
        const value = cache[0];
        if (
          value?.price &&
          /^[a-f0-9]{64}$/.test(value.key) &&
          value.version === EXTRACTION_PROMPT_VERSION &&
          validatePersistableAiResult(JSON.parse(value.result))
        ) {
          const price: {
            configurationDigest: string;
            policyVersion: number;
            acceptedConfigurationDigest?: string;
          } = JSON.parse(value.price);
          const cacheDigest = await onboardingConfigurationDigest({
            mode: metadata.mode,
            settingsRevision: metadata.settingsRevision,
            aiConfigurationDigest: price.configurationDigest,
            ...classificationDigestInputs(classification),
            parser: LOCAL_PARSER_POLICY,
          });
          if (
            cacheDigest === digest &&
            price.policyVersion === metadata.policyVersion &&
            price.acceptedConfigurationDigest === digest &&
            (row.pipeline_stage === "infer" || fingerprint === value.key)
          ) {
            fingerprint = value.key;
            blocked = false;
          }
        }
      }
    }
    decisions.push({ row, digest, metadata, fingerprint, blocked });
  }
  return decisions;
}
function expectedJob(decision: RecoveryDecision, userId: string, now: number) {
  const { row, metadata, digest } = decision;
  return {
    sql: `EXISTS(SELECT 1 FROM ${recoveryFromSql} WHERE ${andSql(["j.user_id=?", "j.id=?", "j.fence=?", "j.status=?", "j.consent_id=?", "j.connection_generation=?", eligibleSql(), "dj.pipeline_stage IS ?", "dj.document_index IS ?", "dj.extraction_fingerprint IS ?", "sm.id IS ?", "r.id=?", "pc.id=?", "c.generation=?", "pc.accepted_at<=?", "pc.accepted_configuration_digest=?", "a.revision=?", "a.mode=?", "a.provider_id=?", "a.model_id=?", "a.config_version=?", "a.consent_version=?", "c.credential_version=?", "a.generation=?", "a.credential_version=?"])})`,
    values: [
      userId,
      row.id,
      row.fence,
      row.status,
      row.consent_id,
      row.connection_generation,
      row.pipeline_stage,
      row.document_index,
      row.extraction_fingerprint,
      row.source_id,
      row.target_run,
      row.target_consent,
      row.target_generation,
      now,
      digest,
      metadata.settingsRevision,
      metadata.mode,
      metadata.providerId,
      metadata.modelId,
      metadata.configVersion,
      metadata.policyVersion,
      row.target_credential_version,
      row.ai_generation,
      row.ai_credential_version,
    ],
  };
}
export function recoveredJobsPredicate(
  decisions: readonly RecoveryDecision[],
  userId: string,
  now: number,
  afterPromotion = true,
) {
  const conditions = decisions.map((d) => {
    const { row, metadata, digest } = d;
    const promote =
      !d.blocked &&
      row.pipeline_stage === "infer" &&
      row.paid_work &&
      d.fingerprint !== null;
    return {
      sql: `EXISTS(SELECT 1 FROM ${recoveryFromSql} WHERE ${andSql(["j.user_id=?", "j.id=?", "j.fence=?", "j.consent_id=?", "j.connection_generation=?", "j.status=?", connectionConsentLiveSql(), "r.id=?", "pc.id=?", "pc.accepted_at<=?", "pc.accepted_configuration_digest=?", "a.revision=?", "a.mode=?", "a.provider_id=?", "a.model_id=?", "a.config_version=?", "a.consent_version=?", "a.status='active'", "c.credential_version=?", "a.generation=?", "a.credential_version=?", "c.generation=j.connection_generation", "(sm.id IS NULL OR (sm.available=1 AND sm.generation=c.generation))", "dj.pipeline_stage IS ?", "dj.document_index IS ?", "dj.extraction_fingerprint IS ?", "NOT EXISTS(SELECT 1 FROM lifecycle_deletions ld WHERE ld.user_id=j.user_id AND (ld.scope='account' OR (ld.scope='connection' AND ld.target_id=c.id)))"])})`,
      values: [
        userId,
        row.id,
        row.fence + 1,
        row.target_consent,
        row.target_generation,
        d.blocked ? "paused_auth" : "ready",
        row.target_run,
        row.target_consent,
        now,
        digest,
        metadata.settingsRevision,
        metadata.mode,
        metadata.providerId,
        metadata.modelId,
        metadata.configVersion,
        metadata.policyVersion,
        row.target_credential_version,
        row.ai_generation,
        row.ai_credential_version,
        afterPromotion && promote ? "reconcile" : row.pipeline_stage,
        row.document_index,
        afterPromotion && promote ? d.fingerprint : row.extraction_fingerprint,
      ],
    };
  });
  return {
    sql: conditions.map((c) => c.sql).join(" AND "),
    values: conditions.flatMap((c) => c.values),
  };
}
/** Atomic <=2-source/<=2-job rebinding. The caller includes its cursor CAS in the same batch. */
export function buildOnboardingRecoveryStatements(
  prepare: (sql: string) => D1PreparedStatement,
  userId: string,
  now: number,
  decisions: readonly RecoveryDecision[],
) {
  if (!decisions.length || decisions.length > 2) return [];
  const checks = decisions.map((d) => expectedJob(d, userId, now));
  const all = checks.map((check) => check.sql).join(" AND "),
    bindings = checks.flatMap((check) => check.values);
  const sourceIds = decisions
    .map((d) => d.row.source_id)
    .filter((id): id is string => id !== null);
  const statements: D1PreparedStatement[] = [];
  if (sourceIds.length)
    statements.push(
      prepare(
        `UPDATE source_messages SET generation=(SELECT c.generation FROM connections c WHERE c.user_id=source_messages.user_id AND c.id=source_messages.connection_id) WHERE user_id=? AND id IN (${sourceIds.map(() => "?").join(",")}) AND available=1 AND ${all}`,
      ).bind(userId, ...sourceIds, ...bindings),
    );
  const payload = JSON.stringify(
    decisions.map((d) => ({
      id: d.row.id,
      consent: d.row.target_consent,
      generation: d.row.target_generation,
      status: d.blocked ? "paused_auth" : "ready",
      code: d.blocked ? "cache-review-required" : null,
    })),
  );
  statements.push(
    prepare(
      `UPDATE jobs SET consent_id=(SELECT json_extract(value,'$.consent') FROM json_each(?) WHERE json_extract(value,'$.id')=jobs.id),connection_generation=(SELECT json_extract(value,'$.generation') FROM json_each(?) WHERE json_extract(value,'$.id')=jobs.id),status=(SELECT json_extract(value,'$.status') FROM json_each(?) WHERE json_extract(value,'$.id')=jobs.id),outcome_code=(SELECT json_extract(value,'$.code') FROM json_each(?) WHERE json_extract(value,'$.id')=jobs.id),lease_id=NULL,lease_expires_at=NULL,dispatched_at=NULL,dispatch_at=?,fence=fence+1,retry_count=0 WHERE user_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${all}`,
    ).bind(
      payload,
      payload,
      payload,
      payload,
      now,
      userId,
      payload,
      ...bindings,
    ),
  );
  const promotions = decisions.filter(
    (d) =>
      !d.blocked &&
      d.row.pipeline_stage === "infer" &&
      d.row.paid_work &&
      d.fingerprint !== null,
  );
  if (promotions.length) {
    const data = JSON.stringify(
        promotions.map((d) => ({ id: d.row.id, key: d.fingerprint })),
      ),
      post = recoveredJobsPredicate(decisions, userId, now, false);
    statements.push(
      prepare(
        `UPDATE discovery_source_jobs SET pipeline_stage='reconcile',extraction_fingerprint=(SELECT json_extract(value,'$.key') FROM json_each(?) WHERE json_extract(value,'$.id')=discovery_source_jobs.job_id) WHERE user_id=? AND job_id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${post.sql}`,
      ).bind(data, userId, data, ...post.values),
    );
  }
  return statements;
}
