import { derivePaymentState } from "../ledger/payment-state";
import {
  type CorrectionEventFact,
  type CorrectionReviewFact,
  restorationEligibility,
} from "./validation";

export interface CorrectionSettlementEvent {
  readonly kind: "payment" | "refund";
  readonly amountMinor: string;
  readonly currency: string;
  readonly origin: "source" | "user-confirmed";
  readonly supported: boolean;
}
export interface CorrectionCreditProof {
  readonly currency: string;
  readonly totalMinor: string;
  readonly creditMinor: string;
}
export interface CorrectionSettlement {
  readonly paymentState: "unknown" | "unpaid" | "partially_paid" | "paid";
  readonly supportedMinor: string;
  readonly balanced: boolean;
  readonly sourceProof: boolean;
}
export function settlementEvents(
  entries: readonly CorrectionEventFact[],
  reviews: readonly CorrectionReviewFact[],
): CorrectionSettlementEvent[] {
  return entries.map((entry) => ({
    kind: entry.kind,
    amountMinor: entry.amountMinor,
    currency: entry.currency,
    origin: entry.origin,
    supported: restorationEligibility(entry, reviews),
  }));
}
export function evaluateCorrectionSettlement(
  purchase: {
    currency: string | null;
    totalMinor: string | null;
    paymentState: string;
  },
  events: readonly CorrectionSettlementEvent[],
  credits: readonly CorrectionCreditProof[],
): CorrectionSettlement {
  const sourceProof =
    events.some(
      (entry) =>
        entry.supported &&
        entry.origin === "source" &&
        entry.kind === "payment",
    ) || credits.some((credit) => BigInt(credit.creditMinor) > 0n);
  if (!purchase.currency || purchase.totalMinor === null)
    return {
      paymentState: "unknown",
      supportedMinor: "0",
      balanced: false,
      sourceProof,
    };
  const gross = BigInt(purchase.totalMinor);
  let cash = 0n,
    credit = 0n,
    mixed = false;
  for (const entry of events) {
    if (!entry.supported || entry.kind !== "payment") continue;
    if (entry.currency === purchase.currency) cash += BigInt(entry.amountMinor);
    else if (BigInt(entry.amountMinor) > 0n) mixed = true;
  }
  // Separate credit installments have no independent event identities. Retain only the largest compatible proof.
  for (const proof of credits) {
    const minor = BigInt(proof.creditMinor);
    if (proof.currency !== purchase.currency) {
      if (minor > 0n) mixed = true;
      continue;
    }
    if (BigInt(proof.totalMinor) === gross && minor <= gross && minor > credit)
      credit = minor;
  }
  const settled = cash + credit;
  const paymentState = derivePaymentState({
    totalMinor: gross,
    settledMinor: settled,
    zeroPaymentState:
      purchase.paymentState === "unpaid" &&
      !events.some((entry) => entry.supported && entry.kind === "refund")
        ? "unpaid"
        : "unknown",
  });
  return {
    paymentState,
    supportedMinor: String(settled),
    balanced: settled === gross && !mixed,
    sourceProof,
  };
}
export function allocationReviewStatus(
  previousPaymentState: string,
  settlement: CorrectionSettlement,
  hasOpenReview: boolean,
  sourceEvidenceRemoved = false,
): "open" | "resolved" | null {
  if (sourceEvidenceRemoved && !settlement.balanced) return "open";
  if (hasOpenReview) return settlement.balanced ? "resolved" : "open";
  return previousPaymentState === "paid" &&
    !settlement.balanced &&
    settlement.sourceProof
    ? "open"
    : null;
}
