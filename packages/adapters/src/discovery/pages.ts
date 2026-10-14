import type {
  DiscoveryMetadata,
  DiscoveryPage,
  DiscoveryQueryMode,
  DiscoveryRange,
  JobLease,
  JobOutcome,
  TenantContext,
} from "@invoxim/core";
import { DiscoveryError } from "@invoxim/core";
import { z } from "zod";
import type { DiscoveryServiceOptions } from "./service";

interface State {
  id: string;
  import_run_id: string | null;
  sync_kind: "backfill" | "incremental";
  slice_key: "recent" | "older" | "live";
  stage: string;
  frozen_start: string | null;
  frozen_cutoff: string | null;
  page_token: string | null;
  history_cursor: string | null;
  query_mode: DiscoveryQueryMode;
  discovery_version: number;
  pending_ids: string | null;
  pending_deleted_ids: string | null;
  pending_next_token: string | null;
  pending_history_id: string | null;
  retry_at: number | null;
  recovery_anchor: string | null;
  coverage_code: string;
  consecutive_failures: number;
}
interface Parent {
  id: string;
  frozen_start: string;
  frozen_cutoff: string;
  timezone: string;
}
interface Accepted {
  accepted_configuration_digest?: string;
  disclosure_version: number;
  ai_settings_revision: number;
  query_mode: DiscoveryQueryMode;
  timezone: string;
}
const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) =>
    Array.from(value).every(
      (char) => char.charCodeAt(0) >= 33 && char.charCodeAt(0) <= 126,
    ),
  );
const pageSchema = z
  .object({
    ids: z.array(identifier).max(500),
    deletedIds: z.array(identifier).max(500).optional(),
    nextPageToken: z.string().min(1).max(4096).optional(),
    historyId: z
      .string()
      .regex(/^[0-9]{1,40}$/)
      .optional(),
  })
  .transform((value) => ({
    ids: value.ids,
    ...(value.deletedIds ? { deletedIds: value.deletedIds } : {}),
    ...(value.nextPageToken ? { nextPageToken: value.nextPageToken } : {}),
    ...(value.historyId ? { historyId: value.historyId } : {}),
  }));
const metadataSchema = z.object({
  id: identifier,
  receivedAtMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  available: z.boolean(),
  excluded: z.boolean(),
  candidate: z.enum(["matched", "unknown"]),
});
async function sourceKey(
  userId: string,
  connectionId: string,
  messageId: string,
  generation: number,
) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([userId, connectionId, messageId])),
  );
  return `source:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}:${generation}`;
}
export function createDiscoveryPages(
  db: D1Database,
  options: DiscoveryServiceOptions,
  guards: {
    charge: (count?: number) => void;
    consent: (
      context: TenantContext,
      input: {
        connectionId: string;
        generation: number;
        consentId: string;
        queryMode: DiscoveryQueryMode;
      },
    ) => Promise<Accepted>;
    remainingPageStatements: () => number;
  },
) {
  const clock = options.clock ?? Date.now;
  async function runPage(
    lease: JobLease,
    control: { signal: AbortSignal; checkpoint: () => Promise<boolean> },
  ): Promise<JobOutcome> {
    if (!lease.syncStateId || !["discover", "sync"].includes(lease.type))
      return { kind: "paused", code: "handler-unavailable" };
    const checkpoint = async () => {
      if (control.signal.aborted || !(await control.checkpoint()))
        throw new DiscoveryError("UNAUTHORIZED");
    };
    let diagnosticStage = "state";
    try {
      await checkpoint();
      guards.charge();
      const state = await db
        .prepare(
          "SELECT s.* FROM sync_states s JOIN jobs j ON j.user_id=s.user_id AND j.sync_state_id=s.id WHERE s.user_id=? AND s.id=? AND j.id=? AND j.status='leased' AND j.lease_id=? AND j.fence=? AND j.lease_expires_at>? AND j.connection_id=? AND j.connection_generation=? AND j.consent_id=?",
        )
        .bind(
          lease.context.userId,
          lease.syncStateId,
          lease.jobId,
          lease.leaseId,
          lease.fence,
          clock(),
          lease.connectionId,
          lease.generation,
          lease.consentId,
        )
        .first<State>();
      if (!state) throw new DiscoveryError("UNAUTHORIZED");
      if (state.stage === "waiting_recent")
        throw new DiscoveryError("CONFLICT");
      if (state.stage.startsWith("paused"))
        return { kind: "paused", code: "budget" };
      diagnosticStage = "consent";
      const accepted = await guards.consent(lease.context, {
        connectionId: lease.connectionId,
        generation: lease.generation,
        consentId: lease.consentId,
        queryMode: state.query_mode,
      });
      guards.charge();
      const parent = state.import_run_id
        ? await db
            .prepare(
              "SELECT id,frozen_start,frozen_cutoff,timezone FROM import_runs WHERE user_id=? AND id=? AND connection_id=? AND consent_id=? AND connection_generation=?",
            )
            .bind(
              lease.context.userId,
              state.import_run_id,
              lease.connectionId,
              lease.consentId,
              lease.generation,
            )
            .first<Parent>()
        : await db
            .prepare(
              "SELECT id,frozen_start,frozen_cutoff,timezone FROM import_runs WHERE user_id=? AND connection_id=? AND consent_id=? AND connection_generation=? ORDER BY started_at DESC,id DESC LIMIT 1",
            )
            .bind(
              lease.context.userId,
              lease.connectionId,
              lease.consentId,
              lease.generation,
            )
            .first<Parent>();
      if (!parent) throw new DiscoveryError("UNAUTHORIZED");
      const range: DiscoveryRange = {
        startMs: Date.parse(
          state.sync_kind === "backfill" || state.stage === "recovering"
            ? (state.frozen_start ?? parent.frozen_start)
            : parent.frozen_start,
        ),
        cutoffMs:
          state.sync_kind === "backfill" || state.stage === "recovering"
            ? Date.parse(state.frozen_cutoff ?? parent.frozen_cutoff)
            : clock(),
        timezone: parent.timezone,
      };
      if (state.retry_at !== null && state.retry_at > clock())
        throw new DiscoveryError("CONFLICT");
      await checkpoint();
      diagnosticStage = "provider";
      const provider = await options.providers.open(
        lease.context,
        { connectionId: lease.connectionId, generation: lease.generation },
        control.signal,
      );
      diagnosticStage = "list";
      let page: DiscoveryPage;
      if (state.pending_ids !== null) {
        page = pageSchema.parse({
          ids: JSON.parse(state.pending_ids),
          deletedIds: JSON.parse(state.pending_deleted_ids ?? "[]"),
          ...(state.pending_next_token
            ? { nextPageToken: state.pending_next_token }
            : {}),
          ...(state.pending_history_id
            ? { historyId: state.pending_history_id }
            : {}),
        });
      } else {
        await checkpoint();
        if (state.sync_kind === "incremental" && state.stage !== "recovering") {
          if (!state.history_cursor) throw new DiscoveryError("CONFLICT");
          try {
            page = pageSchema.parse(
              await provider.history({
                historyId: state.history_cursor,
                ...(state.page_token ? { pageToken: state.page_token } : {}),
                signal: control.signal,
              }),
            );
          } catch (cause) {
            if (
              cause instanceof DiscoveryError &&
              cause.code === "HISTORY_EXPIRED"
            ) {
              await checkpoint();
              const anchor = await provider.anchor(control.signal);
              await commit(
                lease,
                state,
                accepted,
                [],
                {
                  ...state,
                  pending_ids: null,
                  pending_deleted_ids: null,
                  pending_next_token: null,
                  pending_history_id: null,
                  page_token: null,
                  stage: "recovering",
                  coverage_code: "recovering_history",
                  frozen_start: parent.frozen_start,
                  frozen_cutoff: new Date(clock()).toISOString(),
                  recovery_anchor: anchor,
                },
                true,
                0,
                true,
              );
              return { kind: "completed" };
            }
            throw cause;
          }
        } else
          page = pageSchema.parse(
            await provider.list({
              range,
              queryMode: state.query_mode,
              ...(state.page_token ? { pageToken: state.page_token } : {}),
              signal: control.signal,
            }),
          );
      }
      if (state.page_token !== null && page.nextPageToken === state.page_token)
        throw new DiscoveryError("UNAVAILABLE");
      const deleted = [...new Set(page.deletedIds ?? [])];
      const deletedSet = new Set(deleted);
      const ids = [...new Set(page.ids)].filter((id) => !deletedSet.has(id));
      if (ids.length + deleted.length > 500)
        throw new DiscoveryError("UNAVAILABLE");
      // Shared headroom includes per-reference checkpoint, final guards and engine settlement.
      const sharedCapacity = Math.floor(
        (options.remainingStatements() - 9) / 6,
      );
      const pageCapacity = Math.floor(
        (guards.remainingPageStatements() - 6) / 5,
      );
      const cap = Math.max(0, Math.min(5, sharedCapacity, pageCapacity));
      if (cap < 1 && ids.length + deleted.length > 0)
        throw new DiscoveryError("UNAVAILABLE");
      const chosenDeleted = deleted.slice(0, cap);
      const chosenIds = ids.slice(0, Math.max(0, cap - chosenDeleted.length));
      const metadata: DiscoveryMetadata[] = chosenDeleted.map((id) => ({
        id,
        receivedAtMs: 0,
        available: false,
        excluded: true,
        candidate: "unknown",
      }));
      diagnosticStage = "metadata";
      for (const id of chosenIds) {
        await checkpoint();
        const reference = metadataSchema.parse(
          await provider.metadata(id, state.query_mode, control.signal),
        );
        if (reference.id !== id) throw new DiscoveryError("UNAVAILABLE");
        metadata.push(reference);
      }
      const remainingDeleted = deleted.slice(chosenDeleted.length),
        remainingIds = ids.slice(chosenIds.length);
      const buffered = remainingDeleted.length + remainingIds.length > 0;
      const providerNext = page.nextPageToken ?? null;
      const terminal = !buffered && providerNext === null;
      let stage =
        buffered || providerNext
          ? "queued"
          : state.sync_kind === "backfill"
            ? "discovery_complete"
            : "idle";
      let history = state.history_cursor;
      let coverage = state.coverage_code;
      let recoveryAnchor = state.recovery_anchor;
      if (state.stage === "recovering") {
        stage = terminal ? "queued" : "recovering";
        if (terminal) {
          history = recoveryAnchor;
          recoveryAnchor = null;
          coverage = "candidate_unknown";
        }
      } else if (state.sync_kind === "incremental" && terminal) {
        if (!page.historyId) throw new DiscoveryError("UNAVAILABLE");
        history = page.historyId;
      }
      const next = {
        ...state,
        stage,
        page_token: buffered ? state.page_token : providerNext,
        history_cursor: history,
        pending_ids: buffered ? JSON.stringify(remainingIds) : null,
        pending_deleted_ids: buffered ? JSON.stringify(remainingDeleted) : null,
        pending_next_token: buffered ? providerNext : null,
        pending_history_id: buffered ? (page.historyId ?? null) : null,
        recovery_anchor: recoveryAnchor,
        coverage_code: coverage,
        frozen_start:
          state.stage === "recovering" && terminal ? null : state.frozen_start,
        frozen_cutoff:
          state.stage === "recovering" && terminal ? null : state.frozen_cutoff,
      };
      await checkpoint();
      await guards.consent(lease.context, {
        connectionId: lease.connectionId,
        generation: lease.generation,
        consentId: lease.consentId,
        queryMode: state.query_mode,
      });
      diagnosticStage = "commit";
      await commit(
        lease,
        state,
        accepted,
        metadata,
        next,
        buffered ||
          providerNext !== null ||
          (state.stage === "recovering" && terminal),
        0,
        false,
        range,
      );
      return { kind: "completed" };
    } catch (cause) {
      if (cause instanceof DiscoveryError) {
        if (cause.code === "UNAUTHORIZED" || cause.code === "AUTH_REQUIRED")
          return { kind: "paused", code: "auth" };
        if (cause.code === "RATE_LIMITED") {
          await deferRate(lease, cause.retryAfterMs ?? 30000);
          return { kind: "completed" };
        }
      }
      console.warn("gmail_discovery_retry", {
        stage: diagnosticStage,
        reason:
          cause instanceof DiscoveryError
            ? cause.code
            : cause instanceof z.ZodError
              ? "INVALID_RESPONSE"
              : cause instanceof Error &&
                  cause.message === "DATABASE_QUERY_BUDGET"
                ? "QUERY_BUDGET"
                : cause instanceof Error &&
                    cause.message.startsWith("D1_ERROR:")
                  ? "DATABASE"
                  : "UNEXPECTED",
      });
      return {
        kind: "retry",
        code: control.signal.aborted ? "timeout" : "transient",
      };
    }
  }
  function guard(
    lease: JobLease,
    state: State,
    accepted: Accepted,
    version = state.discovery_version,
  ) {
    return {
      sql: `EXISTS(SELECT 1 FROM jobs j JOIN connections c ON c.user_id=j.user_id AND c.id=j.connection_id JOIN profiles p ON p.user_id=c.user_id JOIN processing_consents a ON a.user_id=j.user_id AND a.id=j.consent_id AND a.connection_id=j.connection_id WHERE j.user_id=? AND j.id=? AND j.status='leased' AND j.lease_id=? AND j.fence=? AND j.lease_expires_at>? AND c.id=? AND c.generation=? AND c.state='connected' AND c.credential_ciphertext IS NOT NULL AND p.status='active' AND a.id=? AND a.revoked_at IS NULL AND a.background_authorized=1 AND a.accepted_at<=? AND a.disclosure_version=? AND a.ai_settings_revision=? AND a.query_mode=?${accepted.accepted_configuration_digest ? " AND a.accepted_configuration_digest=?" : ""}) AND EXISTS(SELECT 1 FROM sync_states WHERE user_id=? AND id=? AND discovery_version=?)`,
      values: [
        lease.context.userId,
        lease.jobId,
        lease.leaseId,
        lease.fence,
        clock(),
        lease.connectionId,
        lease.generation,
        lease.consentId,
        clock(),
        accepted.disclosure_version,
        accepted.ai_settings_revision,
        state.query_mode,
        ...(accepted.accepted_configuration_digest
          ? [accepted.accepted_configuration_digest]
          : []),
        lease.context.userId,
        state.id,
        version,
      ],
    };
  }
  async function commit(
    lease: JobLease,
    state: State,
    accepted: Accepted,
    metadata: DiscoveryMetadata[],
    next: State,
    continuePage: boolean,
    retryDelay: number,
    reset: boolean,
    range?: DiscoveryRange,
  ) {
    const check = guard(lease, state, accepted);
    const statements: D1PreparedStatement[] = [];
    const add = (
      sql: string,
      values: (string | number | null)[],
      version = state.discovery_version,
    ) => {
      const current =
        version === state.discovery_version
          ? check
          : guard(lease, state, accepted, version);
      statements.push(db.prepare(sql).bind(...values, ...current.values));
    };
    for (const item of metadata) {
      const candidate =
        item.available &&
        !item.excluded &&
        range !== undefined &&
        item.receivedAtMs >= range.startMs &&
        item.receivedAtMs < range.cutoffMs;
      const kind = candidate ? item.candidate : "excluded";
      add(
        `INSERT INTO discovery_seen_refs(user_id,sync_state_id,provider_message_id,candidate_kind) SELECT ?,?,?,? WHERE ${check.sql} ON CONFLICT(user_id,sync_state_id,provider_message_id) DO UPDATE SET candidate_kind=excluded.candidate_kind`,
        [lease.context.userId, state.id, item.id, kind],
      );
      if (!candidate) {
        if (!item.available || item.excluded)
          add(
            `UPDATE source_messages SET available=0 WHERE user_id=? AND connection_id=? AND provider_message_id=? AND ${check.sql}`,
            [lease.context.userId, lease.connectionId, item.id],
          );
        continue;
      }
      add(
        `INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,processing_status,generation,available) SELECT ?,?,?,?,?,'discovered',?,1 WHERE ${check.sql} ON CONFLICT(user_id,connection_id,provider_message_id) DO UPDATE SET available=1,generation=excluded.generation`,
        [
          crypto.randomUUID(),
          lease.context.userId,
          lease.connectionId,
          item.id,
          item.receivedAtMs,
          lease.generation,
        ],
      );
      const dedupe = await sourceKey(
        lease.context.userId,
        lease.connectionId,
        item.id,
        lease.generation,
      );
      const sourceId =
        "(SELECT id FROM source_messages WHERE user_id=? AND connection_id=? AND provider_message_id=?)";
      const sourceValues = [lease.context.userId, lease.connectionId, item.id];
      add(
        `INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,priority) SELECT ?,?,?,?,?,'source-extract',?,'ready',?,? WHERE NOT EXISTS(SELECT 1 FROM jobs initial JOIN discovery_source_jobs original ON original.user_id=initial.user_id AND original.job_id=initial.id WHERE initial.user_id=? AND original.source_message_id=${sourceId} AND initial.type='source-extract' AND substr(initial.dedupe_key,1,7)='source:') AND ${check.sql} ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
        [
          crypto.randomUUID(),
          lease.context.userId,
          lease.connectionId,
          lease.consentId,
          lease.generation,
          dedupe,
          clock(),
          state.slice_key === "older" ? 1 : 0,
          lease.context.userId,
          ...sourceValues,
        ],
      );
      add(
        `INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id) SELECT ?,(SELECT initial.id FROM jobs initial WHERE initial.user_id=? AND initial.connection_id=? AND initial.type='source-extract' AND (initial.dedupe_key=? OR EXISTS(SELECT 1 FROM discovery_source_jobs original WHERE original.user_id=initial.user_id AND original.job_id=initial.id AND original.source_message_id=${sourceId})) ORDER BY initial.connection_generation,initial.id LIMIT 1),${sourceId} WHERE ${check.sql} ON CONFLICT(user_id,job_id) DO NOTHING`,
        [
          lease.context.userId,
          lease.context.userId,
          lease.connectionId,
          dedupe,
          ...sourceValues,
          ...sourceValues,
        ],
      );
      if (state.import_run_id)
        add(
          `INSERT INTO discovery_run_sources(user_id,import_run_id,source_message_id,candidate_kind) SELECT ?,?,${sourceId},? WHERE ${check.sql} ON CONFLICT(user_id,import_run_id,source_message_id) DO NOTHING`,
          [
            lease.context.userId,
            state.import_run_id,
            ...sourceValues,
            item.candidate,
          ],
        );
    }
    if (continuePage)
      add(
        `INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at,priority) SELECT ?,?,?,?,?,?,?,?,'ready',?,? WHERE ${check.sql} ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
        [
          crypto.randomUUID(),
          lease.context.userId,
          lease.connectionId,
          lease.consentId,
          lease.generation,
          state.id,
          state.sync_kind === "incremental" ? "sync" : "discover",
          `discover:${state.id}:${state.discovery_version + 1}`,
          clock() + retryDelay,
          state.slice_key === "older" ? 2 : 0,
        ],
      );
    if (state.slice_key === "recent" && next.stage === "discovery_complete") {
      add(
        `INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at,priority) SELECT ?,?,?,?,?,s.id,'discover','discover:'||s.id||':'||s.discovery_version,'ready',?,2 FROM sync_states s WHERE s.user_id=? AND s.import_run_id=? AND s.slice_key='older' AND s.stage='waiting_recent' AND ${check.sql} ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
        [
          crypto.randomUUID(),
          lease.context.userId,
          lease.connectionId,
          lease.consentId,
          lease.generation,
          clock(),
          lease.context.userId,
          state.import_run_id,
        ],
      );
      add(
        `UPDATE sync_states SET stage='queued' WHERE user_id=? AND import_run_id=? AND slice_key='older' AND stage='waiting_recent' AND ${check.sql}`,
        [lease.context.userId, state.import_run_id],
      );
    }
    add(
      `UPDATE sync_states SET discovery_version=discovery_version+1,page_token=?,history_cursor=?,pending_ids=?,pending_deleted_ids=?,pending_next_token=?,pending_history_id=?,stage=?,coverage_code=?,recovery_anchor=?,frozen_start=?,frozen_cutoff=?,retry_at=?,consecutive_failures=?,history_reset_count=history_reset_count+?,last_discovery_at=?,enumerated_count=(SELECT COUNT(*) FROM discovery_seen_refs WHERE user_id=? AND sync_state_id=?),matched_count=(SELECT COUNT(*) FROM discovery_seen_refs WHERE user_id=? AND sync_state_id=? AND candidate_kind='matched'),unknown_count=(SELECT COUNT(*) FROM discovery_seen_refs WHERE user_id=? AND sync_state_id=? AND candidate_kind='unknown') WHERE user_id=? AND id=? AND discovery_version<9007199254740991 AND ${check.sql}`,
      [
        next.page_token,
        next.history_cursor,
        next.pending_ids,
        next.pending_deleted_ids,
        next.pending_next_token,
        next.pending_history_id,
        next.stage,
        next.coverage_code,
        next.recovery_anchor,
        next.frozen_start,
        next.frozen_cutoff,
        retryDelay ? clock() + retryDelay : null,
        retryDelay ? Math.min(5, state.consecutive_failures + 1) : 0,
        reset ? 1 : 0,
        clock(),
        lease.context.userId,
        state.id,
        lease.context.userId,
        state.id,
        lease.context.userId,
        state.id,
        lease.context.userId,
        state.id,
      ],
    );
    const newer = guard(lease, state, accepted, state.discovery_version + 1);
    if (state.import_run_id)
      add(
        `UPDATE import_runs SET discovered_count=(SELECT COUNT(*) FROM discovery_run_sources WHERE user_id=? AND import_run_id=?),stage=CASE WHEN EXISTS(SELECT 1 FROM sync_states WHERE user_id=? AND import_run_id=? AND stage='paused_rate') THEN 'paused_rate' WHEN EXISTS(SELECT 1 FROM sync_states WHERE user_id=? AND import_run_id=? AND slice_key='recent' AND stage!='discovery_complete') THEN 'discovering_recent' WHEN EXISTS(SELECT 1 FROM sync_states WHERE user_id=? AND import_run_id=? AND slice_key='older' AND stage!='discovery_complete') THEN 'discovering_older' ELSE 'processing_pending' END WHERE user_id=? AND id=? AND ${newer.sql}`,
        [
          lease.context.userId,
          state.import_run_id,
          lease.context.userId,
          state.import_run_id,
          lease.context.userId,
          state.import_run_id,
          lease.context.userId,
          state.import_run_id,
          lease.context.userId,
          state.import_run_id,
        ],
        state.discovery_version + 1,
      );
    add(
      `UPDATE jobs SET status='completed',lease_id=NULL,lease_expires_at=NULL,outcome_code='discovery_staged' WHERE user_id=? AND id=? AND ${newer.sql}`,
      [lease.context.userId, lease.jobId],
      state.discovery_version + 1,
    );
    guards.charge(statements.length);
    await db.batch(statements);
  }
  async function deferRate(lease: JobLease, delay: number) {
    guards.charge();
    const state = await db
      .prepare("SELECT * FROM sync_states WHERE user_id=? AND id=?")
      .bind(lease.context.userId, lease.syncStateId)
      .first<State>();
    if (!state) throw new DiscoveryError("UNAUTHORIZED");
    const accepted = await guards.consent(lease.context, {
      connectionId: lease.connectionId,
      generation: lease.generation,
      consentId: lease.consentId,
      queryMode: state.query_mode,
    });
    const overCap = delay > 86400000;
    const paused = state.consecutive_failures >= 4 || overCap;
    await commit(
      lease,
      state,
      accepted,
      [],
      { ...state, stage: paused ? "paused_rate" : state.stage },
      !paused,
      overCap ? 0 : delay,
      false,
    );
  }
  async function progress(context: TenantContext, importRunId: string) {
    guards.charge();
    const parent = await db
      .prepare(
        "SELECT id,stage,frozen_start,frozen_cutoff,query_mode,first_usable_at FROM import_runs WHERE user_id=? AND id=? AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')",
      )
      .bind(context.userId, importRunId, context.userId)
      .first();
    if (!parent) throw new DiscoveryError("UNAUTHORIZED");
    guards.charge();
    const slices = await db
      .prepare(
        "SELECT slice_key,stage,enumerated_count,matched_count,unknown_count,coverage_code,history_reset_count FROM sync_states WHERE user_id=? AND import_run_id=? ORDER BY CASE slice_key WHEN 'recent' THEN 0 ELSE 1 END",
      )
      .bind(context.userId, importRunId)
      .all<{
        slice_key: string;
        stage: string;
        enumerated_count: number;
        matched_count: number;
        unknown_count: number;
        coverage_code: string;
        history_reset_count: number;
      }>();
    guards.charge();
    const counts = await db
      .prepare(
        "SELECT COUNT(*) AS candidates,SUM(CASE WHEN s.processing_status='processed' THEN 1 ELSE 0 END) AS processed,SUM(CASE WHEN s.processing_status='unsupported' THEN 1 ELSE 0 END) AS unsupported,SUM(CASE WHEN s.processing_status='failed' THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN s.processing_status='review' THEN 1 ELSE 0 END) AS review FROM discovery_run_sources r JOIN source_messages s ON s.user_id=r.user_id AND s.id=r.source_message_id WHERE r.user_id=? AND r.import_run_id=?",
      )
      .bind(context.userId, importRunId)
      .first<{
        candidates: number;
        processed: number | null;
        unsupported: number | null;
        failed: number | null;
        review: number | null;
      }>();
    const discoveryComplete =
      slices.results.length > 0 &&
      slices.results.every((slice) => slice.stage === "discovery_complete");
    const processed = counts?.processed ?? 0,
      unsupported = counts?.unsupported ?? 0,
      failed = counts?.failed ?? 0,
      review = counts?.review ?? 0;
    const processingComplete =
      discoveryComplete &&
      (counts?.candidates ?? 0) === processed + unsupported;
    return {
      importRunId,
      parent,
      slices: slices.results,
      discoveryComplete,
      processingComplete,
      counts: {
        enumerated: slices.results.reduce(
          (total, slice) => total + slice.enumerated_count,
          0,
        ),
        matched: slices.results.reduce(
          (total, slice) => total + slice.matched_count,
          0,
        ),
        unknown: slices.results.reduce(
          (total, slice) => total + slice.unknown_count,
          0,
        ),
        processed,
        unsupported,
        failed,
        review,
      },
    };
  }
  return { runPage, progress };
}
