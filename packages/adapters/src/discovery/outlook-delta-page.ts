import type { JobLease, JobOutcome } from "@invoxim/core";
import { sourceKey } from "../hash";
import {
  deltaLeaseGuard,
  type FolderMessage,
  type FolderState,
  type OutlookDeltaContext,
  type ParentState,
} from "./outlook-delta-shared";
import { initialSourceJobAbsentSql, initialSourceJobSql } from "./source-jobs";
import {
  completeStagedJob,
  settledOutcome,
  stageAndSettle,
  stageContinuation,
  stageGuard,
} from "./stage-and-settle";

/**
 * G3: a folder's seen-ref count after this page's upserts, computed in the
 * page CAS statement. Binds: userId, syncStateId, pageKinds, pageKinds, where
 * pageKinds is a JSON array of [providerMessageId, candidateKind] pairs.
 */
function seenRefCountSql(kind?: "matched" | "unknown") {
  return `(SELECT COUNT(*) FROM (SELECT provider_message_id AS id,candidate_kind AS kind FROM discovery_seen_refs WHERE user_id=? AND sync_state_id=? AND provider_message_id NOT IN (SELECT json_extract(value,'$[0]') FROM json_each(?)) UNION ALL SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))${kind ? ` WHERE kind='${kind}'` : ""})`;
}
/**
 * G11: commits one validated folder page in one guarded batch: the folder
 * CAS with its counters, the seen refs and candidate sources with their
 * initial extraction jobs, then the continuation and the job completion.
 */
export async function commitFolderPage(
  context: OutlookDeltaContext,
  lease: JobLease,
  page: {
    parent: ParentState;
    folder: FolderState;
    metadata: FolderMessage[];
    nextLink: string | null;
    deltaLink: string | null;
    approvedStartMs: number;
    now: number;
  },
): Promise<JobOutcome> {
  const { db } = context;
  const {
    parent,
    folder,
    metadata,
    nextLink,
    deltaLink,
    approvedStartMs,
    now,
  } = page;
  const leaseGuard = deltaLeaseGuard(lease, now);
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
  const references = metadata.map((item) => ({
    item,
    candidate:
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
            Date.parse(folder.frozen_cutoff ?? parent.frozen_cutoff ?? "")),
  }));
  // G3: the seen-ref upserts below run later in this batch, so the
  // counters combine the folder's other refs with this page's final kinds.
  const pageKinds = JSON.stringify([
    ...new Map(
      references.map(({ item, candidate }) => [
        item.id,
        candidate ? item.candidate : "excluded",
      ]),
    ),
  ]);
  const counted = [lease.context.userId, folder.id, pageKinds, pageKinds];
  add(
    `UPDATE sync_states SET discovery_version=discovery_version+1,page_token=?,history_cursor=?,stage=?,pending_history_id=?,last_discovery_at=?,consecutive_failures=0,enumerated_count=${seenRefCountSql()},matched_count=${seenRefCountSql("matched")},unknown_count=${seenRefCountSql("unknown")} WHERE user_id=? AND id=? AND connection_id=? AND discovery_version=? AND ${leaseGuard.sql}`,
    [
      nextLink,
      deltaLink ?? folder.history_cursor,
      stage,
      nonce,
      now,
      ...counted,
      ...counted,
      ...counted,
      lease.context.userId,
      folder.id,
      lease.connectionId,
      folder.discovery_version,
      ...leaseGuard.values,
    ],
  );
  for (const { item, candidate } of references) {
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
    const sourceValues = [lease.context.userId, lease.connectionId, item.id];
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
  const staged = stageGuard(
    { sql: childMarker, values: childMarkerValues },
    leaseGuard,
  );
  statements.push(
    stageContinuation(db, lease, staged, {
      dedupeKey: continuationKey,
      dispatchAt: now,
      priority: parent.slice_key === "older" ? 2 : 0,
    }),
    completeStagedJob(db, lease, staged, {
      outcome: "discovery_staged",
      continuationKey,
    }),
  );
  return settledOutcome(await stageAndSettle(db, lease, statements, "read"));
}
