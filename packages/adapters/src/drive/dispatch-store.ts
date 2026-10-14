import { hasControlCharacters } from "@invoxim/contracts";
import {
  type ArchiveDispatchCandidate,
  type ArchiveDispatchLookup,
  type ArchiveDispatchOutcome,
  type ArchiveDispatchStore,
  type ArchiveDispatchWork,
  ArchiveServiceError,
  type TenantContext,
} from "@invoxim/core";
import { z } from "zod";
import { mailboxScopeSql } from "../pipeline/repository-guards";
import { archiveSafe as safe } from "./boundary";
import { archiveObjectEligibilitySql } from "./objects";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !hasControlCharacters(value));
const integer = z.number().int().safe().nonnegative();
/** D5: mailbox permission on the object's mailbox connection. */
export const archiveMailboxPermissionSql = `EXISTS(SELECT 1 FROM connections mp WHERE mp.user_id=archive_objects.user_id AND mp.id=archive_objects.mailbox_connection_id AND ${mailboxScopeSql("mp")})`;
const eligible = `${archiveObjectEligibilitySql()} AND ${archiveMailboxPermissionSql}`;
const fields = `q.user_id,q.object_id,q.queue_id,q.dispatch_fence,q.failure_count,q.dispatch_at,q.dispatched_at,q.status,archive_objects.fence AS object_fence,archive_objects.state AS object_state,archive_objects.lease_expires_at,(${eligible}) AS allowed,
 EXISTS(SELECT 1 FROM source_messages s WHERE s.user_id=archive_objects.user_id AND s.id=archive_objects.source_message_id AND s.available=1) AS source_available`;
const joined =
  "archive_dispatch q JOIN archive_objects ON archive_objects.user_id=q.user_id AND archive_objects.id=q.object_id";
interface Row {
  user_id: string;
  object_id: string;
  queue_id: string;
  dispatch_fence: number;
  object_fence: number;
  failure_count: number;
  dispatch_at: number;
  dispatched_at: number | null;
  status: string;
  object_state: string;
  lease_expires_at: number;
  allowed: number;
  source_available: number;
}
function work(row: Row): ArchiveDispatchWork {
  for (const value of [row.user_id, row.object_id, row.queue_id])
    if (!identifier.safeParse(value).success)
      throw new ArchiveServiceError("UNAVAILABLE");
  for (const value of [row.dispatch_fence, row.object_fence, row.failure_count])
    if (!integer.safeParse(value).success)
      throw new ArchiveServiceError("UNAVAILABLE");
  return {
    // Private conversion follows an authoritative native-row lookup, never message authority.
    context: { userId: row.user_id, authority: "job" } as TenantContext,
    objectId: row.object_id,
    queueId: row.queue_id,
    dispatchFence: row.dispatch_fence,
    objectFence: row.object_fence,
    failureCount: row.failure_count,
  };
}
/** Delivery metadata only; archive_objects owns the sole execution lease. */
export function createArchiveDispatchStore(
  db: D1Database,
  options: {
    clock?: () => number;
    redeliveryMs?: number;
    retryMs?: number;
    maxFailures?: number;
  } = {},
): ArchiveDispatchStore {
  const clock = options.clock ?? Date.now;
  const redeliveryMs = options.redeliveryMs ?? 60000,
    retryMs = options.retryMs ?? 30000,
    maxFailures = options.maxFailures ?? 3;
  if (
    !integer.min(1).max(3600000).safeParse(redeliveryMs).success ||
    !integer.min(1).max(3600000).safeParse(retryMs).success ||
    !integer.min(1).max(5).safeParse(maxFailures).success
  )
    throw new ArchiveServiceError("INVALID_INPUT");
  function now() {
    const value = clock();
    if (
      !integer
        .max(Number.MAX_SAFE_INTEGER - Math.max(redeliveryMs, retryMs))
        .safeParse(value).success
    )
      throw new ArchiveServiceError("UNAVAILABLE");
    return value;
  }
  function validate(value: ArchiveDispatchWork) {
    if (
      !identifier.safeParse(value.objectId).success ||
      !identifier.safeParse(value.queueId).success ||
      !integer.safeParse(value.dispatchFence).success ||
      !integer.safeParse(value.objectFence).success ||
      !integer.max(5).safeParse(value.failureCount).success
    )
      throw new ArchiveServiceError("INVALID_INPUT");
  }
  async function enqueue(...args: Parameters<ArchiveDispatchStore["enqueue"]>) {
    const [context, objectId, queueId, runId] = args;
    if (
      ![objectId, queueId].every((id) => identifier.safeParse(id).success) ||
      (runId !== undefined && !identifier.safeParse(runId).success)
    )
      throw new ArchiveServiceError("INVALID_INPUT");
    const result = await db
      .prepare(
        `INSERT INTO archive_dispatch(user_id,object_id,queue_id,status,dispatch_at,backfill_run_id)
      SELECT archive_objects.user_id,archive_objects.id,?,'ready',?,? FROM archive_objects WHERE archive_objects.user_id=? AND archive_objects.id=? AND archive_objects.state='pending' AND ${eligible}
      AND (? IS NULL OR EXISTS(SELECT 1 FROM archive_backfill_runs r JOIN archive_backfill_items i ON i.user_id=r.user_id AND i.run_id=r.id WHERE r.user_id=archive_objects.user_id AND r.id=? AND i.document_id=archive_objects.document_id AND r.state='pending' AND r.settings_version=archive_objects.settings_version AND r.connection_id=archive_objects.storage_connection_id AND r.storage_generation=archive_objects.storage_generation AND r.storage_subject=archive_objects.storage_subject))
      ON CONFLICT(user_id,object_id) DO NOTHING`,
      )
      .bind(
        queueId,
        now(),
        runId ?? null,
        context.userId,
        objectId,
        runId ?? null,
        runId ?? null,
      )
      .run();
    return result.meta.changes === 1;
  }
  async function load(queueId: string): Promise<ArchiveDispatchLookup> {
    if (!identifier.safeParse(queueId).success)
      throw new ArchiveServiceError("INVALID_INPUT");
    const row = await db
      .prepare(`SELECT ${fields} FROM ${joined} WHERE q.queue_id=?`)
      .bind(queueId)
      .first<Row>();
    if (!row) return { kind: "missing" };
    if (row.object_state === "archived") return { kind: "completed" };
    if (
      row.allowed !== 1 ||
      ["paused", "canceled", "completed"].includes(row.status)
    )
      return { kind: "blocked" };
    const time = now();
    if (row.lease_expires_at > time || row.dispatch_at > time)
      return { kind: "busy" };
    return { kind: "ready", work: work(row) };
  }
  async function due(limit: number): Promise<ArchiveDispatchCandidate[]> {
    if (!integer.min(1).max(50).safeParse(limit).success)
      throw new ArchiveServiceError("INVALID_INPUT");
    const time = now();
    const rows = await db
      .prepare(
        `SELECT ${fields} FROM (SELECT * FROM archive_dispatch WHERE status IN ('ready','retry_wait') AND dispatch_at<=? AND (dispatched_at IS NULL OR dispatched_at<=?)
        ORDER BY dispatch_at,queue_id LIMIT ?) q JOIN archive_objects ON archive_objects.user_id=q.user_id AND archive_objects.id=q.object_id ORDER BY q.dispatch_at,q.queue_id`,
      )
      .bind(time, Math.max(0, time - redeliveryMs), limit)
      .all<Row>();
    const candidates: ArchiveDispatchCandidate[] = [];
    const retire: D1PreparedStatement[] = [];
    for (const row of rows.results) {
      if (
        row.object_state !== "pending" ||
        row.allowed !== 1 ||
        row.dispatch_fence >= Number.MAX_SAFE_INTEGER
      ) {
        retire.push(
          db
            .prepare(
              `UPDATE archive_dispatch SET status=?,outcome_code=?,dispatched_at=NULL WHERE user_id=? AND object_id=? AND queue_id=? AND dispatch_fence=? AND dispatched_at IS ? AND status IN ('ready','retry_wait')
          AND EXISTS(SELECT 1 FROM archive_objects WHERE archive_objects.user_id=archive_dispatch.user_id AND archive_objects.id=archive_dispatch.object_id AND archive_objects.fence=? AND (archive_objects.state='archived' OR NOT (${eligible}) OR archive_dispatch.dispatch_fence>=9007199254740991))`,
            )
            .bind(
              row.object_state === "archived" ? "completed" : "paused",
              row.object_state === "archived"
                ? "completed"
                : row.source_available !== 1
                  ? "source_missing"
                  : "conflict",
              row.user_id,
              row.object_id,
              row.queue_id,
              row.dispatch_fence,
              row.dispatched_at,
              row.object_fence,
            ),
        );
      } else if (row.lease_expires_at <= time) {
        candidates.push({
          ...work(row),
          dispatchAt: row.dispatch_at,
          dispatchedAt: row.dispatched_at,
        });
      }
    }
    if (retire.length) await db.batch(retire);
    return candidates;
  }
  async function reserve(
    candidate: ArchiveDispatchCandidate,
  ): Promise<ArchiveDispatchWork | null> {
    validate(candidate);
    if (
      !integer.safeParse(candidate.dispatchAt).success ||
      (candidate.dispatchedAt !== null &&
        !integer.safeParse(candidate.dispatchedAt).success)
    )
      throw new ArchiveServiceError("INVALID_INPUT");
    const time = now();
    const row = await db
      .prepare(
        `UPDATE archive_dispatch SET dispatched_at=?,dispatch_fence=dispatch_fence+1 WHERE user_id=? AND object_id=? AND queue_id=? AND dispatch_fence=? AND dispatch_at=? AND dispatched_at IS ?
      AND status IN ('ready','retry_wait') AND dispatch_at<=? AND (dispatched_at IS NULL OR dispatched_at<=?) AND dispatch_fence<9007199254740991
      AND EXISTS(SELECT 1 FROM archive_objects WHERE archive_objects.user_id=archive_dispatch.user_id AND archive_objects.id=archive_dispatch.object_id AND archive_objects.state='pending' AND archive_objects.fence=? AND archive_objects.lease_expires_at<=? AND ${eligible}) RETURNING dispatch_fence`,
      )
      .bind(
        time,
        candidate.context.userId,
        candidate.objectId,
        candidate.queueId,
        candidate.dispatchFence,
        candidate.dispatchAt,
        candidate.dispatchedAt,
        time,
        Math.max(0, time - redeliveryMs),
        candidate.objectFence,
        time,
      )
      .first<{ dispatch_fence: number }>();
    return row ? { ...candidate, dispatchFence: row.dispatch_fence } : null;
  }
  async function settle(
    value: ArchiveDispatchWork,
    outcome: ArchiveDispatchOutcome,
  ) {
    validate(value);
    let status: string,
      code: string,
      failures = value.failureCount;
    switch (outcome.kind) {
      case "completed":
        status = "completed";
        code = "completed";
        failures = 0;
        break;
      case "deferred":
        status = "retry_wait";
        code = outcome.code;
        break;
      case "retry":
        failures = Math.min(5, failures + 1);
        status = failures >= maxFailures ? "paused" : "retry_wait";
        code = "transient";
        break;
      case "paused":
        status = "paused";
        code = outcome.code;
        break;
      case "terminal":
        status = "paused";
        code = outcome.code;
        break;
    }
    const parent =
      outcome.kind === "completed"
        ? "archive_objects.state='archived' AND EXISTS(SELECT 1 FROM profiles p WHERE p.user_id=archive_objects.user_id AND p.status='active')"
        : `archive_objects.state='pending' AND ${eligible}`;
    const result = await db
      .prepare(
        `UPDATE archive_dispatch SET status=?,outcome_code=?,failure_count=?,dispatch_at=?,dispatched_at=NULL WHERE user_id=? AND object_id=? AND queue_id=? AND dispatch_fence=? AND failure_count=? AND dispatched_at IS NOT NULL AND status IN ('ready','retry_wait')
      AND EXISTS(SELECT 1 FROM archive_objects WHERE archive_objects.user_id=archive_dispatch.user_id AND archive_objects.id=archive_dispatch.object_id AND archive_objects.fence=? AND archive_objects.lease_id IS NULL AND archive_objects.lease_expires_at=0 AND ${parent})`,
      )
      .bind(
        status,
        code,
        failures,
        now() + retryMs,
        value.context.userId,
        value.objectId,
        value.queueId,
        value.dispatchFence,
        value.failureCount,
        value.objectFence,
      )
      .run();
    return result.meta.changes === 1;
  }
  return {
    enqueue: (...args) => safe(() => enqueue(...args)),
    load: (id) => safe(() => load(id)),
    due: (limit) => safe(() => due(limit)),
    reserve: (candidate) => safe(() => reserve(candidate)),
    settle: (value, outcome) => safe(() => settle(value, outcome)),
  };
}
