import type { EventChanges, ReviewResolutionRequest } from "@invoxim/contracts";
import {
  LEDGER_REVIEW_REASONS,
  type LedgerReviewReason,
} from "../ledger/types";
import { CorrectionError } from "./types";

/** Review reasons visible in the correction workspace, including `document-review` (operational scope). */
export const CORRECTION_REVIEW_REASONS = [
  ...LEDGER_REVIEW_REASONS,
  "document-review",
] as const satisfies readonly string[];
export type CorrectionReviewReason = (typeof CORRECTION_REVIEW_REASONS)[number];

export const REVIEW_ACTIONS = [
  "not-a-purchase",
  "dismiss-operational",
  "correct-missing-fields",
  "complete-record",
  "different-purchase",
  "confirm-payment",
  "confirm-refund",
] as const satisfies readonly string[];
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export const REVIEW_BLOCKING_SCOPES = [
  "financial",
  "operational",
] as const satisfies readonly string[];
export type ReviewBlockingScope = (typeof REVIEW_BLOCKING_SCOPES)[number];

export const REVIEW_STATUSES = [
  "open",
  "resolved",
  "dismissed",
] as const satisfies readonly string[];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * Map a `correct-missing-fields` change key to the `missingFields` vocabulary.
 * `totalMinor` is the request-side name for the AI missing-field `total`.
 */
export function missingFieldForChangeKey(key: string): string {
  return key === "totalMinor" ? "total" : key;
}

export interface CorrectionEventFact {
  id: string;
  observationId: string | null;
  documentId?: string | null;
  kind: "payment" | "refund";
  amountMinor: string;
  currency: string;
  eventDate: string;
  origin: "source" | "user-confirmed";
  eligible: boolean;
  accepted: boolean;
  evidenceCode: string | null;
}
export interface CorrectionReviewFact {
  available?: boolean;
  canDiscardSource?: boolean;
  id: string;
  observationId: string | null;
  documentId?: string | null;
  reason: CorrectionReviewReason;
  blockingScope: ReviewBlockingScope;
  status: ReviewStatus;
  missingFields: readonly string[];
  purchaseId: string | null;
}
export function hasCashProof(event: CorrectionEventFact) {
  return (
    event.origin === "user-confirmed" ||
    (event.accepted &&
      (event.evidenceCode === "manual-confirmation" ||
        event.evidenceCode ===
          (event.kind === "payment" ? "explicitly-paid" : "completed-refund")))
  );
}
export function validateRefundAllocation(
  entries: readonly CorrectionEventFact[],
  proposed?: {
    id: string;
    kind: "payment" | "refund";
    amountMinor: string;
    currency: string;
  },
) {
  const sums = new Map<
    string,
    { paid: bigint; refund: bigint; sourceRefund: bigint }
  >();
  function add(
    kind: "payment" | "refund",
    amountMinor: string,
    currency: string,
    origin: "source" | "user-confirmed",
  ) {
    const sum = sums.get(currency) ?? {
      paid: 0n,
      refund: 0n,
      sourceRefund: 0n,
    };
    const minor = BigInt(amountMinor);
    sum[kind === "payment" ? "paid" : "refund"] += minor;
    if (kind === "refund" && origin === "source") sum.sourceRefund += minor;
    sums.set(currency, sum);
  }
  for (const entry of entries) {
    if (hasCashProof(entry) && entry.id !== proposed?.id)
      add(entry.kind, entry.amountMinor, entry.currency, entry.origin);
  }
  if (proposed)
    add(
      proposed.kind,
      proposed.amountMinor,
      proposed.currency,
      entries.find((entry) => entry.id === proposed.id)?.origin ??
        "user-confirmed",
    );
  for (const sum of sums.values())
    if (
      (sum.paid > 0n && sum.refund > sum.paid) ||
      (sum.paid === 0n && sum.sourceRefund > 0n)
    )
      throw new CorrectionError("CONFLICT");
}
export function validateEntryChange(
  entry: CorrectionEventFact,
  changes: EventChanges,
  entries: readonly CorrectionEventFact[],
) {
  validateRefundAllocation(entries, {
    id: entry.id,
    kind: entry.kind,
    amountMinor: changes.amountMinor ?? entry.amountMinor,
    currency: changes.currency ?? entry.currency,
  });
}
export function reviewActions(review: CorrectionReviewFact): ReviewAction[] {
  if (review.status !== "open" || review.available === false) return [];
  const discard =
    review.canDiscardSource && !review.purchaseId
      ? ["not-a-purchase" as const]
      : [];
  if (review.blockingScope === "operational")
    return [...discard, "dismiss-operational"];
  if (review.reason === "unmatched-refund")
    return review.purchaseId
      ? ["confirm-refund"]
      : [...discard, "complete-record"];
  if (
    review.reason === "unknown-payment" ||
    review.reason === "payment-allocation-review"
  )
    return review.purchaseId ? ["confirm-payment"] : discard;
  if (review.reason === "ambiguous-event")
    return review.purchaseId ? ["confirm-payment", "confirm-refund"] : discard;
  if (review.reason === "possible-duplicate")
    return review.purchaseId ? ["different-purchase"] : discard;
  if (
    review.reason === "extraction-review" ||
    review.reason === "incomplete-financial-facts"
  )
    return review.purchaseId
      ? review.missingFields.length
        ? ["correct-missing-fields"]
        : []
      : [...discard, "complete-record"];
  return discard;
}
export function assertReviewAction(
  review: CorrectionReviewFact,
  request: ReviewResolutionRequest,
) {
  if (!reviewActions(review).includes(request.action))
    throw new CorrectionError("CONFLICT");
  if (request.action === "correct-missing-fields")
    for (const field of Object.keys(request.changes)) {
      const missing = missingFieldForChangeKey(field);
      if (!review.missingFields.includes(missing))
        throw new CorrectionError("INVALID_REQUEST");
    }
}
export function assertCashReview(
  review: CorrectionReviewFact,
  kind: "payment" | "refund",
  purchaseId: string,
) {
  if (
    review.purchaseId !== purchaseId ||
    !reviewActions(review).includes(
      kind === "payment" ? "confirm-payment" : "confirm-refund",
    )
  )
    throw new CorrectionError("CONFLICT");
}

/** Reasons that block only refund entries during restoration. */
const REFUND_ALLOCATION_REASONS = [
  "refund-exceeds-payment",
  "refund-currency-mismatch",
] as const satisfies readonly LedgerReviewReason[];

/** Reasons that block any cash-proof entry during restoration. */
const RESTORATION_BLOCKING_REASONS = [
  "event-conflict",
  "ambiguous-event",
  "unknown-payment",
  "invoice-conflict",
  "purchase-conflict",
  "incomplete-financial-facts",
  "extraction-review",
  "possible-duplicate",
] as const satisfies readonly LedgerReviewReason[];

export function restorationEligibility(
  entry: CorrectionEventFact,
  reviews: readonly CorrectionReviewFact[],
) {
  if (!hasCashProof(entry)) return false;
  for (const review of reviews) {
    if (
      review.status !== "open" ||
      review.blockingScope !== "financial" ||
      review.reason === "payment-allocation-review"
    )
      continue;
    if (review.observationId !== null) {
      if (review.observationId === entry.observationId) return false;
      continue;
    }
    if (
      (REFUND_ALLOCATION_REASONS as readonly string[]).includes(review.reason)
    ) {
      if (entry.kind === "refund") return false;
      continue;
    }
    if (entry.origin === "user-confirmed") continue;
    if (review.documentId && entry.documentId) {
      if (review.documentId === entry.documentId) return false;
      continue;
    }
    if (
      (RESTORATION_BLOCKING_REASONS as readonly string[]).includes(
        review.reason,
      )
    )
      return false;
  }
  return true;
}
