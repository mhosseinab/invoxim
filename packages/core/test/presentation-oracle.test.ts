import { expect, it } from "vitest";
import fixture from "../../../test-design/fixtures/presentation-demo.json";
import type { AcceptedLedgerEntry } from "../src/index";
import { ledgerTotals } from "../src/index";
import { requireFixture } from "./fixture-value";

it("PRESENT-03 synthetic fixture independent text oracle preserves invoices and distinct receipts", () => {
  const oracleEntries = fixture.evidence
    .filter((e) => e.kind === "payment" || e.kind === "refund")
    .map((e) => {
      const match = requireFixture(/EUR ([0-9]+)\.([0-9]{2})/.exec(e.text));
      const date = requireFixture(
        requireFixture(/on (\d{4}-\d{2}-\d{2})/.exec(e.text))[1],
      );
      return {
        evidenceId: e.id,
        kind: e.kind as "payment" | "refund",
        minor: (
          BigInt(requireFixture(match[1])) * 100n +
          BigInt(requireFixture(match[2]))
        ).toString(),
        currency: "EUR",
        date,
        eligible: true,
      };
    });
  const entries: AcceptedLedgerEntry[] = fixture.ledgerEntries.map((e) => ({
    kind: e.kind as "payment" | "refund",
    minor: e.amountMinor,
    currency: "EUR",
    date: e.date,
    eligible: true,
  }));
  for (const entry of fixture.ledgerEntries) {
    const oracle = requireFixture(
      oracleEntries.find((e) => e.evidenceId === entry.evidenceId),
    );
    expect(entry.amountMinor).toBe(oracle.minor);
    expect(entry.kind).toBe(oracle.kind);
    expect(entry.date).toBe(oracle.date);
  }
  expect(
    ledgerTotals(entries, "EUR", {
      startDate: fixture.range.start,
      endExclusive: fixture.range.endExclusive,
    }),
  ).toEqual({ paidMinor: "15000", refundedMinor: "3000", netMinor: "12000" });
  for (const purchase of fixture.purchases) {
    const totals = ledgerTotals(
      fixture.ledgerEntries
        .filter((e) => e.purchaseId === purchase.id)
        .map((e) => ({
          kind: e.kind as "payment" | "refund",
          minor: e.amountMinor,
          currency: "EUR",
          date: e.date,
          eligible: true,
        })),
      "EUR",
    );
    expect(totals).toEqual({
      paidMinor: purchase.expectedPaidMinor,
      refundedMinor: purchase.expectedRefundedMinor,
      netMinor: purchase.expectedNetMinor,
    });
  }
  expect(fixture.purchases).toHaveLength(4);
  expect(fixture.evidence).toHaveLength(7);
  expect(oracleEntries.filter((e) => e.minor === "1500")).toHaveLength(2);
});
