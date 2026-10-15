import type { CorrectionEventFact } from "@invoxim/core";
import {
  CorrectionError,
  evaluateCorrectionSettlement,
  restorationEligibility,
  settlementEvents,
  validateRefundAllocation,
} from "@invoxim/core";
import {
  type AllocationPlan,
  allocationsCheck,
  creditProofs,
  planAllocations,
  writeAllocations,
} from "./allocation";
import {
  events,
  type PurchaseRow,
  purchase,
  purchaseVersion,
  type ReviewRow,
  reviewFact,
  reviews,
} from "./data";
import type { correctionTransaction, VersionCheck } from "./transaction";

/** At most this many purchases are recomputed by one review resolution. */
const MAX_UNBLOCKED_PURCHASES = 4;

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
/**
 * Resolving an open financial review can unblock cash it was the last
 * restoration blocker for (OQ-B superset: owned by the purchase, or linked
 * through an entry's observation or, without observation, its document).
 * Re-enable those entries on included purchases and recompute payment state
 * and allocation questions in the resolving command's atomic batch.
 *
 * `owned` is the purchase the resolving operation already fences and
 * versions (its row as the operation leaves it); `skip` is a purchase the
 * operation recomputes itself.
 */
export async function planReviewUnblock(
  db: D1Database,
  user: string,
  resolved: ReviewRow,
  options: { owned?: PurchaseRow | null; skip?: string } = {},
): Promise<ReviewUnblock> {
  const none: ReviewUnblock = { checks: [], write() {} };
  if (
    resolved.status !== "open" ||
    resolved.blocking_scope !== "financial" ||
    resolved.reason === "payment-allocation-review"
  )
    return none;
  const linked = await db
    .prepare(
      "SELECT DISTINCT l.purchase_id AS id FROM ledger_entries l LEFT JOIN observations o ON o.user_id=l.user_id AND o.id=l.observation_id WHERE l.user_id=? AND l.purchase_id IS NOT NULL AND (l.purchase_id=? OR l.observation_id=? OR (? IS NULL AND o.document_id=?)) ORDER BY l.purchase_id LIMIT ?",
    )
    .bind(
      user,
      resolved.purchase_id,
      resolved.observation_id,
      resolved.observation_id,
      resolved.document_id,
      MAX_UNBLOCKED_PURCHASES + 1,
    )
    .all<{ id: string }>();
  if (linked.results.length > MAX_UNBLOCKED_PURCHASES)
    throw new CorrectionError("TOO_LARGE");
  const plans: UnblockPlan[] = [];
  const checks: VersionCheck[] = [];
  for (const { id } of linked.results) {
    if (id === options.skip) continue;
    const owned = options.owned?.id === id;
    const row =
      owned && options.owned ? options.owned : await purchase(db, user, id);
    if (
      row.record_status !== "active" ||
      row.lifecycle_delete_connection_id !== null ||
      row.lifecycle_recompute_connection_id !== null
    )
      continue;
    const entries = await events(db, user, id),
      warnings = await reviews(db, user, id);
    const all = warnings.map(reviewFact);
    const remainingRows = warnings.filter((item) => item.id !== resolved.id);
    const remaining = remainingRows.map(reviewFact);
    // Only purchases whose cash support this resolution changes.
    if (
      !entries.some(
        (entry) =>
          !restorationEligibility(entry, all) &&
          restorationEligibility(entry, remaining),
      )
    )
      continue;
    const entryIds = unblockedEntries(entries, warnings, resolved.id);
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
        remaining,
      ),
      await creditProofs(db, user, id),
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
  return {
    checks,
    write(tx, clock) {
      for (const plan of plans) {
        if (plan.entryIds.length)
          tx.add(
            `UPDATE ledger_entries SET eligible=1 WHERE user_id=? AND purchase_id=? AND eligible=0 AND id IN(SELECT value FROM json_each(?)) AND ${tx.guard}`,
            [
              user,
              plan.row.id,
              JSON.stringify(plan.entryIds),
              ...tx.guardValues,
            ],
          );
        writeAllocations(tx, user, plan.row.id, plan.allocations, clock);
        tx.add(
          `UPDATE purchases SET payment_state=?${plan.owned ? "" : ",version=version+1"} WHERE user_id=? AND id=? AND ${tx.guard}`,
          [plan.paymentState, user, plan.row.id, ...tx.guardValues],
        );
        tx.audit(
          "purchase",
          plan.row.id,
          "review-resolution-recomputed",
          { paymentState: plan.row.payment_state },
          { paymentState: plan.paymentState, eligibleEntries: plan.entryIds },
        );
      }
    },
  };
}
