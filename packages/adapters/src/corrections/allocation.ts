import type {
  CorrectionCreditProof,
  CorrectionSettlement,
} from "@invoxim/core";
import {
  allocationReviewStatus,
  CorrectionError,
  parseMoney,
} from "@invoxim/core";
import type { PurchaseRow, ReviewRow } from "./data";
import type { correctionTransaction, VersionCheck } from "./transaction";

/** Credit-proof projection; `userRef`/`purchaseRef` select bound or correlated form (C9). */
export function creditProofSql(
  userRef = "?",
  purchaseRef = "?",
  options?: { observationIds?: boolean },
): string {
  return `SELECT json_extract(o.structured_fields,'$.record.currency') AS currency,json_extract(o.structured_fields,'$.record.total') AS total,CASE WHEN json_extract(o.structured_fields,'$.record.paymentMethodHint')='store-credit' THEN COALESCE(json_extract(o.structured_fields,'$.record.storeCreditAmount'),json_extract(o.structured_fields,'$.record.paymentAmount')) ELSE json_extract(o.structured_fields,'$.record.storeCreditAmount') END AS credit FROM purchase_evidence pe JOIN observations o ON o.user_id=pe.user_id AND o.id=pe.observation_id JOIN documents d ON d.user_id=o.user_id AND d.id=o.document_id JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id WHERE pe.user_id=${userRef} AND pe.purchase_id=${purchaseRef}${
    options?.observationIds
      ? " AND pe.observation_id IN(SELECT value FROM json_each(?))"
      : ""
  } AND o.review_state='accepted' AND o.evidence_code='explicitly-paid' AND json_extract(o.structured_fields,'$.record.paymentEvidence')='explicitly-paid' AND NOT EXISTS(SELECT 1 FROM lifecycle_deletions ld WHERE ld.user_id=s.user_id AND ld.scope='connection' AND ld.target_id=s.connection_id) AND NOT EXISTS(SELECT 1 FROM review_items r WHERE r.user_id=o.user_id AND r.status='open' AND r.blocking_scope='financial' AND r.reason!='payment-allocation-review' AND (r.observation_id=o.id OR (r.observation_id IS NULL AND r.document_id=o.document_id))) ORDER BY o.id LIMIT 201`;
}

export async function creditProofs(
  db: D1Database,
  user: string,
  purchaseId: string,
  observationIds?: readonly string[],
): Promise<CorrectionCreditProof[]> {
  if (observationIds && observationIds.length > 200)
    throw new CorrectionError("TOO_LARGE");
  const sql = creditProofSql("?", "?", {
    observationIds: observationIds !== undefined,
  });
  const args = observationIds
    ? [user, purchaseId, JSON.stringify(observationIds)]
    : [user, purchaseId];
  const result = await db
    .prepare(sql)
    .bind(...args)
    .all<{ currency: unknown; total: unknown; credit: unknown }>();
  return parseCreditProofRows(result.results);
}
export function parseCreditProofRows(
  rows: readonly { currency: unknown; total: unknown; credit: unknown }[],
): CorrectionCreditProof[] {
  if (rows.length > 200) throw new CorrectionError("TOO_LARGE");
  const proofs: CorrectionCreditProof[] = [];
  for (const row of rows) {
    if (
      typeof row.currency !== "string" ||
      typeof row.total !== "string" ||
      typeof row.credit !== "string"
    )
      continue;
    try {
      const total = parseMoney(row.total, row.currency),
        credit = parseMoney(row.credit, row.currency);
      if (total !== null && credit !== null && credit <= total)
        proofs.push({
          currency: row.currency,
          totalMinor: String(total),
          creditMinor: String(credit),
        });
    } catch {
      // Invalid legacy fields remain unknown and cannot establish settlement.
    }
  }
  return proofs;
}
export interface AllocationPlan {
  id: string;
  version: number;
  status: "open" | "resolved";
  existing: ReviewRow | null;
}
/** Open payment-allocation questions, plus resolved ones being restored (C14). */
function isAllocationReview(
  warning: ReviewRow,
  restoredOpenIds: readonly string[],
): boolean {
  return (
    warning.reason === "payment-allocation-review" &&
    (warning.status === "open" ||
      (warning.status === "resolved" && restoredOpenIds.includes(warning.id)))
  );
}
export function planAllocation(
  row: PurchaseRow,
  settlement: CorrectionSettlement,
  warnings: readonly ReviewRow[],
  restoredOpenIds: readonly string[] = [],
): AllocationPlan | null {
  const existing =
    warnings.find((warning) => isAllocationReview(warning, restoredOpenIds)) ??
    null;
  const status = allocationReviewStatus(
    row.payment_state,
    settlement,
    existing !== null,
  );
  if (status === null) return null;
  if (existing && existing.version >= 2147483646)
    throw new CorrectionError("CONFLICT");
  return {
    id: existing?.id ?? crypto.randomUUID(),
    version: existing ? existing.version + 1 : 1,
    status,
    existing,
  };
}
export function writeAllocation(
  tx: ReturnType<typeof correctionTransaction>,
  user: string,
  purchaseId: string,
  plan: AllocationPlan | null,
  clock: () => number,
) {
  if (!plan) return;
  if (plan.existing)
    tx.add(
      `UPDATE review_items SET status=?,version=version+1 WHERE user_id=? AND id=? AND ${tx.guard}`,
      [plan.status, user, plan.id, ...tx.guardValues],
    );
  else
    tx.add(
      `INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at) SELECT ?,?,NULL,NULL,?,'payment-allocation-review','financial','open',? WHERE ${tx.guard}`,
      [plan.id, user, purchaseId, clock(), ...tx.guardValues],
    );
  tx.audit(
    "review",
    plan.id,
    "payment-allocation-recomputed",
    { status: plan.existing?.status ?? null },
    { status: plan.status },
  );
}

// Merge can bring several independently versioned remainder questions together.
// Keep their status transitions bounded without one statement per question.
export function planAllocations(
  row: PurchaseRow,
  settlement: CorrectionSettlement,
  warnings: readonly ReviewRow[],
  restoredOpenIds: readonly string[] = [],
): AllocationPlan[] {
  const existing = warnings.filter((warning) =>
    isAllocationReview(warning, restoredOpenIds),
  );
  if (!existing.length) {
    const plan = planAllocation(row, settlement, [], restoredOpenIds);
    if (plan && warnings.length >= 200) throw new CorrectionError("TOO_LARGE");
    return plan ? [plan] : [];
  }
  return existing.flatMap((warning) => {
    const plan = planAllocation(row, settlement, [warning], restoredOpenIds);
    return plan ? [plan] : [];
  });
}
export function allocationsCheck(
  user: string,
  plans: readonly AllocationPlan[],
): VersionCheck[] {
  const expected = plans
    .filter((plan) => plan.existing)
    .map((plan) => ({
      id: plan.id,
      version: plan.existing?.version,
      status: plan.existing?.status,
    }));
  if (!expected.length) return [];
  return [
    {
      sql: "NOT EXISTS(SELECT 1 FROM json_each(?) e LEFT JOIN review_items r ON r.user_id=? AND r.id=json_extract(e.value,'$.id') WHERE r.id IS NULL OR r.version!=json_extract(e.value,'$.version') OR r.status!=json_extract(e.value,'$.status') OR r.reason!='payment-allocation-review')",
      values: [JSON.stringify(expected), user],
    },
  ];
}
export function writeAllocations(
  tx: ReturnType<typeof correctionTransaction>,
  user: string,
  purchaseId: string,
  plans: readonly AllocationPlan[],
  clock: () => number,
) {
  const existing = plans
    .filter((plan) => plan.existing)
    .map((plan) => ({
      id: plan.id,
      status: plan.status,
      before: plan.existing?.status,
      auditId: crypto.randomUUID(),
    }));
  if (existing.length) {
    const json = JSON.stringify(existing);
    tx.add(
      `UPDATE review_items SET status=(SELECT json_extract(value,'$.status') FROM json_each(?) WHERE json_extract(value,'$.id')=review_items.id),version=version+1 WHERE user_id=? AND id IN(SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${tx.guard}`,
      [json, user, json, ...tx.guardValues],
    );
    tx.add(
      `INSERT INTO correction_audit(id,user_id,entity_kind,entity_id,action,before_json,after_json,created_at) SELECT json_extract(value,'$.auditId'),?,'review',json_extract(value,'$.id'),'payment-allocation-recomputed',json_object('status',json_extract(value,'$.before')),json_object('status',json_extract(value,'$.status')),? FROM json_each(?) WHERE ${tx.guard}`,
      [user, clock(), json, ...tx.guardValues],
    );
  }
  for (const plan of plans.filter((plan) => !plan.existing))
    writeAllocation(tx, user, purchaseId, plan, clock);
}
