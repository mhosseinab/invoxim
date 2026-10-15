import type {
  CorrectionEventFact,
  CorrectionReviewFact,
  CorrectionReviewReason,
} from "@invoxim/core";
import { CorrectionError } from "@invoxim/core";
import { activeProfileSql } from "../pipeline/repository-guards";
import type { VersionCheck } from "./transaction";
export interface PurchaseRow {
  id: string;
  merchant_raw: string;
  merchant_normalized: string;
  category: string;
  document_date: string;
  total_minor: number | null;
  currency: string | null;
  invoice_ref: string | null;
  order_ref: string | null;
  payment_state: string;
  record_status: "active" | "excluded" | "merged";
  version: number;
  origin: "source" | "user-supplied";
  lifecycle_delete_connection_id: string | null;
  lifecycle_recompute_connection_id: string | null;
}
export interface ReviewRow {
  id: string;
  purchase_id: string | null;
  document_id: string | null;
  observation_id: string | null;
  reason: string;
  blocking_scope: "financial" | "operational";
  status: "open" | "resolved" | "dismissed";
  version: number;
  missing_fields_json: string | null;
  deletion_pending: number;
}
/** Deletion-pending EXISTS for a row's owning connection (C8). */
export function deletionPendingSql(
  userRef: string,
  documentRef: string,
): string {
  return `EXISTS(SELECT 1 FROM lifecycle_deletions ld JOIN source_messages s ON s.user_id=ld.user_id AND s.connection_id=ld.target_id JOIN documents d ON d.user_id=s.user_id AND d.source_message_id=s.id WHERE ld.user_id=${userRef} AND ld.scope='connection' AND d.id=${documentRef})`;
}
const reviewDeletionPendingSql = deletionPendingSql(
  "review_items.user_id",
  "review_items.document_id",
);
export async function purchase(db: D1Database, user: string, id: string) {
  const row = await db
    .prepare(
      `SELECT id,merchant_raw,merchant_normalized,category,document_date,total_minor,currency,invoice_ref,order_ref,payment_state,record_status,version,origin,lifecycle_delete_connection_id,lifecycle_recompute_connection_id FROM purchases WHERE user_id=? AND id=? AND ${activeProfileSql}`,
    )
    .bind(user, id, user)
    .first<PurchaseRow>();
  if (!row) throw new CorrectionError("NOT_FOUND");
  return row;
}
export async function events(
  db: D1Database,
  user: string,
  purchaseId: string,
): Promise<
  (CorrectionEventFact & {
    version: number;
    dateBasis: string;
    observationId: string | null;
  })[]
> {
  const rows = await db
    .prepare(
      `SELECT l.id,l.kind,CAST(l.amount_minor AS TEXT) AS amountMinor,l.currency,l.event_date AS eventDate,l.date_basis AS dateBasis,l.origin,l.eligible,l.version,l.observation_id AS observationId,o.document_id AS documentId,o.review_state AS reviewState,o.evidence_code AS evidenceCode,${deletionPendingSql("l.user_id", "o.document_id")} AS deletionPending FROM ledger_entries l LEFT JOIN observations o ON o.user_id=l.user_id AND o.id=l.observation_id WHERE l.user_id=? AND l.purchase_id=? ORDER BY l.id LIMIT 201`,
    )
    .bind(user, purchaseId)
    .all<{
      id: string;
      kind: "payment" | "refund";
      amountMinor: string;
      currency: string;
      eventDate: string;
      dateBasis: string;
      origin: "source" | "user-confirmed";
      eligible: number;
      version: number;
      observationId: string | null;
      documentId: string | null;
      reviewState: string | null;
      deletionPending: number;
      evidenceCode: string | null;
    }>();
  if (rows.results.length > 200) throw new CorrectionError("TOO_LARGE");
  return rows.results.map((row) => ({
    ...row,
    eligible: row.eligible === 1,
    accepted: row.reviewState === "accepted" && row.deletionPending === 0,
  }));
}
/**
 * The purchase's reviews plus the open financial reviews that can block its
 * cash although linked only through an entry's observation or, without
 * observation, its document: the superset the lifecycle recompute and the
 * pipeline snapshot use, so corrections never count cash those paths block.
 */
export async function reviews(
  db: D1Database,
  user: string,
  purchaseId: string,
): Promise<ReviewRow[]> {
  const rows = await db
    .prepare(
      `SELECT id,purchase_id,document_id,observation_id,reason,blocking_scope,status,version,missing_fields_json,${reviewDeletionPendingSql} AS deletion_pending FROM review_items WHERE user_id=? AND (purchase_id=? OR (status='open' AND blocking_scope='financial' AND reason!='payment-allocation-review' AND (observation_id IN(SELECT l.observation_id FROM ledger_entries l WHERE l.user_id=review_items.user_id AND l.purchase_id=?) OR (observation_id IS NULL AND document_id IN(SELECT o.document_id FROM ledger_entries l JOIN observations o ON o.user_id=l.user_id AND o.id=l.observation_id WHERE l.user_id=review_items.user_id AND l.purchase_id=?))))) ORDER BY id LIMIT 201`,
    )
    .bind(user, purchaseId, purchaseId, purchaseId)
    .all<ReviewRow>();
  if (rows.results.length > 200) throw new CorrectionError("TOO_LARGE");
  return rows.results;
}
export async function review(db: D1Database, user: string, id: string) {
  const row = await db
    .prepare(
      `SELECT id,purchase_id,document_id,observation_id,reason,blocking_scope,status,version,missing_fields_json,${reviewDeletionPendingSql} AS deletion_pending FROM review_items WHERE user_id=? AND id=? AND ${activeProfileSql}`,
    )
    .bind(user, id, user)
    .first<ReviewRow>();
  if (!row) throw new CorrectionError("NOT_FOUND");
  return row;
}
export function reviewFact(row: ReviewRow): CorrectionReviewFact {
  return {
    id: row.id,
    observationId: row.observation_id,
    documentId: row.document_id,
    reason: row.reason as CorrectionReviewReason,
    blockingScope: row.blocking_scope,
    status: row.status,
    purchaseId: row.purchase_id,
    available: row.deletion_pending !== 1,
    missingFields: row.missing_fields_json
      ? (JSON.parse(row.missing_fields_json) as string[])
      : [],
  };
}
export function purchaseVersion(
  user: string,
  row: PurchaseRow,
  expected: number,
): VersionCheck {
  if (
    row.version !== expected ||
    row.version >= 2147483646 ||
    row.record_status === "merged" ||
    row.lifecycle_delete_connection_id !== null ||
    row.lifecycle_recompute_connection_id !== null
  )
    throw new CorrectionError("CONFLICT");
  return {
    sql: "EXISTS(SELECT 1 FROM purchases WHERE user_id=? AND id=? AND version=? AND version<2147483646 AND record_status!='merged' AND lifecycle_delete_connection_id IS NULL AND lifecycle_recompute_connection_id IS NULL)",
    values: [user, row.id, expected],
  };
}
export function reviewVersion(
  user: string,
  row: ReviewRow,
  expected: number,
): VersionCheck {
  if (
    row.version !== expected ||
    row.version >= 2147483646 ||
    row.status !== "open"
  )
    throw new CorrectionError("CONFLICT");
  return {
    sql: `EXISTS(SELECT 1 FROM review_items WHERE user_id=? AND id=? AND version=? AND version<2147483646 AND status='open') AND NOT ${deletionPendingSql("?", "?")}`,
    values: [user, row.id, expected, user, row.document_id],
  };
}
