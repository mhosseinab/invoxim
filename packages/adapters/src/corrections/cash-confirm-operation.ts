import type { CorrectionCommand, CorrectionResult } from "@invoxim/contracts";
import type { CorrectionEventFact, CorrectionSession } from "@invoxim/core";
import {
  assertCashReview,
  evaluateCorrectionSettlement,
  restorationEligibility,
  settlementEvents,
  validateRefundAllocation,
} from "@invoxim/core";
import {
  allocationsCheck,
  creditProofs,
  planAllocations,
  writeAllocations,
} from "./allocation";
import {
  events,
  purchase,
  purchaseVersion,
  review,
  reviewFact,
  reviews,
  reviewVersion,
} from "./data";
import { planReviewUnblock, unblockedEntries } from "./review-unblock";
import type { VersionCheck } from "./transaction";
import { correctionTransaction } from "./transaction";

export async function executeCashConfirm(
  db: D1Database,
  session: CorrectionSession,
  command: Extract<CorrectionCommand, { kind: "cash-confirm" }>,
  key: string,
  identity: { route: string; bodyHash: string },
  clock: () => number,
): Promise<CorrectionResult> {
  const user = session.tenant.userId,
    row = await purchase(db, user, command.purchaseId),
    all = await events(db, user, row.id),
    warnings = await reviews(db, user, row.id);
  const checks: VersionCheck[] = [
    purchaseVersion(user, row, command.request.version),
  ];
  const entryId = crypto.randomUUID();
  validateRefundAllocation(all, {
    id: entryId,
    kind: command.entryKind,
    amountMinor: command.request.amountMinor,
    currency: command.request.currency,
  });
  let addressed: Awaited<ReturnType<typeof review>> | null = null;
  if (command.request.review) {
    addressed = await review(db, user, command.request.review.id);
    assertCashReview(reviewFact(addressed), command.entryKind, row.id);
    checks.push(reviewVersion(user, addressed, command.request.review.version));
  }
  const remaining = warnings
    .filter((warning) => warning.id !== addressed?.id)
    .map(reviewFact);
  const fact: CorrectionEventFact = {
    id: entryId,
    observationId: null,
    kind: command.entryKind,
    amountMinor: command.request.amountMinor,
    currency: command.request.currency,
    eventDate: command.request.eventDate,
    origin: "user-confirmed",
    eligible: false,
    accepted: true,
    evidenceCode: null,
  };
  const eligible =
    row.record_status === "active" && restorationEligibility(fact, remaining);
  const confirmed = { ...fact, eligible };
  // Resolving the addressed question re-enables the cash it alone kept
  // ineligible after a re-include, here and on other linked purchases.
  const resolving =
    addressed && addressed.reason !== "payment-allocation-review"
      ? addressed
      : null;
  const reenabled =
    resolving && row.record_status === "active"
      ? unblockedEntries([...all, confirmed], warnings, resolving.id)
      : [];
  const linked = resolving
    ? await planReviewUnblock(db, user, resolving, { skip: row.id })
    : null;
  if (linked) checks.push(...linked.checks);
  const settlement = evaluateCorrectionSettlement(
    {
      currency: row.currency,
      totalMinor: row.total_minor === null ? null : String(row.total_minor),
      paymentState: row.payment_state,
    },
    settlementEvents(
      [
        ...all.map((entry) =>
          reenabled.includes(entry.id) ? { ...entry, eligible: true } : entry,
        ),
        confirmed,
      ],
      remaining,
    ),
    await creditProofs(db, user, row.id, undefined, resolving?.id),
  );
  const allocations = planAllocations(row, settlement, warnings);
  checks.push(...allocationsCheck(user, allocations));
  const allocation =
    allocations.find((plan) => plan.id === addressed?.id) ?? allocations[0];
  const allocationAddressed = addressed?.reason === "payment-allocation-review";
  const result: CorrectionResult = {
    purchaseId: row.id,
    version: row.version + 1,
    entryId,
    entryVersion: 1,
    reviewId: addressed?.id ?? allocation?.id ?? null,
    reviewVersion: allocationAddressed
      ? (allocation?.version ?? null)
      : addressed
        ? addressed.version + 1
        : (allocation?.version ?? null),
    reviewStatus: allocationAddressed
      ? (allocation?.status ?? null)
      : addressed
        ? "resolved"
        : (allocation?.status ?? null),
    mergeId: null,
  };
  const tx = correctionTransaction(
    db,
    session,
    key,
    identity,
    result,
    checks,
    clock,
  );
  tx.add(
    `INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) SELECT ?,?,?,NULL,?,?,?,?,?,'user-confirmed-date',?,'user-confirmed' WHERE ${tx.guard}`,
    [
      entryId,
      user,
      row.id,
      `user-confirmed:${entryId}`,
      command.entryKind,
      Number(command.request.amountMinor),
      command.request.currency,
      command.request.eventDate,
      eligible ? 1 : 0,
      ...tx.guardValues,
    ],
  );
  tx.audit("entry", entryId, "cash-confirmed", null, {
    amountMinor: command.request.amountMinor,
    currency: command.request.currency,
    eventDate: command.request.eventDate,
    kind: command.entryKind,
  });
  writeAllocations(tx, user, row.id, allocations, clock);
  if (reenabled.length)
    tx.add(
      `UPDATE ledger_entries SET eligible=1 WHERE user_id=? AND purchase_id=? AND eligible=0 AND id IN(SELECT value FROM json_each(?)) AND ${tx.guard}`,
      [user, row.id, JSON.stringify(reenabled), ...tx.guardValues],
    );
  linked?.write(tx, clock);
  if (addressed && !allocationAddressed) {
    tx.add(
      `UPDATE review_items SET status='resolved',version=version+1 WHERE user_id=? AND id=? AND ${tx.guard}`,
      [user, addressed.id, ...tx.guardValues],
    );
    tx.audit(
      "review",
      addressed.id,
      "cash-confirmed-resolution",
      { status: addressed.status },
      { status: "resolved" },
    );
  }
  tx.add(
    `UPDATE purchases SET version=version+1,payment_state=? WHERE user_id=? AND id=? AND ${tx.guard}`,
    [settlement.paymentState, user, row.id, ...tx.guardValues],
  );
  return tx.commit();
}
