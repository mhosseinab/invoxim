import type {
  DiscoveryPlan,
  OnboardingImportSeed,
  TenantContext,
} from "@invoxim/core";
export interface AcceptedImportBatchInput {
  readonly context: TenantContext;
  readonly connectionId: string;
  readonly generation: number;
  readonly consentId: string;
  readonly fingerprint: string;
  readonly queryMode: "filtered" | "broad";
  readonly timezone: string;
  readonly runId: string;
  readonly recentId: string;
  readonly olderId: string;
  readonly liveId: string;
  readonly seed: OnboardingImportSeed;
  readonly now: number;
  readonly plan: DiscoveryPlan;
  readonly guard: { sql: string; values: (string | number | null)[] };
  readonly onboarding?: {
    startDate: string;
    endDate: string;
    reportingCurrency: string;
    intervalKey: string;
  };
}
/** Concrete atomic import writes shared by accepted imports and explicit onboarding Start. */
export function buildAcceptedImportStatements(
  db: D1Database,
  input: AcceptedImportBatchInput,
): D1PreparedStatement[] {
  const { context, runId, recentId, olderId, liveId, seed, now, plan } = input;
  const anchor = seed.provider === "gmail" ? seed.historyAnchor : null;
  const catchup = Boolean(
    seed.provider === "gmail" && input.onboarding && now > plan.range.cutoffMs,
  );
  const guard = input.guard.sql,
    bindings = input.guard.values;
  const start = new Date(plan.range.startMs).toISOString(),
    cutoff = new Date(plan.range.cutoffMs).toISOString();
  const statements: D1PreparedStatement[] = [];
  const add = (sql: string, values: (string | number | null)[]) =>
    statements.push(db.prepare(sql).bind(...values, ...bindings));
  add(
    `INSERT INTO import_runs(id,user_id,connection_id,consent_id,connection_generation,frozen_start,frozen_cutoff,timezone,request_fingerprint,stage,started_at,query_mode${input.onboarding ? ",onboarding_start_date,onboarding_end_date,onboarding_reporting_currency,onboarding_interval_key" : ""}) SELECT ?,?,?,?,?,?,?,?,?,'discovering_recent',?,?${input.onboarding ? ",?,?,?,?" : ""} WHERE ${guard} ON CONFLICT(user_id,request_fingerprint) DO NOTHING`,
    [
      runId,
      context.userId,
      input.connectionId,
      input.consentId,
      input.generation,
      start,
      cutoff,
      input.timezone,
      input.fingerprint,
      now,
      input.queryMode,
      ...(input.onboarding
        ? [
            input.onboarding.startDate,
            input.onboarding.endDate,
            input.onboarding.reportingCurrency,
            input.onboarding.intervalKey,
          ]
        : []),
    ],
  );
  const runExists =
    "EXISTS(SELECT 1 FROM import_runs WHERE user_id=? AND id=?)";
  for (const slice of [
    { id: recentId, kind: "recent", range: plan.recent },
    ...(plan.older ? [{ id: olderId, kind: "older", range: plan.older }] : []),
  ])
    add(
      `INSERT INTO sync_states(id,user_id,connection_id,import_run_id,scope_key,sync_kind,run_key,slice_key,frozen_start,frozen_cutoff,stage,query_mode,coverage_code) SELECT ?,?,?,?,'mailbox','backfill',?,?,?,?,?,?,? WHERE ${runExists} AND ${guard}`,
      [
        slice.id,
        context.userId,
        input.connectionId,
        runId,
        runId,
        slice.kind,
        new Date(slice.range.startMs).toISOString(),
        new Date(slice.range.cutoffMs).toISOString(),
        slice.kind === "recent" ? "queued" : "waiting_recent",
        input.queryMode,
        input.queryMode === "broad"
          ? "broad_metadata"
          : seed.provider === "outlook"
            ? "candidate_unknown"
            : "filtered_query",
        context.userId,
        runId,
      ],
    );
  add(
    `INSERT INTO sync_states(id,user_id,connection_id,scope_key,sync_kind,run_key,slice_key,history_cursor,query_mode,coverage_code,stage,recovery_anchor,frozen_start,frozen_cutoff) SELECT ?,?,?,'mailbox','incremental','live','live',?,?,?, ?,?,?,? WHERE ${runExists} AND ${guard} ON CONFLICT(user_id,connection_id,scope_key,sync_kind,run_key,slice_key) DO NOTHING`,
    [
      liveId,
      context.userId,
      input.connectionId,
      anchor,
      input.queryMode,
      catchup ? "recovering_history" : "candidate_unknown",
      catchup ? "recovering" : "queued",
      catchup ? anchor : null,
      catchup ? cutoff : null,
      catchup ? new Date(now).toISOString() : null,
      context.userId,
      runId,
    ],
  );
  add(
    `INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at,priority) SELECT ?,?,?,?,?,?,'discover',?,'ready',?,0 WHERE ${runExists} AND ${guard} ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
    [
      crypto.randomUUID(),
      context.userId,
      input.connectionId,
      input.consentId,
      input.generation,
      recentId,
      `discover:${recentId}:0`,
      now,
      context.userId,
      runId,
    ],
  );
  add(
    `UPDATE connections SET scheduling_state='active',next_sync_at=? WHERE user_id=? AND id=? AND ${runExists} AND ${guard}`,
    [now + 3600000, context.userId, input.connectionId, context.userId, runId],
  );
  return statements;
}
