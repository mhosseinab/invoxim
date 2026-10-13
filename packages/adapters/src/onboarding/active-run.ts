import type { OnboardingSession } from "@invoxim/core";
// These predicates always refer to the trusted parent alias r and owned job alias j.
export const onboardingRunJobSql = `j.user_id=r.user_id AND (EXISTS(SELECT 1 FROM sync_states ss WHERE ss.user_id=j.user_id AND ss.id=j.sync_state_id AND ss.import_run_id=r.id AND ss.sync_kind='backfill') OR EXISTS(SELECT 1 FROM discovery_source_jobs sj JOIN discovery_run_sources ds ON ds.user_id=sj.user_id AND ds.source_message_id=sj.source_message_id WHERE sj.user_id=j.user_id AND sj.job_id=j.id AND ds.import_run_id=r.id))`;
export const onboardingHistoryCompleteSql = `EXISTS(SELECT 1 FROM sync_states ss WHERE ss.user_id=r.user_id AND ss.import_run_id=r.id AND ss.sync_kind='backfill') AND NOT EXISTS(SELECT 1 FROM sync_states ss WHERE ss.user_id=r.user_id AND ss.import_run_id=r.id AND ss.sync_kind='backfill' AND ss.stage<>'discovery_complete') AND NOT EXISTS(SELECT 1 FROM discovery_run_sources ds JOIN source_messages sm ON sm.user_id=ds.user_id AND sm.id=ds.source_message_id WHERE ds.user_id=r.user_id AND ds.import_run_id=r.id AND sm.processing_status NOT IN ('processed','unsupported','failed','review')) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE ${onboardingRunJobSql} AND j.status IN ('ready','leased','retry_wait','paused_auth','paused_budget'))`;
export interface ActiveOnboardingRun {
  id: string;
  consent_id: string;
  connection_generation: number;
  frozen_start: string;
  frozen_cutoff: string;
  timezone: string;
  onboarding_start_date: string | null;
  onboarding_end_date: string | null;
  onboarding_reporting_currency: string | null;
  accepted_digest: string | null;
  pause_reason: string | null;
  paused: number;
  authorizationCanceled: number;
}
export async function readActiveOnboardingRun(
  db: D1Database,
  session: OnboardingSession,
  connectionId: string,
) {
  return db
    .prepare(
      `SELECT r.*,pc.accepted_configuration_digest AS accepted_digest,(SELECT COUNT(*) FROM jobs j WHERE ${onboardingRunJobSql} AND j.status IN ('paused_auth','paused_budget')) AS paused,(SELECT COUNT(*) FROM jobs j WHERE ${onboardingRunJobSql} AND j.status='canceled' AND j.outcome_code='authorization-changed') AS authorizationCanceled FROM import_runs r JOIN processing_consents pc ON pc.user_id=r.user_id AND pc.id=r.consent_id WHERE r.user_id=? AND r.connection_id=? AND r.completed_at IS NULL AND NOT (${onboardingHistoryCompleteSql}) AND EXISTS(SELECT 1 FROM profiles WHERE user_id=r.user_id AND status='active') ORDER BY r.started_at DESC,r.id LIMIT 1`,
    )
    .bind(session.tenant.userId, connectionId)
    .first<ActiveOnboardingRun>();
}
