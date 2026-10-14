import type { JobLease, JobOutcome } from "@invoxim/core";
import { DiscoveryError } from "@invoxim/core";
import { z } from "zod";
import { sourceKey } from "../hash";
import type { OutlookGraphDiscoveryPort } from "./outlook";
import {
  validateOutlookContinuation,
  validateOutlookId,
} from "./outlook-transport";
import { initialSourceJobAbsentSql, initialSourceJobSql } from "./source-jobs";

interface ParentState {
  id: string;
  import_run_id: string | null;
  run_key: string;
  slice_key: "recent" | "older" | "live";
  sync_kind: "backfill" | "incremental";
  stage: string;
  frozen_start: string | null;
  frozen_cutoff: string | null;
  discovery_version: number;
}
interface FolderState {
  id: string;
  folder_id: string;
  discovery_version: number;
  page_token: string | null;
  history_cursor: string | null;
  stage: string;
  history_reset_count: number;
  consecutive_failures: number;
  retry_at: number | null;
  frozen_start: string | null;
  frozen_cutoff: string | null;
}
const pageSchema = z.object({
  ids: z.array(z.string()).max(5),
  folderRemovedIds: z.array(z.string()).max(5),
  nextLink: z.string().optional(),
  deltaLink: z.string().optional(),
});
const metadataSchema = z.object({
  id: z.string(),
  parentFolderId: z.string().nullable(),
  receivedAtMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  available: z.boolean(),
  excluded: z.boolean(),
  candidate: z.enum(["matched", "unknown"]),
});
const excludedTreeSql = `WITH RECURSIVE excluded(folder_id) AS (SELECT value FROM json_each((SELECT excluded_folder_ids FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND scope_key='root')) UNION SELECT f.folder_id FROM outlook_folders f JOIN excluded e ON f.parent_folder_id=e.folder_id WHERE f.user_id=? AND f.connection_id=? AND f.generation=?)`;
function exclusionOwner(lease: JobLease) {
  return [
    lease.context.userId,
    lease.connectionId,
    lease.generation,
    lease.context.userId,
    lease.connectionId,
    lease.generation,
  ];
}
function guard(lease: JobLease, now: number) {
  return {
    sql: `EXISTS(SELECT 1 FROM jobs j JOIN connections c ON c.user_id=j.user_id AND c.id=j.connection_id JOIN profiles p ON p.user_id=j.user_id JOIN processing_consents pc ON pc.user_id=j.user_id AND pc.id=j.consent_id AND pc.connection_id=j.connection_id WHERE j.user_id=? AND j.id=? AND j.connection_id=? AND j.consent_id=? AND j.connection_generation=? AND j.sync_state_id=? AND j.status='leased' AND j.lease_id=? AND j.fence=? AND j.lease_expires_at>? AND j.type IN ('discover','sync') AND c.provider='outlook' AND c.kind='mailbox' AND c.state='connected' AND c.scheduling_state='active' AND c.generation=j.connection_generation AND p.status='active' AND pc.revoked_at IS NULL AND pc.background_authorized=1 AND pc.accepted_at<=? AND pc.ai_settings_revision=COALESCE((SELECT a.revision FROM ai_settings a WHERE a.user_id=p.user_id AND a.status='active'),0) AND EXISTS(SELECT 1 FROM json_each(c.scopes) WHERE value='https://graph.microsoft.com/Mail.Read'))`,
    values: [
      lease.context.userId,
      lease.jobId,
      lease.connectionId,
      lease.consentId,
      lease.generation,
      lease.syncStateId,
      lease.leaseId,
      lease.fence,
      now,
      now,
    ],
  };
}
export function createOutlookDeltaRunner(
  db: D1Database,
  options: { remainingStatements: () => number; clock?: () => number },
) {
  const clock = options.clock ?? Date.now;
  async function advanceParent(
    lease: JobLease,
    control: { signal: AbortSignal; checkpoint: () => Promise<boolean> },
    parent: ParentState,
  ): Promise<JobOutcome> {
    if (control.signal.aborted || !(await control.checkpoint()))
      return { kind: "paused", code: "auth" };
    const missing = await db
      .prepare(
        `${excludedTreeSql} SELECT f.folder_id FROM outlook_folders f WHERE f.user_id=? AND f.connection_id=? AND f.generation=? AND f.folder_id NOT IN (SELECT folder_id FROM excluded) AND NOT EXISTS(SELECT 1 FROM sync_states child WHERE child.user_id=f.user_id AND child.connection_id=f.connection_id AND child.scope_key='outlook:'||f.generation||':'||f.folder_id AND child.run_key=? AND child.slice_key=? AND child.sync_kind=?) ORDER BY f.folder_id LIMIT 1`,
      )
      .bind(
        ...exclusionOwner(lease),
        lease.context.userId,
        lease.connectionId,
        lease.generation,
        parent.run_key,
        parent.slice_key,
        parent.sync_kind,
      )
      .first();
    const paused = !missing
      ? await db
          .prepare(
            `${excludedTreeSql} SELECT 1 FROM sync_states child JOIN outlook_folders f ON f.user_id=child.user_id AND f.connection_id=child.connection_id AND f.generation=? AND child.scope_key='outlook:'||f.generation||':'||f.folder_id WHERE child.user_id=? AND child.connection_id=? AND child.run_key=? AND child.slice_key=? AND child.sync_kind=? AND child.stage='paused_rate' AND f.folder_id NOT IN (SELECT folder_id FROM excluded) LIMIT 1`,
          )
          .bind(
            ...exclusionOwner(lease),
            lease.generation,
            lease.context.userId,
            lease.connectionId,
            parent.run_key,
            parent.slice_key,
            parent.sync_kind,
          )
          .first()
      : null;
    const restart =
      !missing &&
      !paused &&
      parent.sync_kind === "incremental" &&
      parent.stage === "idle"
        ? await db
            .prepare(
              `${excludedTreeSql} SELECT 1 FROM sync_states child JOIN outlook_folders f ON f.user_id=child.user_id AND f.connection_id=child.connection_id AND f.generation=? AND child.scope_key='outlook:'||f.generation||':'||f.folder_id WHERE child.user_id=? AND child.connection_id=? AND child.run_key=? AND child.slice_key='live' AND child.sync_kind='incremental' AND child.stage='idle' AND f.folder_id NOT IN (SELECT folder_id FROM excluded) LIMIT 1`,
            )
            .bind(
              ...exclusionOwner(lease),
              lease.generation,
              lease.context.userId,
              lease.connectionId,
              parent.run_key,
            )
            .first()
        : null;
    const older =
      !missing &&
      !restart &&
      !paused &&
      parent.slice_key === "recent" &&
      parent.import_run_id
        ? await db
            .prepare(
              "SELECT id FROM sync_states WHERE user_id=? AND connection_id=? AND import_run_id=? AND scope_key='mailbox' AND sync_kind='backfill' AND slice_key='older' AND stage='waiting_recent'",
            )
            .bind(
              lease.context.userId,
              lease.connectionId,
              parent.import_run_id,
            )
            .first<{ id: string }>()
        : null;
    if (control.signal.aborted || !(await control.checkpoint()))
      return { kind: "paused", code: "auth" };
    if (options.remainingStatements() < 6)
      return { kind: "retry", code: "transient" };
    const now = clock();
    const nonce = crypto.randomUUID();
    const leaseGuard = guard(lease, now);
    const marker =
      "EXISTS(SELECT 1 FROM sync_states parent WHERE parent.user_id=? AND parent.id=? AND parent.discovery_version=? AND parent.pending_history_id=?)";
    const markerValues = [
      lease.context.userId,
      parent.id,
      parent.discovery_version + 1,
      nonce,
    ];
    const continuationKey = `outlook:page:${lease.jobId}`;
    const continuePage = Boolean(missing || restart || older);
    const nextStage = paused
      ? "paused_rate"
      : missing || restart
        ? "queued"
        : parent.sync_kind === "backfill"
          ? "discovery_complete"
          : "idle";
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `UPDATE sync_states SET discovery_version=discovery_version+1,stage=?,pending_history_id=?,last_discovery_at=? WHERE user_id=? AND id=? AND connection_id=? AND discovery_version=? AND ${leaseGuard.sql}`,
        )
        .bind(
          nextStage,
          nonce,
          now,
          lease.context.userId,
          parent.id,
          lease.connectionId,
          parent.discovery_version,
          ...leaseGuard.values,
        ),
    ];
    if (missing)
      statements.push(
        db
          .prepare(
            `${excludedTreeSql} INSERT INTO sync_states(id,user_id,connection_id,import_run_id,scope_key,sync_kind,run_key,slice_key,frozen_start,frozen_cutoff,stage,query_mode,coverage_code) SELECT lower(hex(randomblob(16))),f.user_id,f.connection_id,?,('outlook:'||f.generation||':'||f.folder_id),?,?,?,?,?,'queued','filtered','candidate_unknown' FROM outlook_folders f WHERE f.user_id=? AND f.connection_id=? AND f.generation=? AND f.folder_id NOT IN (SELECT folder_id FROM excluded) AND ${marker} AND ${leaseGuard.sql} AND NOT EXISTS(SELECT 1 FROM sync_states existing WHERE existing.user_id=f.user_id AND existing.connection_id=f.connection_id AND existing.scope_key='outlook:'||f.generation||':'||f.folder_id AND existing.run_key=? AND existing.slice_key=? AND existing.sync_kind=?) ORDER BY f.folder_id LIMIT 5`,
          )
          .bind(
            ...exclusionOwner(lease),
            parent.import_run_id,
            parent.sync_kind,
            parent.run_key,
            parent.slice_key,
            parent.frozen_start,
            parent.frozen_cutoff,
            lease.context.userId,
            lease.connectionId,
            lease.generation,
            ...markerValues,
            ...leaseGuard.values,
            parent.run_key,
            parent.slice_key,
            parent.sync_kind,
          ),
      );
    if (restart)
      statements.push(
        db
          .prepare(
            `${excludedTreeSql} UPDATE sync_states SET stage='queued' WHERE user_id=? AND connection_id=? AND run_key=? AND slice_key='live' AND sync_kind='incremental' AND scope_key IN (SELECT 'outlook:'||f.generation||':'||f.folder_id FROM outlook_folders f WHERE f.user_id=? AND f.connection_id=? AND f.generation=? AND f.folder_id NOT IN (SELECT folder_id FROM excluded)) AND stage='idle' AND ${marker} AND ${leaseGuard.sql}`,
          )
          .bind(
            ...exclusionOwner(lease),
            lease.context.userId,
            lease.connectionId,
            parent.run_key,
            lease.context.userId,
            lease.connectionId,
            lease.generation,
            ...markerValues,
            ...leaseGuard.values,
          ),
      );
    if (older)
      statements.push(
        db
          .prepare(
            `UPDATE sync_states SET stage='queued' WHERE user_id=? AND id=? AND stage='waiting_recent' AND ${marker} AND ${leaseGuard.sql}`,
          )
          .bind(
            lease.context.userId,
            older.id,
            ...markerValues,
            ...leaseGuard.values,
          ),
      );
    if (continuePage)
      statements.push(
        db
          .prepare(
            `INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at,priority) SELECT ?,?,?,?,?,?,?,?,'ready',?,? WHERE ${marker} AND ${leaseGuard.sql} ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
          )
          .bind(
            crypto.randomUUID(),
            lease.context.userId,
            lease.connectionId,
            lease.consentId,
            lease.generation,
            older?.id ?? lease.syncStateId,
            older ? "discover" : lease.type,
            continuationKey,
            now,
            older ? 2 : parent.slice_key === "older" ? 2 : 0,
            ...markerValues,
            ...leaseGuard.values,
          ),
      );
    if (parent.import_run_id && !missing && !restart && !paused)
      statements.push(
        db
          .prepare(
            `UPDATE import_runs SET stage=? WHERE user_id=? AND id=? AND connection_id=? AND ${marker} AND ${leaseGuard.sql}`,
          )
          .bind(
            older ? "discovering_older" : "processing_pending",
            lease.context.userId,
            parent.import_run_id,
            lease.connectionId,
            ...markerValues,
            ...leaseGuard.values,
          ),
      );
    statements.push(
      db
        .prepare(
          `UPDATE jobs SET status='completed',lease_id=NULL,lease_expires_at=NULL,outcome_code='discovery_staged' WHERE user_id=? AND id=? AND ${marker} AND ${leaseGuard.sql}${continuePage ? " AND EXISTS(SELECT 1 FROM jobs continuation WHERE continuation.user_id=? AND continuation.dedupe_key=? AND continuation.status='ready')" : ""}`,
        )
        .bind(
          lease.context.userId,
          lease.jobId,
          ...markerValues,
          ...leaseGuard.values,
          ...(continuePage ? [lease.context.userId, continuationKey] : []),
        ),
    );
    await db.batch(statements);
    const settled = await db
      .prepare(
        "SELECT status FROM jobs WHERE user_id=? AND id=? AND status='completed'",
      )
      .bind(lease.context.userId, lease.jobId)
      .first();
    return settled
      ? { kind: "completed" }
      : { kind: "retry", code: "transient" };
  }
  async function resetExpired(
    lease: JobLease,
    control: { signal: AbortSignal; checkpoint: () => Promise<boolean> },
    folder: FolderState,
  ): Promise<JobOutcome> {
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
    if (options.remainingStatements() < 5)
      return { kind: "retry", code: "transient" };
    const now = clock();
    const nonce = crypto.randomUUID();
    const leaseGuard = guard(lease, now);
    const marker =
      "EXISTS(SELECT 1 FROM sync_states child WHERE child.user_id=? AND child.id=? AND child.discovery_version=? AND child.pending_history_id=?)";
    const markerValues = [
      lease.context.userId,
      folder.id,
      folder.discovery_version + 1,
      nonce,
    ];
    const continuationKey = `outlook:page:${lease.jobId}`;
    await db.batch([
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
      db
        .prepare(
          `INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at,priority) SELECT ?,?,?,?,?,?,?,?,'ready',?,0 WHERE ${marker} AND ${leaseGuard.sql} ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          lease.context.userId,
          lease.connectionId,
          lease.consentId,
          lease.generation,
          lease.syncStateId,
          lease.type,
          continuationKey,
          now,
          ...markerValues,
          ...leaseGuard.values,
        ),
      db
        .prepare(
          `UPDATE jobs SET status='completed',lease_id=NULL,lease_expires_at=NULL,outcome_code='discovery_staged' WHERE user_id=? AND id=? AND ${marker} AND ${leaseGuard.sql} AND EXISTS(SELECT 1 FROM jobs continuation WHERE continuation.user_id=? AND continuation.dedupe_key=? AND continuation.status='ready')`,
        )
        .bind(
          lease.context.userId,
          lease.jobId,
          ...markerValues,
          ...leaseGuard.values,
          lease.context.userId,
          continuationKey,
        ),
    ]);
    const settled = await db
      .prepare(
        "SELECT status FROM jobs WHERE user_id=? AND id=? AND status='completed'",
      )
      .bind(lease.context.userId, lease.jobId)
      .first();
    return settled
      ? { kind: "completed" }
      : { kind: "retry", code: "transient" };
  }
  async function deferFolderRate(
    lease: JobLease,
    control: { signal: AbortSignal; checkpoint: () => Promise<boolean> },
    folder: FolderState,
    delayMs: number,
    countFailure = true,
  ): Promise<JobOutcome> {
    if (control.signal.aborted || !(await control.checkpoint()))
      return { kind: "paused", code: "auth" };
    if (options.remainingStatements() < 5)
      return { kind: "retry", code: "transient" };
    const now = clock();
    const delay = Number.isFinite(delayMs) ? Math.max(1000, delayMs) : 86400001;
    const paused =
      delay > 86400000 || (countFailure && folder.consecutive_failures >= 4);
    const retryAt = paused
      ? null
      : countFailure
        ? now + delay
        : folder.retry_at;
    const nonce = crypto.randomUUID();
    const leaseGuard = guard(lease, now);
    const marker =
      "EXISTS(SELECT 1 FROM sync_states child WHERE child.user_id=? AND child.id=? AND child.discovery_version=? AND child.pending_history_id=?)";
    const markerValues = [
      lease.context.userId,
      folder.id,
      folder.discovery_version + 1,
      nonce,
    ];
    const continuationKey = `outlook:page:${lease.jobId}`;
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `UPDATE sync_states SET discovery_version=discovery_version+1,stage=?,retry_at=?,consecutive_failures=consecutive_failures+?,pending_history_id=? WHERE user_id=? AND id=? AND connection_id=? AND discovery_version=? AND ${leaseGuard.sql}`,
        )
        .bind(
          paused ? "paused_rate" : folder.stage,
          retryAt,
          countFailure ? 1 : 0,
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
        db
          .prepare(
            `INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at,priority) SELECT ?,?,?,?,?,?,?,?,'ready',?,0 WHERE ${marker} AND ${leaseGuard.sql} ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
          )
          .bind(
            crypto.randomUUID(),
            lease.context.userId,
            lease.connectionId,
            lease.consentId,
            lease.generation,
            lease.syncStateId,
            lease.type,
            continuationKey,
            retryAt,
            ...markerValues,
            ...leaseGuard.values,
          ),
      );
    statements.push(
      db
        .prepare(
          `UPDATE jobs SET status='completed',lease_id=NULL,lease_expires_at=NULL,outcome_code=? WHERE user_id=? AND id=? AND ${marker} AND ${leaseGuard.sql}${paused ? "" : " AND EXISTS(SELECT 1 FROM jobs continuation WHERE continuation.user_id=? AND continuation.dedupe_key=? AND continuation.status='ready')"}`,
        )
        .bind(
          paused ? "rate_paused" : "rate_deferred",
          lease.context.userId,
          lease.jobId,
          ...markerValues,
          ...leaseGuard.values,
          ...(paused ? [] : [lease.context.userId, continuationKey]),
        ),
    );
    await db.batch(statements);
    const settled = await db
      .prepare(
        "SELECT status FROM jobs WHERE user_id=? AND id=? AND status='completed'",
      )
      .bind(lease.context.userId, lease.jobId)
      .first();
    return settled
      ? { kind: "completed" }
      : { kind: "retry", code: "transient" };
  }
  return {
    async run(
      lease: JobLease,
      control: { signal: AbortSignal; checkpoint: () => Promise<boolean> },
      provider: OutlookGraphDiscoveryPort,
    ): Promise<JobOutcome> {
      if (!lease.syncStateId)
        return { kind: "paused", code: "handler-unavailable" };
      const now = clock();
      const exclusions = await db
        .prepare(
          "SELECT excluded_folder_ids FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND scope_key='root' AND state='complete'",
        )
        .bind(lease.context.userId, lease.connectionId, lease.generation)
        .first<{ excluded_folder_ids: string | null }>();
      if (!exclusions?.excluded_folder_ids)
        return { kind: "paused", code: "auth" };
      const parent = await db
        .prepare(
          "SELECT id,import_run_id,run_key,slice_key,sync_kind,stage,frozen_start,frozen_cutoff,discovery_version FROM sync_states WHERE user_id=? AND id=? AND connection_id=? AND scope_key='mailbox'",
        )
        .bind(lease.context.userId, lease.syncStateId, lease.connectionId)
        .first<ParentState>();
      if (!parent || parent.stage === "waiting_recent")
        return { kind: "paused", code: "auth" };
      const approved =
        parent.sync_kind === "incremental"
          ? await db
              .prepare(
                "SELECT frozen_start FROM import_runs WHERE user_id=? AND connection_id=? AND consent_id=? AND connection_generation=? ORDER BY started_at DESC,id DESC LIMIT 1",
              )
              .bind(
                lease.context.userId,
                lease.connectionId,
                lease.consentId,
                lease.generation,
              )
              .first<{ frozen_start: string }>()
          : null;
      if (parent.sync_kind === "incremental" && !approved)
        return { kind: "paused", code: "auth" };
      const approvedStartMs = Date.parse(
        approved?.frozen_start ?? parent.frozen_start ?? "",
      );
      if (!Number.isSafeInteger(approvedStartMs) || approvedStartMs < 0)
        return { kind: "terminal", code: "malformed" };
      const folder = await db
        .prepare(
          `${excludedTreeSql} SELECT s.id,f.folder_id,s.discovery_version,s.page_token,s.history_cursor,s.stage,s.history_reset_count,s.consecutive_failures,s.retry_at,s.frozen_start,s.frozen_cutoff FROM sync_states s JOIN outlook_folders f ON f.user_id=s.user_id AND f.connection_id=s.connection_id AND f.generation=? AND s.scope_key='outlook:'||f.generation||':'||f.folder_id WHERE s.user_id=? AND s.connection_id=? AND s.run_key=? AND s.slice_key=? AND s.sync_kind=? AND s.stage IN ('queued','recovering','recovering_delta') AND f.folder_id NOT IN (SELECT folder_id FROM excluded) ORDER BY f.folder_id LIMIT 1`,
        )
        .bind(
          ...exclusionOwner(lease),
          lease.generation,
          lease.context.userId,
          lease.connectionId,
          parent.run_key,
          parent.slice_key,
          parent.sync_kind,
        )
        .first<FolderState>();
      if (!folder) return advanceParent(lease, control, parent);
      if (folder.retry_at !== null && folder.retry_at > now)
        return deferFolderRate(
          lease,
          control,
          folder,
          folder.retry_at - now,
          false,
        );
      if (options.remainingStatements() < 16)
        return { kind: "retry", code: "transient" };
      if (control.signal.aborted || !(await control.checkpoint()))
        return { kind: "paused", code: "auth" };
      const continuation = folder.page_token ?? folder.history_cursor;
      const listing =
        parent.sync_kind === "backfill" || folder.stage === "recovering";
      let received: z.infer<typeof pageSchema>;
      try {
        received = listing
          ? await provider
              .listFolder({
                folderId: folder.folder_id,
                range: {
                  startMs: Date.parse(
                    folder.frozen_start ?? parent.frozen_start ?? "",
                  ),
                  cutoffMs: Date.parse(
                    folder.frozen_cutoff ?? parent.frozen_cutoff ?? "",
                  ),
                  timezone: "UTC",
                },
                ...(folder.page_token ? { nextLink: folder.page_token } : {}),
                signal: control.signal,
              })
              .then((value) => ({ ...value, folderRemovedIds: [] }))
          : await provider.deltaFolder({
              folderId: folder.folder_id,
              ...(continuation ? { continuationLink: continuation } : {}),
              signal: control.signal,
            });
      } catch (cause) {
        if (cause instanceof DiscoveryError && cause.code === "HISTORY_EXPIRED")
          return resetExpired(lease, control, folder);
        if (cause instanceof DiscoveryError && cause.code === "RATE_LIMITED")
          return deferFolderRate(
            lease,
            control,
            folder,
            cause.retryAfterMs ?? 30000,
          );
        throw cause;
      }
      const page = pageSchema.parse(received);
      if (control.signal.aborted || !(await control.checkpoint()))
        return { kind: "paused", code: "auth" };
      if (page.ids.length + page.folderRemovedIds.length > 5)
        throw new DiscoveryError("UNAVAILABLE");
      const ids = [...new Set(page.ids.map(validateOutlookId))];
      const removed = [
        ...new Set(page.folderRemovedIds.map(validateOutlookId)),
      ];
      const scope = listing
        ? {
            kind: "messages" as const,
            folderId: folder.folder_id,
            filter: `receivedDateTime ge ${new Date(folder.frozen_start ?? parent.frozen_start ?? "").toISOString()} and receivedDateTime lt ${new Date(folder.frozen_cutoff ?? parent.frozen_cutoff ?? "").toISOString()}`,
          }
        : { kind: "delta" as const, folderId: folder.folder_id };
      const nextLink = page.nextLink
        ? validateOutlookContinuation(page.nextLink, scope, "next")
        : null;
      const deltaLink = page.deltaLink
        ? validateOutlookContinuation(
            page.deltaLink,
            { kind: "delta", folderId: folder.folder_id },
            "delta",
          )
        : null;
      if (
        (nextLink !== null && nextLink === continuation) ||
        (nextLink === null && !listing && !deltaLink) ||
        (nextLink !== null && deltaLink !== null)
      )
        throw new DiscoveryError("UNAVAILABLE");
      const metadata = [];
      for (const id of [...ids, ...removed]) {
        if (control.signal.aborted || !(await control.checkpoint()))
          return { kind: "paused", code: "auth" };
        let value: z.infer<typeof metadataSchema>;
        try {
          value = metadataSchema.parse(
            await provider.metadata(id, control.signal),
          );
        } catch (cause) {
          if (cause instanceof DiscoveryError && cause.code === "RATE_LIMITED")
            return deferFolderRate(
              lease,
              control,
              folder,
              cause.retryAfterMs ?? 30000,
            );
          throw cause;
        }
        if (value.id !== id) throw new DiscoveryError("UNAVAILABLE");
        metadata.push({ ...value, removed: removed.includes(id) });
      }
      if (control.signal.aborted || !(await control.checkpoint()))
        return { kind: "paused", code: "auth" };
      if (options.remainingStatements() < metadata.length * 4 + 5)
        return { kind: "retry", code: "transient" };
      const leaseGuard = guard(lease, now);
      const nonce = crypto.randomUUID();
      const childMarker = `EXISTS(SELECT 1 FROM sync_states child WHERE child.user_id=? AND child.id=? AND child.discovery_version=? AND child.pending_history_id=?)`;
      const childMarkerValues = [
        lease.context.userId,
        folder.id,
        folder.discovery_version + 1,
        nonce,
      ];
      const statements: D1PreparedStatement[] = [];
      const add = (sql: string, values: (string | number | null)[]) => {
        statements.push(db.prepare(sql).bind(...values));
      };
      const stage = nextLink
        ? folder.stage === "recovering"
          ? "recovering"
          : "queued"
        : parent.sync_kind === "backfill"
          ? "discovery_complete"
          : folder.stage === "recovering"
            ? "recovering_delta"
            : "idle";
      add(
        `UPDATE sync_states SET discovery_version=discovery_version+1,page_token=?,history_cursor=?,stage=?,pending_history_id=?,last_discovery_at=?,consecutive_failures=0 WHERE user_id=? AND id=? AND connection_id=? AND discovery_version=? AND ${leaseGuard.sql}`,
        [
          nextLink,
          deltaLink ?? folder.history_cursor,
          stage,
          nonce,
          now,
          lease.context.userId,
          folder.id,
          lease.connectionId,
          folder.discovery_version,
          ...leaseGuard.values,
        ],
      );
      for (const item of metadata) {
        const candidate =
          !item.removed &&
          item.available &&
          !item.excluded &&
          item.parentFolderId === folder.folder_id &&
          (parent.sync_kind === "incremental" &&
          !folder.stage.startsWith("recovering")
            ? item.receivedAtMs >= approvedStartMs && item.receivedAtMs < now
            : item.receivedAtMs >=
                Date.parse(folder.frozen_start ?? parent.frozen_start ?? "") &&
              item.receivedAtMs <
                Date.parse(folder.frozen_cutoff ?? parent.frozen_cutoff ?? ""));
        add(
          `INSERT INTO discovery_seen_refs(user_id,sync_state_id,provider_message_id,candidate_kind) SELECT ?,?,?,? WHERE ${childMarker} AND ${leaseGuard.sql} ON CONFLICT(user_id,sync_state_id,provider_message_id) DO UPDATE SET candidate_kind=excluded.candidate_kind`,
          [
            lease.context.userId,
            folder.id,
            item.id,
            candidate ? item.candidate : "excluded",
            ...childMarkerValues,
            ...leaseGuard.values,
          ],
        );
        if (!item.available) {
          add(
            `UPDATE source_messages SET available=0 WHERE user_id=? AND connection_id=? AND provider_message_id=? AND ${childMarker} AND ${leaseGuard.sql}`,
            [
              lease.context.userId,
              lease.connectionId,
              item.id,
              ...childMarkerValues,
              ...leaseGuard.values,
            ],
          );
          continue;
        }
        if (!candidate) continue;
        const sourceId = `(SELECT id FROM source_messages WHERE user_id=? AND connection_id=? AND provider_message_id=?)`;
        const sourceValues = [
          lease.context.userId,
          lease.connectionId,
          item.id,
        ];
        add(
          `INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,processing_status,generation,available) SELECT ?,?,?,?,?,'discovered',?,1 WHERE ${childMarker} AND ${leaseGuard.sql} ON CONFLICT(user_id,connection_id,provider_message_id) DO UPDATE SET available=1,generation=excluded.generation`,
          [
            crypto.randomUUID(),
            lease.context.userId,
            lease.connectionId,
            item.id,
            item.receivedAtMs,
            lease.generation,
            ...childMarkerValues,
            ...leaseGuard.values,
          ],
        );
        const dedupeKey = await sourceKey(
          lease.context.userId,
          lease.connectionId,
          item.id,
          lease.generation,
        );
        // G1: one initial extraction job per source across generations (pages.ts parity).
        add(
          `INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,priority) SELECT ?,?,?,?,?,'source-extract',?,'ready',?,? WHERE ${initialSourceJobAbsentSql(sourceId)} AND ${childMarker} AND ${leaseGuard.sql} ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
          [
            crypto.randomUUID(),
            lease.context.userId,
            lease.connectionId,
            lease.consentId,
            lease.generation,
            dedupeKey,
            now,
            parent.slice_key === "older" ? 1 : 0,
            lease.context.userId,
            ...sourceValues,
            ...childMarkerValues,
            ...leaseGuard.values,
          ],
        );
        add(
          `INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id) SELECT ?,${initialSourceJobSql(sourceId)},${sourceId} WHERE ${childMarker} AND ${leaseGuard.sql} ON CONFLICT(user_id,job_id) DO NOTHING`,
          [
            lease.context.userId,
            lease.context.userId,
            lease.connectionId,
            dedupeKey,
            ...sourceValues,
            ...sourceValues,
            ...childMarkerValues,
            ...leaseGuard.values,
          ],
        );
        if (parent.import_run_id)
          add(
            `INSERT INTO discovery_run_sources(user_id,import_run_id,source_message_id,candidate_kind) SELECT ?,?,${sourceId},? WHERE ${childMarker} AND ${leaseGuard.sql} ON CONFLICT(user_id,import_run_id,source_message_id) DO NOTHING`,
            [
              lease.context.userId,
              parent.import_run_id,
              ...sourceValues,
              item.candidate,
              ...childMarkerValues,
              ...leaseGuard.values,
            ],
          );
      }
      const continuationKey = `outlook:page:${lease.jobId}`;
      add(
        `INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at,priority) SELECT ?,?,?,?,?,?,?,?,'ready',?,? WHERE ${childMarker} AND ${leaseGuard.sql} ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
        [
          crypto.randomUUID(),
          lease.context.userId,
          lease.connectionId,
          lease.consentId,
          lease.generation,
          lease.syncStateId,
          lease.type,
          continuationKey,
          now,
          parent.slice_key === "older" ? 2 : 0,
          ...childMarkerValues,
          ...leaseGuard.values,
        ],
      );
      add(
        `UPDATE jobs SET status='completed',lease_id=NULL,lease_expires_at=NULL,outcome_code='discovery_staged' WHERE user_id=? AND id=? AND ${childMarker} AND ${leaseGuard.sql} AND EXISTS(SELECT 1 FROM jobs continuation WHERE continuation.user_id=? AND continuation.dedupe_key=? AND continuation.status='ready')`,
        [
          lease.context.userId,
          lease.jobId,
          ...childMarkerValues,
          ...leaseGuard.values,
          lease.context.userId,
          continuationKey,
        ],
      );
      await db.batch(statements);
      const settled = await db
        .prepare(
          "SELECT status FROM jobs WHERE user_id=? AND id=? AND status='completed'",
        )
        .bind(lease.context.userId, lease.jobId)
        .first();
      return settled
        ? { kind: "completed" }
        : { kind: "retry", code: "transient" };
    },
  };
}
