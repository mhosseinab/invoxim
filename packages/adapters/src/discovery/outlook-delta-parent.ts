import type { JobLease, JobOutcome } from "@invoxim/core";
import { OUTLOOK_STATEMENTS, outlookBudgetShortfall } from "./outlook-budget";
import {
  type DeltaControl,
  deltaLeaseGuard,
  excludedTreeSql,
  exclusionOwner,
  type OutlookDeltaContext,
  type ParentState,
} from "./outlook-delta-shared";
import {
  completeStagedJob,
  settledOutcome,
  stageAndSettle,
  stageContinuation,
  stageGuard,
} from "./stage-and-settle";

/**
 * G11: no queued folder is left, so the parent mailbox state advances: seed
 * missing folder cursors, restart idle live folders, release the older slice
 * or finish the slice, then complete the leased job.
 */
export async function advanceParent(
  context: OutlookDeltaContext,
  lease: JobLease,
  control: DeltaControl,
  parent: ParentState,
): Promise<JobOutcome> {
  const { db, clock, options } = context;
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
          .bind(lease.context.userId, lease.connectionId, parent.import_run_id)
          .first<{ id: string }>()
      : null;
  if (control.signal.aborted || !(await control.checkpoint()))
    return { kind: "paused", code: "auth" };
  if (options.remainingStatements() < OUTLOOK_STATEMENTS.advanceParent)
    return outlookBudgetShortfall();
  const now = clock();
  const nonce = crypto.randomUUID();
  const leaseGuard = deltaLeaseGuard(lease, now);
  const marker =
    "EXISTS(SELECT 1 FROM sync_states parent WHERE parent.user_id=? AND parent.id=? AND parent.discovery_version=? AND parent.pending_history_id=?)";
  const markerValues = [
    lease.context.userId,
    parent.id,
    parent.discovery_version + 1,
    nonce,
  ];
  const staged = stageGuard({ sql: marker, values: markerValues }, leaseGuard);
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
      stageContinuation(db, lease, staged, {
        syncStateId: older?.id ?? lease.syncStateId,
        type: older ? "discover" : lease.type,
        dedupeKey: continuationKey,
        dispatchAt: now,
        priority: older ? 2 : parent.slice_key === "older" ? 2 : 0,
      }),
    );
  if (parent.import_run_id && !missing && !restart && !paused)
    statements.push(
      db
        .prepare(
          `UPDATE import_runs SET stage=?,discovered_count=(SELECT COUNT(*) FROM discovery_run_sources WHERE user_id=? AND import_run_id=?) WHERE user_id=? AND id=? AND connection_id=? AND ${marker} AND ${leaseGuard.sql}`,
        )
        .bind(
          older ? "discovering_older" : "processing_pending",
          lease.context.userId,
          parent.import_run_id,
          lease.context.userId,
          parent.import_run_id,
          lease.connectionId,
          ...markerValues,
          ...leaseGuard.values,
        ),
    );
  statements.push(
    completeStagedJob(db, lease, staged, {
      outcome: "discovery_staged",
      ...(continuePage ? { continuationKey } : {}),
    }),
  );
  return settledOutcome(await stageAndSettle(db, lease, statements, "read"));
}
