import { formatMinor, ledgerTotals } from "@invoxim/core";
import { demoFixture } from "./demo-fixture";

export const demo = demoFixture;
export type DemoPurchase = (typeof demo.purchases)[number];
export function totals(purchase?: DemoPurchase) {
  const entries = demo.ledgerEntries
    .filter((entry) => !purchase || entry.purchaseId === purchase.id)
    .map((entry) => ({
      kind: entry.kind,
      minor: entry.amountMinor,
      currency: demo.currency,
      date: entry.date,
      eligible: true,
    }));
  return ledgerTotals(
    entries,
    demo.currency,
    purchase
      ? undefined
      : { startDate: demo.range.start, endExclusive: demo.range.endExclusive },
  );
}
export function money(minor: string) {
  return `${demo.currency} ${formatMinor(minor, demo.currency)}`;
}
