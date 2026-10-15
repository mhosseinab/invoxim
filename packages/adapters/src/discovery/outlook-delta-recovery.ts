import type { JobLease, JobOutcome } from "@invoxim/core";
import { OUTLOOK_STATEMENTS, outlookBudgetShortfall } from "./outlook-budget";
import {
  type DeltaControl,
  deltaLeaseGuard,
  type FolderState,
  type OutlookDeltaContext,
} from "./outlook-delta-shared";
import { rateDecision } from "./rate-decision";
import {
  completeStagedJob,
  settledOutcome,
  stageAndSettle,
  stageContinuation,
  stageGuard,
} from "./stage-and-settle";

/** G11: an expired folder delta restarts as a bounded range recovery. */
export async function resetExpired(
  context: OutlookDeltaContext,
  lease: JobLease,
  control: DeltaControl,
  folder: FolderState,
): Promise<JobOutcome> {
  const { db, clock, options } = context;
  if (folder.history_reset_count >= 3)
    return { kind: "terminal", code: "unsupported" };
  if (control.signal.aborted || !(await control.checkpoint()))
    return { kind: "paused", code: "auth" };
  const approved = await db
    .prepare(
      "SELECT frozen_start,frozen_cutoff FROM import_runs WHERE user_id=? AND connection_id=? AND consent_id=? AND connection_generation=? ORDER BY started_at DESC,id DESC LIMIT 1",
    )
    .bind(
      lease.context.userId,
      lease.connectionId,
      lease.consentId,
      lease.generation,
    )
    .first<{ frozen_start: string; frozen_cutoff: string }>();
  if (!approved) return { kind: "paused", code: "auth" };
  if (control.signal.aborted || !(await control.checkpoint()))
    return { kind: "paused", code: "auth" };
  if (options.remainingStatements() < OUTLOOK_STATEMENTS.resetExpired)
    return outlookBudgetShortfall();
  const now = clock();
  const nonce = crypto.randomUUID();
  const leaseGuard = deltaLeaseGuard(lease, now);
  const marker =
    "EXISTS(SELECT 1 FROM sync_states child WHERE child.user_id=? AND child.id=? AND child.discovery_version=? AND child.pending_history_id=?)";
  const markerValues = [
    lease.context.userId,
    folder.id,
    folder.discovery_version + 1,
    nonce,
  ];
  const staged = stageGuard({ sql: marker, values: markerValues }, leaseGuard);
  const continuationKey = `outlook:page:${lease.jobId}`;
  return settledOutcome(
    await stageAndSettle(
      db,
      lease,
      [
        db
          .prepare(
            `UPDATE sync_states SET discovery_version=discovery_version+1,page_token=NULL,history_cursor=NULL,stage='recovering',frozen_start=?,frozen_cutoff=?,history_reset_count=history_reset_count+1,pending_history_id=?,retry_at=NULL,consecutive_failures=0 WHERE user_id=? AND id=? AND connection_id=? AND discovery_version=? AND ${leaseGuard.sql}`,
          )
          .bind(
            approved.frozen_start,
            approved.frozen_cutoff,
            nonce,
            lease.context.userId,
            folder.id,
            lease.connectionId,
            folder.discovery_version,
            ...leaseGuard.values,
          ),
        stageContinuation(db, lease, staged, {
          dedupeKey: continuationKey,
          dispatchAt: now,
          priority: 0,
        }),
        completeStagedJob(db, lease, staged, {
          outcome: "discovery_staged",
          continuationKey,
        }),
      ],
      "read",
    ),
  );
}

/** G11 / G4: a rate-limited folder defers or pauses via rateDecision. */
export async function deferFolderRate(
  context: OutlookDeltaContext,
  lease: JobLease,
  control: DeltaControl,
  folder: FolderState,
  delayMs: number | undefined,
  countFailure = true,
): Promise<JobOutcome> {
  const { db, clock, options } = context;
  if (control.signal.aborted || !(await control.checkpoint()))
    return { kind: "paused", code: "auth" };
  if (options.remainingStatements() < OUTLOOK_STATEMENTS.folderRate)
    return outlookBudgetShortfall();
  const now = clock();
  const decision = rateDecision({
    retryAfterMs: delayMs,
    consecutiveFailures: folder.consecutive_failures,
    countFailure,
  });
  const paused = decision.kind === "pause";
  const retryAt =
    decision.kind === "pause"
      ? null
      : countFailure
        ? now + decision.delayMs
        : folder.retry_at;
  const nonce = crypto.randomUUID();
  const leaseGuard = deltaLeaseGuard(lease, now);
  const marker =
    "EXISTS(SELECT 1 FROM sync_states child WHERE child.user_id=? AND child.id=? AND child.discovery_version=? AND child.pending_history_id=?)";
  const markerValues = [
    lease.context.userId,
    folder.id,
    folder.discovery_version + 1,
    nonce,
  ];
  const staged = stageGuard({ sql: marker, values: markerValues }, leaseGuard);
  const continuationKey = `outlook:page:${lease.jobId}`;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE sync_states SET discovery_version=discovery_version+1,stage=?,retry_at=?,consecutive_failures=?,pending_history_id=? WHERE user_id=? AND id=? AND connection_id=? AND discovery_version=? AND ${leaseGuard.sql}`,
      )
      .bind(
        paused ? "paused_rate" : folder.stage,
        retryAt,
        decision.failures,
        nonce,
        lease.context.userId,
        folder.id,
        lease.connectionId,
        folder.discovery_version,
        ...leaseGuard.values,
      ),
  ];
  if (!paused)
    statements.push(
      stageContinuation(db, lease, staged, {
        dedupeKey: continuationKey,
        dispatchAt: retryAt,
        priority: 0,
      }),
    );
  statements.push(
    completeStagedJob(
      db,
      lease,
      staged,
      paused
        ? { outcome: "rate_paused" }
        : { outcome: "rate_deferred", continuationKey },
    ),
  );
  return settledOutcome(await stageAndSettle(db, lease, statements, "read"));
}
