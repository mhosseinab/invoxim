import type { CorrectionReview, CorrectionState } from "@invoxim/contracts";
import type { TenantContext } from "@invoxim/core";
import { CorrectionError, reviewActions } from "@invoxim/core";
import { events, purchase, review, reviewFact, reviews } from "./data";
export async function readCorrectionPurchase(
  db: D1Database,
  tenant: TenantContext,
  id: string,
): Promise<Omit<CorrectionState, "mutationToken"> | null> {
  let row: Awaited<ReturnType<typeof purchase>>;
  try {
    row = await purchase(db, tenant.userId, id);
  } catch (cause) {
    if (cause instanceof CorrectionError && cause.code === "NOT_FOUND")
      return null;
    throw cause;
  }
  const all = await events(db, tenant.userId, id);
  const warningRows = await reviews(db, tenant.userId, id);
  const overrides = await db
    .prepare(
      "SELECT entity_kind,entity_id,field FROM field_overrides WHERE user_id=? AND ((entity_kind='purchase' AND entity_id=?) OR (entity_kind='entry' AND entity_id IN(SELECT id FROM ledger_entries WHERE user_id=? AND purchase_id=?))) ORDER BY entity_kind,entity_id,field LIMIT 1601",
    )
    .bind(tenant.userId, id, tenant.userId, id)
    .all<{
      entity_kind: "purchase" | "entry";
      entity_id: string;
      field: string;
    }>();
  if (overrides.results.length > 1600) throw new CorrectionError("TOO_LARGE");
  const history = await db
    .prepare(
      "SELECT id,target_id AS targetId,source_id AS sourceId,target_version AS targetVersion,source_version AS sourceVersion,active FROM purchase_merges WHERE user_id=? AND (target_id=? OR source_id=?) ORDER BY id LIMIT 21",
    )
    .bind(tenant.userId, id, id)
    .all<{
      id: string;
      targetId: string;
      sourceId: string;
      targetVersion: number;
      sourceVersion: number;
      active: number;
    }>();
  if (history.results.length > 20) throw new CorrectionError("TOO_LARGE");
  return {
    purchaseId: id,
    version: row.version,
    origin: row.origin,
    recordStatus: row.record_status,
    overriddenFields: overrides.results
      .filter((item) => item.entity_kind === "purchase")
      .map((item) => item.field),
    entries: all.map((item) => ({
      id: item.id,
      version: item.version,
      origin: item.origin,
      overriddenFields: overrides.results
        .filter(
          (value) =>
            value.entity_kind === "entry" && value.entity_id === item.id,
        )
        .map((value) => value.field),
    })),
    reviews: warningRows.map((item) => ({
      id: item.id,
      version: item.version,
      reason: item.reason,
      blockingScope: item.blocking_scope,
      missingFields: reviewFact(item).missingFields as (
        | "merchant"
        | "currency"
        | "total"
        | "documentDate"
      )[],
      status: item.status,
      actions: reviewActions(reviewFact(item)),
    })),
    merges: history.results.map((item) => ({
      ...item,
      active: item.active === 1,
    })),
    capabilities: {
      editable:
        row.record_status !== "merged" &&
        row.lifecycle_delete_connection_id === null &&
        row.lifecycle_recompute_connection_id === null,
      maxMergeEvents: 200,
      maxMergeEvidence: 200,
    },
  };
}
export async function readCorrectionReview(
  db: D1Database,
  tenant: TenantContext,
  id: string,
): Promise<Omit<CorrectionReview, "mutationToken"> | null> {
  let row: Awaited<ReturnType<typeof review>>;
  try {
    row = await review(db, tenant.userId, id);
  } catch (cause) {
    if (cause instanceof CorrectionError && cause.code === "NOT_FOUND")
      return null;
    throw cause;
  }
  let purchaseVersion: number | null = null;
  let editable = true;
  if (row.purchase_id) {
    const owned = await purchase(db, tenant.userId, row.purchase_id);
    purchaseVersion = owned.version;
    editable =
      owned.record_status !== "merged" &&
      owned.lifecycle_delete_connection_id === null &&
      owned.lifecycle_recompute_connection_id === null;
  }
  return {
    documentId: row.document_id,
    purchaseId: row.purchase_id,
    purchaseVersion,
    review: {
      id: row.id,
      version: row.version,
      reason: row.reason,
      blockingScope: row.blocking_scope,
      missingFields: reviewFact(row).missingFields as (
        | "merchant"
        | "currency"
        | "total"
        | "documentDate"
      )[],
      status: row.status,
      actions: editable ? reviewActions(reviewFact(row)) : [],
    },
  };
}
