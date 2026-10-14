import { calendarDate, minorDigits } from "@invoxim/contracts";

import { parseMinor } from "../money";

export interface AcceptedLedgerEntry {
  kind: "payment" | "refund";
  minor: string;
  currency: string;
  date: string;
  eligible: boolean;
}
export function ledgerTotals(
  entries: readonly AcceptedLedgerEntry[],
  currency: string,
  period?: { startDate: string; endExclusive: string },
) {
  minorDigits(currency);
  if (period) {
    calendarDate(period.startDate);
    calendarDate(period.endExclusive);
    if (period.startDate >= period.endExclusive)
      throw new Error("INVALID_RANGE");
  }
  let paid = 0n,
    refunded = 0n;
  for (const entry of entries) {
    if (!entry.eligible) continue;
    if (entry.currency !== currency) throw new Error("CURRENCY_MISMATCH");
    calendarDate(entry.date);
    const amount = parseMinor(entry.minor);
    if (
      period &&
      (entry.date < period.startDate || entry.date >= period.endExclusive)
    )
      continue;
    if (entry.kind === "payment") paid += amount;
    else if (entry.kind === "refund") refunded += amount;
    else throw new Error("INVALID_ENTRY_KIND");
  }
  return {
    paidMinor: paid.toString(),
    refundedMinor: refunded.toString(),
    netMinor: (paid - refunded).toString(),
  };
}
