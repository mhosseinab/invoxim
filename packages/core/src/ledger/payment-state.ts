import type { LedgerPurchase } from "./types";

type PaymentState = LedgerPurchase["paymentState"];

/** Derive state after each caller has selected compatible settlement evidence. */
export function derivePaymentState({
  totalMinor,
  settledMinor,
  fullSettlement = false,
  zeroPaymentState = "unknown",
}: {
  readonly totalMinor: bigint;
  readonly settledMinor: bigint;
  /** A complete document proof or retained paid evidence, independent of cash. */
  readonly fullSettlement?: boolean;
  /** Context determines whether zero cash retains a recorded state. */
  readonly zeroPaymentState?: PaymentState;
}): PaymentState {
  if (fullSettlement) return "paid";
  if (settledMinor === 0n) return zeroPaymentState;
  return settledMinor >= totalMinor ? "paid" : "partially_paid";
}
