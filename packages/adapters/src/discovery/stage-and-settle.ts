import type { JobLease, JobOutcome } from "@invoxim/core";

/**
 * G10 / O9: the stage-and-settle tail every guarded discovery batch ends with.
 *
 * A runner stages its writes, then a continuation job (optional) and finally
 * a guarded completion of the leased job. Every statement carries the same
 * guard (a commit marker and/or the lease guard), so the completion only
 * lands when the whole batch did. These builders replace the hand-copied
 * statements (G-40: they add no statement). The continuation and completion
 * keep their leading SQL text; the outcome code is always a literal and the
 * continuation's type and priority are always bound.
 */
type Bind = string | number | null;
export interface StageGuard {
  sql: string;
  values: readonly Bind[];
}
export type StagedOutcome =
  | "discovery_staged"
  | "rate_deferred"
  | "rate_paused";

/** AND-joins guards in order; bind order follows. */
export function stageGuard(...guards: StageGuard[]): StageGuard {
  return {
    sql: guards.map((guard) => guard.sql).join(" AND "),
    values: guards.flatMap((guard) => guard.values),
  };
}

/**
 * The guarded continuation job. `ON CONFLICT DO NOTHING` keeps a replayed
 * batch from enqueueing twice. Defaults: a fresh id, the lease's sync state
 * and job type.
 */
export function stageContinuation(
  db: D1Database,
  lease: JobLease,
  guard: StageGuard,
  job: {
    dedupeKey: string;
    dispatchAt: number | null;
    priority: number;
    id?: string;
    syncStateId?: string | null;
    type?: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at,priority) SELECT ?,?,?,?,?,?,?,?,'ready',?,? WHERE ${guard.sql} ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
    )
    .bind(
      job.id ?? crypto.randomUUID(),
      lease.context.userId,
      lease.connectionId,
      lease.consentId,
      lease.generation,
      job.syncStateId === undefined ? lease.syncStateId : job.syncStateId,
      job.type ?? lease.type,
      job.dedupeKey,
      job.dispatchAt,
      job.priority,
      ...guard.values,
    );
}

/**
 * The guarded completion of the leased job, always the batch's last
 * statement. With `continuationKey` it also requires that continuation to be
 * ready; `also` appends one further caller condition.
 */
export function completeStagedJob(
  db: D1Database,
  lease: JobLease,
  guard: StageGuard,
  options: {
    outcome: StagedOutcome;
    continuationKey?: string;
    also?: StageGuard;
  },
): D1PreparedStatement {
  const continuation =
    options.continuationKey === undefined
      ? ""
      : " AND EXISTS(SELECT 1 FROM jobs continuation WHERE continuation.user_id=? AND continuation.dedupe_key=? AND continuation.status='ready')";
  return db
    .prepare(
      `UPDATE jobs SET status='completed',lease_id=NULL,lease_expires_at=NULL,outcome_code='${options.outcome}' WHERE user_id=? AND id=? AND ${guard.sql}${continuation}${options.also ? ` AND ${options.also.sql}` : ""}`,
    )
    .bind(
      lease.context.userId,
      lease.jobId,
      ...guard.values,
      ...(options.continuationKey === undefined
        ? []
        : [lease.context.userId, options.continuationKey]),
      ...(options.also?.values ?? []),
    );
}

/**
 * Runs the staged batch and settles it in one of the two existing ways:
 * `"last-change"` reads the completion's own change count (no statement);
 * `"read"` re-reads the leased job afterwards (one statement, reserved by the
 * caller's OUTLOOK_STATEMENTS entry).
 */
export async function stageAndSettle(
  db: D1Database,
  lease: JobLease,
  statements: D1PreparedStatement[],
  settle: "last-change" | "read",
): Promise<boolean> {
  const results = await db.batch(statements);
  if (settle === "last-change") return results.at(-1)?.meta.changes === 1;
  return Boolean(
    await db
      .prepare(
        "SELECT status FROM jobs WHERE user_id=? AND id=? AND status='completed'",
      )
      .bind(lease.context.userId, lease.jobId)
      .first(),
  );
}

/** A settled Outlook staging batch completes; a lost one retries. */
export function settledOutcome(settled: boolean): JobOutcome {
  return settled ? { kind: "completed" } : { kind: "retry", code: "transient" };
}
