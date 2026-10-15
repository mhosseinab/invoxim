import type { CorrectionEventFact } from "@invoxim/core";
import {
  CorrectionError,
  evaluateCorrectionSettlement,
  hasCashProof,
  restorationEligibility,
  settlementEvents,
  validateRefundAllocation,
} from "@invoxim/core";
import {
  type AllocationPlan,
  allocationsCheck,
  creditProofs,
  planAllocations,
} from "./allocation";
import {
  events,
  type PurchaseRow,
  purchaseVersion,
  type ReviewRow,
  reviewFact,
  reviews,
} from "./data";
import type { correctionTransaction, VersionCheck } from "./transaction";

/**
 * At most this many purchases are recomputed by one review resolution;
 * more is the documented TOO_LARGE limit (the user resolves after cleanup
 * or with fewer linked purchases). Only included, editable purchases whose
 * cash or credit the review blocks count.
 */
export const MAX_UNBLOCKED_PURCHASES = 4;
/** Read bound: linked included, editable purchases examined per resolution. */
const MAX_LINKED_PURCHASES = 8;
/**
 * Statements write() adds to the resolving batch, independent of how many
 * purchases are recomputed: entries, purchases, remainder updates, new
 * remainders, audits. The largest resolving command (complete-record with
 * all 7 fields: 19 statements) plus this stays within transaction.ts's
 * 32-statement cap.
 */
export const UNBLOCK_MAX_STATEMENTS = 5;

/**
 * Entries of an included purchase that re-include left ineligible only
 * because of `resolvedId`: restorable without it but not with it. Kept
 * ineligible (conservative) if re-enabling them would over-allocate refunds.
 */
export function unblockedEntries(
  entries: readonly (CorrectionEventFact & { id: string })[],
  warnings: readonly ReviewRow[],
  resolvedId: string,
): string[] {
  const all = warnings.map(reviewFact);
  const remaining = all.filter((review) => review.id !== resolvedId);
  const ids = entries
    .filter(
      (entry) =>
        !entry.eligible &&
        !restorationEligibility(entry, all) &&
        restorationEligibility(entry, remaining),
    )
    .map((entry) => entry.id);
  if (!ids.length) return [];
  try {
    validateRefundAllocation(
      entries.filter((entry) => entry.eligible || ids.includes(entry.id)),
    );
  } catch {
    return [];
  }
  return ids;
}
interface UnblockPlan {
  row: PurchaseRow;
  owned: boolean;
  entryIds: string[];
  paymentState: string;
  allocations: AllocationPlan[];
}
export interface ReviewUnblock {
  checks: VersionCheck[];
  write(
    tx: ReturnType<typeof correctionTransaction>,
    clock: () => number,
  ): void;
}
const purchaseColumns =
  "p.id,p.merchant_raw,p.merchant_normalized,p.category,p.document_date,p.total_minor,p.currency,p.invoice_ref,p.order_ref,p.payment_state,p.record_status,p.version,p.origin,p.lifecycle_delete_connection_id,p.lifecycle_recompute_connection_id";
/**
 * Resolving an open financial review can unblock cash or credit it blocked
 * (OQ-B superset: owned by the purchase, or linked through an entry's or
 * evidence observation or, without observation, its document). Every
 * included purchase it blocks is fenced and recomputed: its entries that
 * only this review kept ineligible are re-enabled, and payment state and
 * remainder questions are recomputed in the resolving command's atomic
 * batch, with credit evaluated as if the review were closed.
 *
 * `owned` is the purchase the resolving operation already fences and
 * versions (its row as the operation leaves it); `skip` is a purchase the
 * operation recomputes itself. `recomputeOwned` recomputes `owned` even
 * when nothing unblocks (its total or currency changed); with
 * `keepOpen` the review stays open, so only that recompute runs and the
 * review still counts.
 */
export async function planReviewUnblock(
  db: D1Database,
  user: string,
  resolved: ReviewRow,
  options: {
    owned?: PurchaseRow | null;
    skip?: string;
    recomputeOwned?: boolean;
    keepOpen?: boolean;
  } = {},
): Promise<ReviewUnblock> {
  const none: ReviewUnblock = { checks: [], write() {} };
  const closing =
    !options.keepOpen &&
    resolved.status === "open" &&
    resolved.blocking_scope === "financial" &&
    resolved.reason !== "payment-allocation-review";
  const forced = options.recomputeOwned ? (options.owned?.id ?? null) : null;
  if (!closing && forced === null) return none;
  const link = closing ? resolved : null;
  const closed = closing ? resolved.id : undefined;
  // `credit` marks an evidence observation the review blocks that
  // creditProofSql would otherwise count (accepted, explicitly paid, with a
  // credit amount, source connection not pending deletion), so credit-only
  // purchases are recomputed and card-only evidence is not a link.
  const linked = await db
    .prepare(
      `SELECT ${purchaseColumns},MAX(linked.credit) AS credit FROM (SELECT l.purchase_id AS id,0 AS credit FROM ledger_entries l LEFT JOIN observations o ON o.user_id=l.user_id AND o.id=l.observation_id WHERE l.user_id=? AND l.purchase_id IS NOT NULL AND (l.purchase_id=? OR l.observation_id=? OR (? IS NULL AND o.document_id=?)) UNION ALL SELECT pe.purchase_id,1 FROM purchase_evidence pe JOIN observations o ON o.user_id=pe.user_id AND o.id=pe.observation_id JOIN documents d ON d.user_id=o.user_id AND d.id=o.document_id JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id WHERE pe.user_id=? AND (o.id=? OR (? IS NULL AND o.document_id=?)) AND o.review_state='accepted' AND o.evidence_code='explicitly-paid' AND json_extract(o.structured_fields,'$.record.paymentEvidence')='explicitly-paid' AND (CASE WHEN json_extract(o.structured_fields,'$.record.paymentMethodHint')='store-credit' THEN COALESCE(json_extract(o.structured_fields,'$.record.storeCreditAmount'),json_extract(o.structured_fields,'$.record.paymentAmount')) ELSE json_extract(o.structured_fields,'$.record.storeCreditAmount') END) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lifecycle_deletions ld WHERE ld.user_id=s.user_id AND ld.scope='connection' AND ld.target_id=s.connection_id) UNION ALL SELECT ?,0 WHERE ? IS NOT NULL) linked JOIN purchases p ON p.user_id=? AND p.id=linked.id WHERE p.record_status IN('active','excluded') AND p.lifecycle_delete_connection_id IS NULL AND p.lifecycle_recompute_connection_id IS NULL AND p.id IS NOT ? GROUP BY p.id ORDER BY p.id LIMIT ?`,
    )
    .bind(
      user,
      link?.purchase_id ?? null,
      link?.observation_id ?? null,
      link?.observation_id ?? null,
      link?.document_id ?? null,
      user,
      link?.observation_id ?? null,
      link?.observation_id ?? null,
      link?.document_id ?? null,
      forced,
      forced,
      user,
      options.skip ?? null,
      MAX_LINKED_PURCHASES + 1,
    )
    .all<PurchaseRow & { credit: number }>();
  if (linked.results.length > MAX_LINKED_PURCHASES)
    throw new CorrectionError("TOO_LARGE");
  const resolvedFact = reviewFact(resolved);
  const plans: UnblockPlan[] = [];
  const fences: PurchaseRow[] = [];
  const checks: VersionCheck[] = [];
  for (const { credit, ...stored } of linked.results) {
    const owned = options.owned?.id === stored.id;
    const row = owned && options.owned ? options.owned : stored;
    const entries = await events(db, user, row.id);
    // An excluded purchase is not recomputed, but if the resolved review
    // blocks its cash it is version-fenced: a concurrent restore that read
    // the review as open (and so left that cash ineligible) then conflicts,
    // and a restore that already committed makes this resolution conflict.
    if (stored.record_status === "excluded") {
      if (
        closing &&
        !owned &&
        entries.some(
          (entry) =>
            hasCashProof(entry) &&
            !restorationEligibility(entry, [resolvedFact]),
        )
      ) {
        checks.push(purchaseVersion(user, stored, stored.version));
        fences.push(stored);
      }
      continue;
    }
    // Every purchase with cash or credit the resolved review blocks is
    // recomputed and fenced, even when another open review still blocks it:
    // a concurrent resolution of that other review then conflicts instead of
    // both skipping the purchase and leaving its cash ineligible.
    if (
      stored.id !== forced &&
      credit !== 1 &&
      !entries.some(
        (entry) =>
          hasCashProof(entry) && !restorationEligibility(entry, [resolvedFact]),
      )
    )
      continue;
    if (plans.length === MAX_UNBLOCKED_PURCHASES)
      throw new CorrectionError("TOO_LARGE");
    const warnings = await reviews(db, user, row.id);
    const remainingRows = warnings.filter((item) => item.id !== closed);
    const entryIds = closed ? unblockedEntries(entries, warnings, closed) : [];
    const settlement = evaluateCorrectionSettlement(
      {
        currency: row.currency,
        totalMinor: row.total_minor === null ? null : String(row.total_minor),
        paymentState: row.payment_state,
      },
      settlementEvents(
        entries.map((entry) =>
          entryIds.includes(entry.id) ? { ...entry, eligible: true } : entry,
        ),
        remainingRows.map(reviewFact),
      ),
      await creditProofs(db, user, row.id, undefined, closed),
    );
    const allocations = planAllocations(row, settlement, remainingRows);
    if (!owned) checks.push(purchaseVersion(user, row, row.version));
    checks.push(...allocationsCheck(user, allocations));
    plans.push({
      row,
      owned,
      entryIds,
      paymentState: settlement.paymentState,
      allocations,
    });
  }
  if (!plans.length && !fences.length) return none;
  return {
    checks,
    write(tx, clock) {
      writeUnblock(tx, user, plans, fences, clock);
    },
  };
}
/** All plans in at most UNBLOCK_MAX_STATEMENTS set-based statements. */
function writeUnblock(
  tx: ReturnType<typeof correctionTransaction>,
  user: string,
  plans: readonly UnblockPlan[],
  fences: readonly PurchaseRow[],
  clock: () => number,
) {
  const entries = plans.flatMap((plan) =>
    plan.entryIds.map((id) => ({ id, purchaseId: plan.row.id })),
  );
  if (entries.length)
    tx.add(
      `UPDATE ledger_entries SET eligible=1 WHERE user_id=? AND eligible=0 AND EXISTS(SELECT 1 FROM json_each(?) e WHERE json_extract(e.value,'$.id')=ledger_entries.id AND json_extract(e.value,'$.purchaseId')=ledger_entries.purchase_id) AND ${tx.guard}`,
      [user, JSON.stringify(entries), ...tx.guardValues],
    );
  const states = JSON.stringify([
    ...plans.map((plan) => ({
      id: plan.row.id,
      state: plan.paymentState,
      bump: plan.owned ? 0 : 1,
    })),
    ...fences.map((row) => ({ id: row.id, state: row.payment_state, bump: 1 })),
  ]);
  tx.add(
    `UPDATE purchases SET payment_state=(SELECT json_extract(e.value,'$.state') FROM json_each(?) e WHERE json_extract(e.value,'$.id')=purchases.id),version=version+(SELECT json_extract(e.value,'$.bump') FROM json_each(?) e WHERE json_extract(e.value,'$.id')=purchases.id) WHERE user_id=? AND id IN(SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${tx.guard}`,
    [states, states, user, states, ...tx.guardValues],
  );
  const allocations = plans.flatMap((plan) =>
    plan.allocations.map((allocation) => ({
      allocation,
      purchaseId: plan.row.id,
    })),
  );
  const existing = JSON.stringify(
    allocations
      .filter(({ allocation }) => allocation.existing)
      .map(({ allocation }) => ({
        id: allocation.id,
        status: allocation.status,
      })),
  );
  if (allocations.some(({ allocation }) => allocation.existing))
    tx.add(
      `UPDATE review_items SET status=(SELECT json_extract(e.value,'$.status') FROM json_each(?) e WHERE json_extract(e.value,'$.id')=review_items.id),version=version+1 WHERE user_id=? AND id IN(SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${tx.guard}`,
      [existing, user, existing, ...tx.guardValues],
    );
  const created = JSON.stringify(
    allocations
      .filter(({ allocation }) => !allocation.existing)
      .map(({ allocation, purchaseId }) => ({ id: allocation.id, purchaseId })),
  );
  if (allocations.some(({ allocation }) => !allocation.existing))
    tx.add(
      `INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at) SELECT json_extract(value,'$.id'),?,NULL,NULL,json_extract(value,'$.purchaseId'),'payment-allocation-review','financial','open',? FROM json_each(?) WHERE ${tx.guard}`,
      [user, clock(), created, ...tx.guardValues],
    );
  const audits = [
    ...plans.map((plan) => ({
      id: crypto.randomUUID(),
      kind: "purchase",
      entity: plan.row.id,
      action: "review-resolution-recomputed",
      before: JSON.stringify({ paymentState: plan.row.payment_state }),
      after: JSON.stringify({
        paymentState: plan.paymentState,
        eligibleEntries: plan.entryIds,
      }),
    })),
    ...allocations.map(({ allocation }) => ({
      id: crypto.randomUUID(),
      kind: "review",
      entity: allocation.id,
      action: "payment-allocation-recomputed",
      before: JSON.stringify({ status: allocation.existing?.status ?? null }),
      after: JSON.stringify({ status: allocation.status }),
    })),
  ];
  if (audits.length)
    tx.add(
      `INSERT INTO correction_audit(id,user_id,entity_kind,entity_id,action,before_json,after_json,created_at) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.kind'),json_extract(value,'$.entity'),json_extract(value,'$.action'),json_extract(value,'$.before'),json_extract(value,'$.after'),? FROM json_each(?) WHERE ${tx.guard}`,
      [user, clock(), JSON.stringify(audits), ...tx.guardValues],
    );
}
