import type { JobLease } from "@invoxim/core";
import { outlookLeaseGuard } from "./outlook-guard";

/** G11: state and SQL shared by the split Outlook delta runner modules. */
export interface ParentState {
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
export interface FolderState {
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
/** One message's Graph metadata, plus whether the delta removed it here. */
export interface FolderMessage {
  id: string;
  parentFolderId: string | null;
  receivedAtMs: number;
  available: boolean;
  excluded: boolean;
  candidate: "matched" | "unknown";
  removed: boolean;
}
export interface DeltaControl {
  signal: AbortSignal;
  checkpoint: () => Promise<boolean>;
}
/** What every delta step reads: the database, clock and statement budget. */
export interface OutlookDeltaContext {
  db: D1Database;
  clock: () => number;
  options: { remainingStatements: () => number };
}
export const excludedTreeSql = `WITH RECURSIVE excluded(folder_id) AS (SELECT value FROM json_each((SELECT excluded_folder_ids FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND scope_key='root')) UNION SELECT f.folder_id FROM outlook_folders f JOIN excluded e ON f.parent_folder_id=e.folder_id WHERE f.user_id=? AND f.connection_id=? AND f.generation=?)`;
export function exclusionOwner(lease: JobLease) {
  return [
    lease.context.userId,
    lease.connectionId,
    lease.generation,
    lease.context.userId,
    lease.connectionId,
    lease.generation,
  ];
}
export function deltaLeaseGuard(lease: JobLease, now: number) {
  return outlookLeaseGuard(lease, now, {
    types: ["discover", "sync"],
    syncState: true,
  });
}
