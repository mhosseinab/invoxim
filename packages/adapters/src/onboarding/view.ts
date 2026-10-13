import { onboardingResponseSchema } from "@invoxim/contracts";
import type { OnboardingSession } from "@invoxim/core";
import { OnboardingError } from "@invoxim/core";
import {
  onboardingHistoryCompleteSql,
  onboardingRunJobSql,
} from "./active-run";
import type { createOnboardingReads, SelectedInference } from "./read";
import { scopeReady } from "./read";
export async function readOnboardingView(
  db: D1Database,
  reads: ReturnType<typeof createOnboardingReads>,
  session: OnboardingSession,
  ready: boolean,
  mailboxLimit: number,
  connectionId?: string,
  mailboxProviders: readonly ("gmail" | "outlook")[] = [],
) {
  const profile = await reads.profile(session),
    connections = await reads.connections(session);
  const connection = connectionId
    ? connections.find((c) => c.id === connectionId)
    : connections[0];
  if (connectionId && !connection) throw new OnboardingError("UNAUTHORIZED");
  const totals = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM purchases p WHERE p.user_id=? AND p.record_status!='merged' AND p.lifecycle_delete_connection_id IS NULL) AS records,(SELECT COUNT(*) FROM review_items WHERE user_id=? AND status='open') AS reviews",
    )
    .bind(session.tenant.userId, session.tenant.userId)
    .first<{ records: number; reviews: number }>();
  const run = connection
    ? await db
        .prepare(
          `SELECT r.*,
 (SELECT COUNT(*) FROM discovery_run_sources ds WHERE ds.user_id=r.user_id AND ds.import_run_id=r.id) AS discovered,
 (SELECT COUNT(*) FROM discovery_run_sources ds JOIN source_messages sm ON sm.user_id=ds.user_id AND sm.id=ds.source_message_id WHERE ds.user_id=r.user_id AND ds.import_run_id=r.id AND sm.processing_status='processed') AS processed,
 (SELECT COUNT(*) FROM discovery_run_sources ds JOIN source_messages sm ON sm.user_id=ds.user_id AND sm.id=ds.source_message_id WHERE ds.user_id=r.user_id AND ds.import_run_id=r.id AND sm.processing_status='unsupported') AS unsupported,
 (SELECT COUNT(*) FROM discovery_run_sources ds JOIN source_messages sm ON sm.user_id=ds.user_id AND sm.id=ds.source_message_id WHERE ds.user_id=r.user_id AND ds.import_run_id=r.id AND sm.processing_status='failed') AS failed,
 (SELECT COUNT(*) FROM discovery_run_sources ds JOIN source_messages sm ON sm.user_id=ds.user_id AND sm.id=ds.source_message_id WHERE ds.user_id=r.user_id AND ds.import_run_id=r.id AND sm.processing_status='review') AS review,
 (SELECT COUNT(*) FROM jobs j WHERE ${onboardingRunJobSql} AND j.status IN ('ready','leased','retry_wait')) AS pending,
 (SELECT COUNT(*) FROM jobs j WHERE ${onboardingRunJobSql} AND j.status IN ('paused_budget','paused_auth')) AS paused,
 (SELECT COUNT(*) FROM jobs j WHERE ${onboardingRunJobSql} AND j.status='terminal') AS failedJobs,
 (SELECT COUNT(*) FROM jobs j WHERE ${onboardingRunJobSql} AND j.status='paused_auth' AND j.outcome_code<>'cache-review-required') AS authPausedJobs,
 (SELECT COUNT(*) FROM jobs j WHERE ${onboardingRunJobSql} AND j.status='paused_budget' AND j.outcome_code='budget') AS budgetPausedJobs,
 (SELECT COUNT(*) FROM jobs j WHERE ${onboardingRunJobSql} AND j.status='paused_auth' AND j.outcome_code='cache-review-required') AS cacheReviewJobs,
 (SELECT COUNT(*) FROM jobs j WHERE ${onboardingRunJobSql} AND ((j.status='paused_auth' AND j.outcome_code='cache-review-required') OR (j.status='paused_budget' AND j.outcome_code='handler-unavailable'))) AS servicePausedJobs,
 (SELECT COUNT(DISTINCT ri.id) FROM discovery_run_sources ds JOIN documents d ON d.user_id=ds.user_id AND d.source_message_id=ds.source_message_id JOIN review_items ri ON ri.user_id=d.user_id AND ri.document_id=d.id WHERE ds.user_id=r.user_id AND ds.import_run_id=r.id AND ri.status='open') AS runReviews,
 (SELECT COUNT(*) FROM purchases p WHERE p.user_id=r.user_id AND p.record_status!='merged' AND p.lifecycle_delete_connection_id IS NULL AND (EXISTS(SELECT 1 FROM discovery_run_sources ds JOIN documents d ON d.user_id=ds.user_id AND d.source_message_id=ds.source_message_id JOIN observations o ON o.user_id=d.user_id AND o.document_id=d.id JOIN purchase_evidence pe ON pe.user_id=o.user_id AND pe.observation_id=o.id WHERE ds.user_id=p.user_id AND ds.import_run_id=r.id AND pe.purchase_id=p.id) OR EXISTS(SELECT 1 FROM discovery_run_sources ds JOIN documents d ON d.user_id=ds.user_id AND d.source_message_id=ds.source_message_id JOIN manual_purchase_evidence me ON me.user_id=d.user_id AND me.document_id=d.id WHERE ds.user_id=p.user_id AND ds.import_run_id=r.id AND me.purchase_id=p.id))) AS readyRecords,
 (SELECT pc.accepted_configuration_digest FROM processing_consents pc WHERE pc.user_id=r.user_id AND pc.id=r.consent_id) AS acceptedDigest,
 EXISTS(SELECT 1 FROM processing_consents pc WHERE pc.user_id=r.user_id AND pc.id=r.consent_id AND pc.revoked_at IS NULL) AS consent,
 ${onboardingHistoryCompleteSql} AS historyComplete
 FROM import_runs r WHERE r.user_id=? AND r.connection_id=? ORDER BY r.started_at DESC,r.id LIMIT 1`,
        )
        .bind(session.tenant.userId, connection.id)
        .first<{
          id: string;
          connection_id: string;
          frozen_start: string;
          frozen_cutoff: string;
          stage: string;
          pause_reason: string | null;
          discovered: number;
          processed: number;
          pending: number;
          paused: number;
          failed: number;
          failedJobs: number;
          authPausedJobs: number;
          budgetPausedJobs: number;
          cacheReviewJobs: number;
          servicePausedJobs: number;
          unsupported: number;
          review: number;
          readyRecords: number;
          runReviews: number;
          consent: number;
          acceptedDigest: string | null;
          connection_generation: number;
          completed_at: number | null;
          historyComplete: number;
        }>()
    : null;
  const records = totals?.records ?? 0,
    reviews = totals?.reviews ?? 0,
    consent = run?.consent === 1;
  const complete = run?.historyComplete === 1;
  let state:
    | "connect_mailbox"
    | "review_import"
    | "importing"
    | "records_ready"
    | "no_matches"
    | "paused_budget"
    | "needs_reconnect"
    | "processing_unavailable"
    | "needs_attention" = "review_import";
  let headlineKey = "import.review.title",
    primaryAction:
      | "connect_mailbox"
      | "review_import"
      | "start_import"
      | "view_purchases"
      | "adjust_range"
      | "view_usage"
      | "reconnect"
      | "view_example"
      | "view_review"
      | "none" = "review_import";
  if (!connection && records === 0) {
    state = "connect_mailbox";
    headlineKey = "mailbox.title";
    primaryAction = "connect_mailbox";
  } else if (connection?.state !== "connected") {
    state = "needs_reconnect";
    headlineKey = "import.paused.auth";
    primaryAction = "reconnect";
  } else if (!complete && (run?.paused || run?.pause_reason)) {
    const auth =
      run.pause_reason?.includes("auth") ||
      run.pause_reason?.includes("reconnect") ||
      run.authPausedJobs > 0;
    const budget =
      run.pause_reason?.includes("budget") || run.budgetPausedJobs > 0;
    state = auth
      ? "needs_reconnect"
      : budget
        ? "paused_budget"
        : "processing_unavailable";
    headlineKey = auth
      ? "import.paused.auth"
      : budget
        ? "import.paused.budget"
        : "import.paused.service";
    primaryAction = auth ? "reconnect" : budget ? "view_usage" : "view_example";
  } else if (records > 0 && consent) {
    state = "records_ready";
    headlineKey = "import.progress.ready";
    primaryAction = "view_purchases";
  } else if (!ready) {
    state = "processing_unavailable";
    headlineKey = "import.paused.service";
    primaryAction = "view_example";
  } else if (run && consent) {
    state = complete
      ? reviews > 0
        ? "needs_attention"
        : "no_matches"
      : "importing";
    headlineKey = complete
      ? reviews > 0
        ? "import.completedWithIssues"
        : "import.empty.complete"
      : "import.progress.recent";
    primaryAction = complete
      ? reviews > 0
        ? "view_review"
        : "adjust_range"
      : "none";
  }
  if (complete && (run?.failed ?? 0) > 0 && reviews === 0 && records === 0) {
    state = "processing_unavailable";
    headlineKey = "import.completedWithIssues";
    primaryAction = "view_example";
  }
  let canStartImport = false,
    selected: SelectedInference | null = null;
  if (connection?.state === "connected" && ready) {
    try {
      selected = await reads.selected(session);
    } catch (cause) {
      if (!(cause instanceof OnboardingError)) throw cause;
    }
    if (!selected) {
      state = "processing_unavailable";
      headlineKey = "import.paused.service";
      primaryAction = "view_example";
    } else if (
      run &&
      !complete &&
      (run.acceptedDigest !== selected.configurationDigest ||
        !consent ||
        connection.scheduling_state === "paused" ||
        run.connection_generation !== connection.generation)
    ) {
      state = "review_import";
      headlineKey = "import.review.title";
      primaryAction = "review_import";
    }
  }
  if (
    state === "review_import" &&
    connection &&
    selected &&
    scopeReady(connection) &&
    connection.credential_ciphertext &&
    (!run || complete || run.connection_generation <= connection.generation)
  ) {
    const allowance = await reads.allowance(session, selected);
    canStartImport =
      selected.keyReady &&
      selected.noticesReady &&
      !allowance.cooldownActive &&
      allowance.dailyDocumentsRemaining > 0 &&
      allowance.monthlyDocumentsRemaining > 0 &&
      allowance.dailyUnitsRemaining > 0 &&
      allowance.monthlyUnitsRemaining > 0 &&
      (selected.mode !== "hosted" || allowance.hostedFundingAvailable);
    if (canStartImport) primaryAction = "start_import";
  }
  return onboardingResponseSchema.parse({
    view: {
      schemaVersion: 1,
      state,
      headlineKey,
      primaryAction,
      canStartImport,
      readyRecordCount: records,
      historyComplete: complete,
      hasProcessingConsent: consent,
      exampleData: false,
      reviewItemCount: reviews,
      activeImportId: run?.id ?? null,
      connectionId: connection?.id ?? null,
    },
    login: { email: session.loginEmail },
    settings: {
      version: profile.version,
      timezone: profile.timezone,
      reportingCurrency: profile.reporting_currency,
    },
    connections: connections.map((c) => ({
      id: c.id,
      provider: c.provider,
      address: c.display_address,
      generation: c.generation,
      state: c.state,
      schedulingState: c.scheduling_state,
      scopeReady: scopeReady(c),
    })),
    capabilities: { mailboxProviders: [...mailboxProviders] },
    mailboxLimit,
    progress: run
      ? {
          importRunId: run.id,
          connectionId: run.connection_id,
          startAt: run.frozen_start,
          cutoffAt: run.frozen_cutoff,
          stage: run.stage,
          discoveredSources: run.discovered,
          processedSources: run.processed,
          unsupportedSources: run.unsupported,
          failedSources: run.failed,
          reviewSources: run.review,
          readyRecordCount: run.readyRecords,
          reviewItemCount: run.runReviews,
          pendingJobs: run.pending,
          pausedJobs: run.paused,
          failedJobs: run.failedJobs,
          historyComplete: complete,
          pauseReason:
            run.cacheReviewJobs > 0
              ? "cache-review-required"
              : run.servicePausedJobs > 0
                ? "handler-unavailable"
                : run.pause_reason,
        }
      : null,
  });
}
