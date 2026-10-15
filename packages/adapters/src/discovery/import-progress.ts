import type { TenantContext } from "@invoxim/core";
import { DiscoveryError } from "@invoxim/core";
import { activeProfileSql } from "../pipeline/repository-guards";

/**
 * G11: Gmail import progress, split out of pages.ts. Three charged reads
 * (run, slices, source counts) followed by a pure summary of them.
 */
export interface ImportSliceProgress {
  slice_key: string;
  stage: string;
  enumerated_count: number;
  matched_count: number;
  unknown_count: number;
  coverage_code: string;
  history_reset_count: number;
}
export interface ImportSourceCounts {
  candidates: number;
  processed: number | null;
  unsupported: number | null;
  failed: number | null;
  review: number | null;
}

/** The three owned reads behind an import's progress view. */
export async function readImportProgress(
  db: D1Database,
  charge: () => void,
  context: TenantContext,
  importRunId: string,
) {
  charge();
  const parent = await db
    .prepare(
      `SELECT id,stage,frozen_start,frozen_cutoff,query_mode,first_usable_at FROM import_runs WHERE user_id=? AND id=? AND ${activeProfileSql}`,
    )
    .bind(context.userId, importRunId, context.userId)
    .first();
  if (!parent) throw new DiscoveryError("UNAUTHORIZED");
  charge();
  const slices = await db
    .prepare(
      "SELECT slice_key,stage,enumerated_count,matched_count,unknown_count,coverage_code,history_reset_count FROM sync_states WHERE user_id=? AND import_run_id=? ORDER BY CASE slice_key WHEN 'recent' THEN 0 ELSE 1 END",
    )
    .bind(context.userId, importRunId)
    .all<ImportSliceProgress>();
  charge();
  const counts = await db
    .prepare(
      "SELECT COUNT(*) AS candidates,SUM(CASE WHEN s.processing_status='processed' THEN 1 ELSE 0 END) AS processed,SUM(CASE WHEN s.processing_status='unsupported' THEN 1 ELSE 0 END) AS unsupported,SUM(CASE WHEN s.processing_status='failed' THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN s.processing_status='review' THEN 1 ELSE 0 END) AS review FROM discovery_run_sources r JOIN source_messages s ON s.user_id=r.user_id AND s.id=r.source_message_id WHERE r.user_id=? AND r.import_run_id=?",
    )
    .bind(context.userId, importRunId)
    .first<ImportSourceCounts>();
  return summarizeImportProgress(importRunId, parent, slices.results, counts);
}

/** Pure: completion flags and summed counters from the reads above. */
export function summarizeImportProgress(
  importRunId: string,
  parent: Record<string, unknown>,
  slices: ImportSliceProgress[],
  counts: ImportSourceCounts | null,
) {
  const discoveryComplete =
    slices.length > 0 &&
    slices.every((slice) => slice.stage === "discovery_complete");
  const processed = counts?.processed ?? 0,
    unsupported = counts?.unsupported ?? 0,
    failed = counts?.failed ?? 0,
    review = counts?.review ?? 0;
  const processingComplete =
    discoveryComplete && (counts?.candidates ?? 0) === processed + unsupported;
  return {
    importRunId,
    parent,
    slices,
    discoveryComplete,
    processingComplete,
    counts: {
      enumerated: slices.reduce(
        (total, slice) => total + slice.enumerated_count,
        0,
      ),
      matched: slices.reduce((total, slice) => total + slice.matched_count, 0),
      unknown: slices.reduce((total, slice) => total + slice.unknown_count, 0),
      processed,
      unsupported,
      failed,
      review,
    },
  };
}
