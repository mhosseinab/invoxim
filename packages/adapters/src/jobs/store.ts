import { hasControlCharacters } from "@invoxim/contracts";
import type {
  DispatchCandidate,
  JobPolicy,
  JobStore,
  NewJob,
  TenantContext,
} from "@invoxim/core";
import type { ReceiptClassificationConfiguration } from "../ai/clef";
import type { ProcessingReviewMetadata } from "../onboarding/processing-readiness";
import {
  connectionConsentLiveSql,
  processingSelectionSchema,
  processingSelectionSql,
} from "../pipeline/repository-guards";
import {
  buildOnboardingRecoveryStatements,
  type OnboardingRecoveryRow,
  recoveredJobsPredicate,
  recoveryFromSql,
  recoveryProjectionSql,
  reviewRecoveryRows,
} from "./onboarding-recovery";

interface Row {
  id: string;
  user_id: string;
  connection_id: string;
  consent_id: string;
  connection_generation: number;
  sync_state_id: string | null;
  type: string;
  status: string;
  fence: number;
  retry_count: number;
  lease_id: string | null;
  lease_expires_at: number | null;
  dispatched_at: number | null;
  dispatch_at: number;
}
interface EligibleConnection {
  id: string;
  generation: number;
  consent_id: string;
  next_sync_at: number | null;
  manual_sync_at: number | null;
}
class JobQueryBudgetError extends Error {
  constructor() {
    super("JOB_QUERY_BUDGET");
    this.name = "JobQueryBudgetError";
  }
}
export class JobStorageError extends Error {
  constructor() {
    super("JOB_STORAGE_UNAVAILABLE");
    this.name = "JobStorageError";
  }
}
export function createJobStore(
  db: D1Database,
  options: {
    policy: JobPolicy;
    clock?: () => number;
    id?: () => string;
    classification?: ReceiptClassificationConfiguration;
    processingReview?: (
      metadata: ProcessingReviewMetadata,
    ) => Promise<string | null>;
  },
): JobStore {
  const policy = options.policy;
  const clock = options.clock ?? Date.now;
  const id = options.id ?? (() => crypto.randomUUID());
  for (const value of Object.values(policy))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("INVALID_JOB_POLICY");
  if (
    policy.dispatchLimit > 50 ||
    policy.scheduleLimit > 50 ||
    policy.tenantConcurrency > 2 ||
    policy.globalConcurrency > 100 ||
    policy.maxAttempts > 5 ||
    policy.leaseMs > 300000 ||
    policy.redeliveryMs > 3600000
  )
    throw new Error("INVALID_JOB_POLICY");
  const queryLimit = policy.queryLimit ?? 40;
  if (queryLimit > 40) throw new Error("INVALID_JOB_POLICY");
  const recoveryCap =
    queryLimit >= 24
      ? options.processingReview
        ? 10
        : 8
      : queryLimit >= 16
        ? 2
        : 0;
  const scheduleCap = queryLimit >= 16 ? 8 : 0;
  const reservationCap =
    queryLimit >= 16
      ? Math.max(
          2,
          Math.floor((queryLimit - 16) / 3) +
            2 -
            (options.processingReview && queryLimit >= 24 ? 2 : 0),
        )
      : 0;
  const candidateCap = queryLimit - recoveryCap - scheduleCap - reservationCap;
  let executions = 0;
  let ceiling = queryLimit;
  const remaining = () => Math.min(queryLimit, ceiling) - executions;
  const charge = (count = 1) => {
    if (remaining() < count) throw new JobQueryBudgetError();
    executions += count;
  };
  const nativeStatements = new WeakMap<
    D1PreparedStatement,
    D1PreparedStatement
  >();
  // Private job adapter accounting; preparing/binding do not execute D1 queries.
  function prepare(sql: string): D1PreparedStatement {
    const wrap = (native: D1PreparedStatement): D1PreparedStatement => {
      const wrapped = {
        bind(...values: unknown[]) {
          return wrap(native.bind(...values));
        },
        async first<T>(column?: string) {
          charge();
          return column === undefined
            ? native.first<T>()
            : native.first<T>(column);
        },
        async all<T>() {
          charge();
          return native.all<T>();
        },
        async run<T>() {
          charge();
          return native.run<T>();
        },
        async raw<T>(options?: { columnNames?: boolean }) {
          charge();
          return options?.columnNames
            ? native.raw<T>({ columnNames: true })
            : native.raw<T>();
        },
      } as D1PreparedStatement;
      nativeStatements.set(wrapped, native);
      return wrapped;
    };
    return wrap(db.prepare(sql));
  }
  async function batch(statements: D1PreparedStatement[]) {
    charge(statements.length);
    return db.batch(
      statements.map(
        (statement) => nativeStatements.get(statement) ?? statement,
      ),
    );
  }
  async function stage<T>(
    limit: number,
    fallback: T,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = ceiling;
    ceiling = Math.min(queryLimit, executions + limit);
    try {
      return await work();
    } catch (error) {
      if (error instanceof JobQueryBudgetError) return fallback;
      throw error;
    } finally {
      ceiling = previous;
    }
  }
  const now = () => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("INVALID_CLOCK");
    return value;
  };
  // P2: one connection/consent live rule shared with pipeline/repository-guards.
  const live = `EXISTS(SELECT 1 FROM connections c JOIN profiles p ON p.user_id=c.user_id JOIN processing_consents pc ON pc.user_id=c.user_id AND pc.connection_id=c.id WHERE c.user_id=jobs.user_id AND c.id=jobs.connection_id AND c.generation=jobs.connection_generation AND pc.id=jobs.consent_id AND ${connectionConsentLiveSql()} AND pc.accepted_at<=?)`;
  // Reuse the recovery metadata shape within the existing checkpoint statement.
  // The current configuration resolver is pure: no provider call or extra D1 read.
  const processingSelection = `(SELECT ${processingSelectionSql()} FROM connections c JOIN processing_consents pc ON pc.user_id=c.user_id AND pc.connection_id=c.id JOIN ai_settings a ON a.user_id=c.user_id WHERE c.user_id=jobs.user_id AND c.id=jobs.connection_id AND pc.id=jobs.consent_id AND a.status='active' AND (a.mode='hosted' OR a.encrypted_key IS NOT NULL) AND pc.ai_settings_revision=a.revision AND pc.inference_destination=a.provider_id AND pc.disclosure_version=a.consent_version)`;
  const columns =
    "id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,status,fence,retry_count,lease_id,lease_expires_at,dispatched_at,dispatch_at";
  // Only internal, validated database rows may acquire opaque job authority.
  const context = (userId: string) =>
    ({ userId, authority: "job" }) as TenantContext;
  function checkText(value: string) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 256 ||
      hasControlCharacters(value)
    )
      throw new Error("INVALID_JOB_INPUT");
  }
  async function page(
    kind: "dispatch" | "schedule" | "recovery",
    limit: number,
  ) {
    const cursor = await prepare(
      "SELECT last_user_id,version FROM scheduler_cursors WHERE kind=?",
    )
      .bind(kind)
      .first<{ last_user_id: string; version: number }>();
    if (!cursor) throw new JobStorageError();
    const filter = kind === "recovery" ? "" : "status='active' AND ";
    const users = (
      await prepare(
        `SELECT user_id,job_recovery_cursor FROM (SELECT user_id,job_recovery_cursor,0 AS wrap_rank FROM (SELECT user_id,job_recovery_cursor FROM profiles WHERE ${filter}user_id>? ORDER BY user_id LIMIT ?) UNION ALL SELECT user_id,job_recovery_cursor,1 AS wrap_rank FROM (SELECT user_id,job_recovery_cursor FROM profiles WHERE ${filter}user_id<=? ORDER BY user_id LIMIT ?)) ORDER BY wrap_rank,user_id LIMIT ?`,
      )
        .bind(cursor.last_user_id, limit, cursor.last_user_id, limit, limit)
        .all<{ user_id: string; job_recovery_cursor: string }>()
    ).results;
    // Two bounded index ranges wrap in this statement, without an idle reset tick.
    let version = cursor.version;
    return {
      users,
      async advance(user: string) {
        const result = await prepare(
          "UPDATE scheduler_cursors SET last_user_id=?,version=version+1 WHERE kind=? AND version=?",
        )
          .bind(user, kind, version)
          .run();
        if (result.meta.changes === 1) version++;
        return result.meta.changes === 1;
      },
    };
  }
  async function enqueue(ctx: TenantContext, input: NewJob): Promise<boolean> {
    for (const text of [
      input.id,
      input.connectionId,
      input.consentId,
      input.dedupeKey,
      input.type,
    ])
      checkText(text);
    if (
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      ![0, 1, 2].includes(input.priority ?? 1)
    )
      throw new Error("INVALID_JOB_INPUT");
    const at = now();
    const result = await prepare(
      `INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at,priority) SELECT ?,?,?,?,?,?,?,?,'ready',?,? WHERE EXISTS(SELECT 1 FROM connections c JOIN profiles p ON p.user_id=c.user_id JOIN processing_consents pc ON pc.user_id=c.user_id AND pc.connection_id=c.id WHERE c.user_id=? AND c.id=? AND c.generation=? AND pc.id=? AND ${connectionConsentLiveSql()} AND pc.accepted_at<=?) ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
    )
      .bind(
        input.id,
        ctx.userId,
        input.connectionId,
        input.consentId,
        input.generation,
        input.syncStateId ?? null,
        input.type,
        input.dedupeKey,
        at,
        input.priority ?? 1,
        ctx.userId,
        input.connectionId,
        input.generation,
        input.consentId,
        at,
      )
      .run();
    return result.meta.changes === 1;
  }
  async function eligibleConnection(ctx: TenantContext, connectionId: string) {
    return prepare(
      `SELECT c.id,c.generation,pc.id AS consent_id,c.next_sync_at,c.manual_sync_at FROM connections c JOIN profiles p ON p.user_id=c.user_id JOIN processing_consents pc ON pc.user_id=c.user_id AND pc.connection_id=c.id WHERE c.user_id=? AND c.id=? AND ${connectionConsentLiveSql()} AND pc.accepted_at<=? ORDER BY pc.accepted_at DESC,pc.id LIMIT 1`,
    )
      .bind(ctx.userId, connectionId, now())
      .first<EligibleConnection>();
  }
  async function schedule(
    ctx: TenantContext,
    connectionId: string,
    manual: boolean,
    knownConnection?: EligibleConnection,
  ): Promise<
    | { kind: "queued"; jobId: string }
    | { kind: "review-required" }
    | { kind: "cooldown" }
  > {
    checkText(connectionId);
    const row =
      knownConnection ?? (await eligibleConnection(ctx, connectionId));
    if (!row) return { kind: "review-required" };
    const at = now();
    if (
      manual &&
      row.manual_sync_at !== null &&
      row.manual_sync_at > at - 300000
    )
      return { kind: "cooldown" };
    const jitter = [...connectionId].reduce(
      (sum, char) => (sum * 31 + char.charCodeAt(0)) % 60001,
      0,
    );
    const next = at + 3600000 + jitter;
    const syncId = `live-${id()}`;
    const jobId = id();
    const dedupe = `sync:${connectionId}:${row.generation}:${manual ? "manual" : "hourly"}:${Math.floor(at / (manual ? 300000 : 3600000))}`;
    const guard =
      `EXISTS(SELECT 1 FROM connections c JOIN profiles p ON p.user_id=c.user_id JOIN processing_consents pc ON pc.user_id=c.user_id AND pc.connection_id=c.id WHERE c.user_id=? AND c.id=? AND c.generation=? AND pc.id=? AND ${connectionConsentLiveSql()} AND pc.accepted_at<=? AND (?=0 OR c.manual_sync_at IS NULL OR c.manual_sync_at<=?)) AND NOT EXISTS(SELECT 1 FROM jobs pending WHERE pending.user_id=? AND pending.connection_id=? AND pending.connection_generation=? AND pending.type='sync' AND pending.status IN ('ready','leased','retry_wait') AND pending.id<>?)`;
    const bindings = [
      ctx.userId,
      connectionId,
      row.generation,
      row.consent_id,
      at,
      manual ? 1 : 0,
      at - 300000,
      ctx.userId,
      connectionId,
      row.generation,
      jobId,
    ];
    const cursorSub =
      "(SELECT id FROM sync_states WHERE user_id=? AND connection_id=? AND scope_key='mailbox' AND sync_kind='incremental' AND run_key='live' AND slice_key='live')";
    const result = await batch([
      prepare(
        `INSERT INTO sync_states(id,user_id,connection_id,scope_key,sync_kind,run_key,slice_key) SELECT ?,?,?,'mailbox','incremental','live','live' WHERE ${guard} ON CONFLICT(user_id,connection_id,scope_key,sync_kind,run_key,slice_key) DO NOTHING`,
      ).bind(syncId, ctx.userId, connectionId, ...bindings),
      prepare(
        `INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at,priority) SELECT ?,?,?,?,?,${cursorSub},'sync',?,'ready',?,0 WHERE ${guard} ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
      ).bind(
        jobId,
        ctx.userId,
        connectionId,
        row.consent_id,
        row.generation,
        ctx.userId,
        connectionId,
        dedupe,
        at,
        ...bindings,
      ),
      prepare(
        `UPDATE connections SET next_sync_at=?,manual_sync_at=CASE WHEN ?=1 THEN ? ELSE manual_sync_at END WHERE user_id=? AND id=? AND ${guard} AND EXISTS(SELECT 1 FROM jobs WHERE user_id=connections.user_id AND id=?)`,
      ).bind(
        next,
        manual ? 1 : 0,
        at,
        ctx.userId,
        connectionId,
        ...bindings,
        jobId,
      ),
    ]);
    if (result[1]?.meta.changes === 1) return { kind: "queued", jobId };
    const existing = await prepare(
      "SELECT id FROM jobs WHERE user_id=? AND connection_id=? AND connection_generation=? AND type='sync' AND status IN ('ready','leased','retry_wait') LIMIT 1",
    )
      .bind(ctx.userId, connectionId, row.generation)
      .first<{ id: string }>();
    return existing
      ? { kind: "queued", jobId: existing.id }
      : { kind: "review-required" };
  }
  const operations: JobStore = {
    enqueue,
    manualSync: (ctx, connectionId) => schedule(ctx, connectionId, true),
    async scheduleDue() {
      let count = 0;
      return stage(scheduleCap, 0, async () => {
        if (remaining() < 8) return 0;
        const window = await page("schedule", 1);
        for (const user of window.users) {
          if (remaining() < 6) break;
          const rows = (
            await prepare(
              `SELECT c.id,c.generation,pc.id AS consent_id,c.next_sync_at,c.manual_sync_at FROM connections c JOIN profiles p ON p.user_id=c.user_id JOIN processing_consents pc ON pc.user_id=c.user_id AND pc.connection_id=c.id WHERE c.user_id=? AND ${connectionConsentLiveSql()} AND pc.accepted_at<=? AND (c.next_sync_at IS NULL OR c.next_sync_at<=?) AND NOT EXISTS(SELECT 1 FROM jobs pending WHERE pending.user_id=c.user_id AND pending.connection_id=c.id AND pending.connection_generation=c.generation AND pending.type='sync' AND pending.status IN ('ready','leased','retry_wait')) ORDER BY c.next_sync_at,c.id,pc.accepted_at DESC,pc.id LIMIT 1`,
            )
              .bind(user.user_id, now(), now())
              .all<EligibleConnection>()
          ).results;
          if (
            rows[0] &&
            (await schedule(context(user.user_id), rows[0].id, false, rows[0]))
              .kind === "queued"
          )
            count++;
          await window.advance(user.user_id);
        }
        return count;
      });
    },
    async candidates() {
      return stage(candidateCap, [] as DispatchCandidate[], async () => {
        if (remaining() < 4) return [];
        const at = now();
        const window = await page(
          "dispatch",
          Math.min(policy.dispatchLimit, 5),
        );
        const groups: DispatchCandidate[][] = [];
        // Queue fill is bounded by dispatch reservations, not active lease slots.
        const perTenantCandidates = Math.min(
          policy.dispatchLimit,
          reservationCap,
        );
        // Three indexed priority branches each fetch at most that reserved bound.
        const branches = [0, 1, 2].map(
          () =>
            "SELECT id FROM (SELECT id FROM jobs WHERE user_id=? AND status IN ('ready','retry_wait') AND priority=? AND dispatch_at<=? ORDER BY dispatch_at,id LIMIT ?)",
        );
        for (const user of window.users) {
          if (remaining() < 2) break;
          const bindings: unknown[] = [];
          for (const priority of [0, 1, 2])
            bindings.push(user.user_id, priority, at, perTenantCandidates);
          const rows = (
            await prepare(
              `SELECT ${columns} FROM jobs WHERE id IN (${branches.join(" UNION ALL ")}) AND ${live} ORDER BY priority,dispatch_at,id LIMIT ?`,
            )
              .bind(...bindings, at, perTenantCandidates)
              .all<Row>()
          ).results;
          groups.push(
            rows.map((row) => ({
              context: context(row.user_id),
              jobId: row.id,
              fence: row.fence,
              dispatchAt: row.dispatch_at,
              dispatchedAt: row.dispatched_at,
            })),
          );
          if (!(await window.advance(user.user_id))) break;
        }
        const output: DispatchCandidate[] = [];
        for (let rank = 0; rank < perTenantCandidates; rank++)
          for (const group of groups) {
            const item = group[rank];
            if (item && output.length < policy.dispatchLimit) output.push(item);
          }
        return output;
      });
    },
    async dispatched(candidate) {
      const at = now();
      return (
        (
          await prepare(
            `UPDATE jobs SET dispatched_at=?,dispatch_at=? WHERE user_id=? AND id=? AND fence=? AND status IN ('ready','retry_wait') AND dispatch_at=? AND dispatched_at IS ? AND ${live}`,
          )
            .bind(
              at,
              at + policy.redeliveryMs,
              candidate.context.userId,
              candidate.jobId,
              candidate.fence,
              candidate.dispatchAt,
              candidate.dispatchedAt,
              at,
            )
            .run()
        ).meta.changes === 1
      );
    },
    async claim(jobId) {
      checkText(jobId);
      const at = now();
      const owner = id();
      // Atomic quotas and lease acquisition; never check capacity then write separately.
      const row = await prepare(
        `UPDATE jobs SET status='leased',lease_id=?,lease_expires_at=?,fence=fence+1,retry_count=retry_count+1 WHERE id=? AND ((status IN ('ready','retry_wait') AND (dispatch_at<=? OR dispatched_at IS NOT NULL)) OR (status='leased' AND lease_expires_at<=?)) AND retry_count<? AND ${live} AND (SELECT COUNT(*) FROM jobs active WHERE active.user_id=jobs.user_id AND active.status='leased' AND active.lease_expires_at>?)<? AND (SELECT COUNT(*) FROM jobs active WHERE active.status='leased' AND active.lease_expires_at>?)<? RETURNING ${columns}`,
      )
        .bind(
          owner,
          at + policy.leaseMs,
          jobId,
          at,
          at,
          policy.maxAttempts,
          at,
          at,
          policy.tenantConcurrency,
          at,
          policy.globalConcurrency,
        )
        .first<Row>();
      if (!row) return null;
      return {
        context: context(row.user_id),
        jobId: row.id,
        connectionId: row.connection_id,
        consentId: row.consent_id,
        generation: row.connection_generation,
        syncStateId: row.sync_state_id,
        type: row.type,
        leaseId: owner,
        fence: row.fence,
        expiresAt: at + policy.leaseMs,
        attempt: row.retry_count,
      };
    },
    async checkpoint(lease) {
      const row = await prepare(
        `SELECT ${options.processingReview ? `${processingSelection} AS processing_selection` : "1"} FROM jobs WHERE user_id=? AND id=? AND status='leased' AND lease_id=? AND fence=? AND lease_expires_at>? AND ${live}`,
      )
        .bind(
          lease.context.userId,
          lease.jobId,
          lease.leaseId,
          lease.fence,
          now(),
          now(),
        )
        .first<{ processing_selection?: string | null }>();
      if (!row) return false;
      if (!options.processingReview) return true;
      if (!row.processing_selection) return false;
      try {
        const selection = processingSelectionSchema.parse(
          JSON.parse(row.processing_selection),
        );
        const current = await options.processingReview(selection);
        return current !== null && current === selection.acceptedDigest;
      } catch {
        // Invalid owned metadata or unavailable review must stop provider work.
        return false;
      }
    },
    async finish(lease, outcome) {
      const at = now();
      const status =
        outcome.kind === "completed"
          ? "completed"
          : outcome.kind === "paused"
            ? outcome.code === "auth"
              ? "paused_auth"
              : "paused_budget"
            : outcome.kind === "terminal" || lease.attempt >= policy.maxAttempts
              ? "terminal"
              : "retry_wait";
      const code =
        outcome.kind === "completed"
          ? "completed"
          : outcome.kind === "retry" && status === "terminal"
            ? "attempts-exhausted"
            : outcome.code;
      if (
        ![
          "completed",
          "budget",
          "auth",
          "handler-unavailable",
          "malformed",
          "unsupported",
          "attempts-exhausted",
          "transient",
          "timeout",
        ].includes(code)
      )
        throw new Error("INVALID_JOB_OUTCOME");
      const retryAfter =
        outcome.kind === "retry" ? outcome.retryAfterMs : undefined;
      if (
        retryAfter !== undefined &&
        (!Number.isSafeInteger(retryAfter) ||
          retryAfter < 0 ||
          retryAfter > 86400000)
      )
        throw new Error("INVALID_JOB_OUTCOME");
      const delay = Math.max(
        retryAfter ?? 0,
        Math.min(300000, 1000 * 2 ** Math.max(0, lease.attempt - 1)),
      );
      if (!Number.isSafeInteger(at + delay))
        throw new Error("INVALID_JOB_OUTCOME");
      return (
        (
          await prepare(
            `UPDATE jobs SET status=?,outcome_code=?,dispatch_at=?,dispatched_at=NULL,lease_id=NULL,lease_expires_at=NULL WHERE user_id=? AND id=? AND status='leased' AND lease_id=? AND fence=? AND lease_expires_at>? AND ${live}`,
          )
            .bind(
              status,
              code,
              at + delay,
              lease.context.userId,
              lease.jobId,
              lease.leaseId,
              lease.fence,
              at,
              at,
            )
            .run()
        ).meta.changes === 1
      );
    },
    async isSettled(jobId) {
      const row = await prepare(
        `SELECT status FROM jobs WHERE id=? AND ${live}`,
      )
        .bind(jobId, now())
        .first<{ status: string }>();
      return (
        !row ||
        [
          "completed",
          "terminal",
          "canceled",
          "paused_budget",
          "paused_auth",
        ].includes(row.status)
      );
    },
    async recover() {
      let count = 0;
      return stage(recoveryCap, 0, async () => {
        const at = now();
        if (remaining() < 2) return 0;
        const expired = (
          await prepare(
            `SELECT ${columns} FROM jobs WHERE status='leased' AND lease_expires_at<=? ORDER BY lease_expires_at,id LIMIT ?`,
          )
            .bind(at, 1)
            .all<Row>()
        ).results;
        for (const row of expired) {
          count += (
            await prepare(
              `UPDATE jobs SET status=CASE WHEN NOT ${live} THEN 'canceled' WHEN retry_count>=? THEN 'terminal' ELSE 'retry_wait' END,outcome_code=CASE WHEN NOT ${live} THEN 'authorization-changed' WHEN retry_count>=? THEN 'attempts-exhausted' ELSE 'lease-expired' END,dispatch_at=?,dispatched_at=NULL,lease_id=NULL,lease_expires_at=NULL WHERE user_id=? AND id=? AND fence=? AND status='leased' AND lease_expires_at<=?`,
            )
              .bind(
                at,
                policy.maxAttempts,
                at,
                policy.maxAttempts,
                at,
                row.user_id,
                row.id,
                row.fence,
                at,
              )
              .run()
          ).meta.changes;
        }
        if (remaining() < (options.processingReview ? 8 : 6)) return count;
        const window = await page("recovery", 1);
        for (const user of window.users) {
          if (remaining() < (options.processingReview ? 6 : 4)) break;
          const rows = (
            await prepare(
              options.processingReview
                ? `SELECT ${recoveryProjectionSql} FROM ${recoveryFromSql} WHERE j.user_id=? AND j.id>? ORDER BY j.id LIMIT 2`
                : "SELECT id FROM jobs WHERE user_id=? AND id>? ORDER BY id LIMIT 2",
            )
              .bind(user.user_id, user.job_recovery_cursor)
              .all<OnboardingRecoveryRow>()
          ).results;
          const ids = rows.map((row) => row.id);
          const decisions = options.processingReview
            ? await reviewRecoveryRows(
                rows,
                options.processingReview,
                options.classification,
              )
            : [];
          if (decisions === null) {
            await window.advance(user.user_id);
            continue;
          }
          if (decisions.length) {
            const statements = buildOnboardingRecoveryStatements(
                prepare,
                user.user_id,
                at,
                decisions,
              ),
              post = recoveredJobsPredicate(decisions, user.user_id, at);
            statements.push(
              prepare(
                `UPDATE profiles SET job_recovery_cursor=? WHERE user_id=? AND job_recovery_cursor=? AND ${post.sql}`,
              ).bind(
                ids.at(-1) ?? "",
                user.user_id,
                user.job_recovery_cursor,
                ...post.values,
              ),
            );
            const result = await batch(statements);
            if (result.at(-1)?.meta.changes === 1)
              count +=
                result[decisions.some((d) => d.row.source_id !== null) ? 1 : 0]
                  ?.meta.changes ?? 0;
          } else {
            const cancel = rows
              .filter((row) => row.source_available !== 0)
              .map((row) => row.id);
            if (cancel.length)
              count += (
                await prepare(
                  `UPDATE jobs SET status='canceled',outcome_code='authorization-changed',lease_id=NULL,lease_expires_at=NULL WHERE user_id=? AND id IN (?,?) AND status IN ('ready','retry_wait','leased') AND NOT ${live}`,
                )
                  .bind(user.user_id, cancel[0], cancel[1] ?? cancel[0], at)
                  .run()
              ).meta.changes;
            await prepare(
              "UPDATE profiles SET job_recovery_cursor=? WHERE user_id=? AND job_recovery_cursor=?",
            )
              .bind(ids.at(-1) ?? "", user.user_id, user.job_recovery_cursor)
              .run();
          }
          await window.advance(user.user_id);
        }
        return count;
      });
    },
  };
  const safe =
    <Arguments extends unknown[], Result>(
      fn: (...args: Arguments) => Promise<Result>,
    ) =>
    async (...args: Arguments) => {
      try {
        return await fn(...args);
      } catch (error) {
        if (error instanceof JobQueryBudgetError) throw error;
        throw new JobStorageError();
      }
    };
  return {
    enqueue: safe(operations.enqueue),
    manualSync: safe(operations.manualSync),
    scheduleDue: safe(operations.scheduleDue),
    candidates: safe(operations.candidates),
    dispatched: safe(operations.dispatched),
    claim: safe(operations.claim),
    checkpoint: safe(operations.checkpoint),
    finish: safe(operations.finish),
    isSettled: safe(operations.isSettled),
    recover: safe(operations.recover),
  };
}
