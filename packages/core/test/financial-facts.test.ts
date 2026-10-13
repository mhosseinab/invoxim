import { expect, it } from "vitest";
import type { VerifiedFinancialFact } from "../src/index";
import {
  financialEntries,
  ledgerTotals,
  parseMoney,
  timestampDate,
} from "../src/index";

const paid: VerifiedFinancialFact = {
  verified: true,
  documentType: "receipt",
  total: "24.90",
  currency: "EUR",
  date: "2026-10-01",
  paymentEvidence: "explicitly-paid",
  refundEvidence: "none",
  paymentAmount: "24.90",
  refundAmount: null,
  paymentMethodHint: "card",
};
it("MONEY-05 unpaid invoice is not spending; verified receipt is payment", () => {
  const invoice = {
    ...paid,
    documentType: "invoice" as const,
    paymentEvidence: "explicitly-unpaid" as const,
    paymentAmount: null,
  };
  expect(financialEntries(invoice).entries).toEqual([]);
  const entries = financialEntries(paid).entries;
  expect(ledgerTotals(entries, "EUR").paidMinor).toBe("2490");
  expect(financialEntries({ ...paid, verified: false }).entries).toEqual([]);
});
it("MONEY-06 missing total needs review; explicit zero is distinct valid amount", () => {
  expect(
    financialEntries({ ...paid, total: null, paymentAmount: null }),
  ).toEqual({ entries: [], needsReview: true });
  expect(
    financialEntries({ ...paid, total: "0.00", paymentAmount: "0.00" }),
  ).toEqual({
    entries: [
      {
        kind: "payment",
        minor: "0",
        currency: "EUR",
        date: "2026-10-01",
        eligible: true,
      },
    ],
    needsReview: false,
  });
  expect(parseMoney(null, "EUR")).toBeNull();
});
it("cash event magnitude differs from document total or pending refund", () => {
  expect(
    financialEntries({ ...paid, total: "100.00", paymentAmount: "70.00" })
      .entries[0]?.minor,
  ).toBe("7000");
  expect(
    financialEntries({ ...paid, total: "100.00", paymentAmount: "50.00" })
      .entries[0]?.minor,
  ).toBe("5000");
  expect(
    financialEntries({
      ...paid,
      paymentEvidence: "unknown",
      paymentAmount: null,
      documentType: "refund",
      refundEvidence: "pending",
      refundAmount: "5.00",
    }).entries,
  ).toEqual([]);
  expect(
    financialEntries({ ...paid, paymentMethodHint: "store-credit" }).entries,
  ).toEqual([]);
  expect(
    financialEntries({ ...paid, documentType: "statement" }).entries,
  ).toEqual([]);
});
it("MONEY-03 same UTC instant in two zones; printed date stays unchanged", () => {
  expect(timestampDate("2026-10-01T00:30:00Z", "Europe/Vienna")).toBe(
    "2026-10-01",
  );
  expect(timestampDate("2026-10-01T00:30:00Z", "America/Los_Angeles")).toBe(
    "2026-09-30",
  );
  expect(financialEntries(paid).entries[0]?.date).toBe("2026-10-01");
});
it("MONEY-03 invalid clock values cannot normalize to another date", () => {
  for (const instant of [
    "2026-10-01T24:00:00Z",
    "2026-10-01T23:60:00Z",
    "2026-10-01T23:59:60Z",
  ])
    expect(() => timestampDate(instant, "UTC")).toThrow("INVALID_INSTANT");
});
it("MONEY-05 unknown payment and no refund stays review; unpaid is known", () => {
  expect(
    financialEntries({
      ...paid,
      paymentEvidence: "unknown",
      paymentAmount: null,
      refundEvidence: "none",
    }),
  ).toEqual({ entries: [], needsReview: true });
  expect(
    financialEntries({
      ...paid,
      documentType: "invoice",
      paymentEvidence: "explicitly-unpaid",
      paymentAmount: null,
    }),
  ).toEqual({ entries: [], needsReview: false });
  expect(
    financialEntries({
      ...paid,
      documentType: "refund",
      paymentEvidence: "unknown",
      paymentAmount: null,
      refundEvidence: "pending",
      refundAmount: "5.00",
    }),
  ).toEqual({ entries: [], needsReview: false });
});
it("MONEY-02 whitespace in decimal/JSON amounts is not canonical money", () => {
  expect(() => parseMoney("1\n", "EUR")).toThrow("INVALID_AMOUNT");
  expect(() =>
    ledgerTotals(
      [
        {
          kind: "payment",
          minor: "10\n",
          date: "2026-01-01",
          currency: "EUR",
          eligible: true,
        },
      ],
      "EUR",
    ),
  ).toThrow("INVALID_AMOUNT");
});
it("completed cash-refund credit note stays review rather than silently discarded", () => {
  expect(
    financialEntries({
      ...paid,
      documentType: "credit-note",
      paymentEvidence: "unknown",
      paymentAmount: null,
      refundEvidence: "completed",
      refundAmount: "5.00",
    }),
  ).toEqual({ entries: [], needsReview: true });
  expect(
    financialEntries({
      ...paid,
      documentType: "credit-note",
      paymentEvidence: "unknown",
      paymentAmount: null,
      refundEvidence: "none",
    }),
  ).toEqual({ entries: [], needsReview: false });
});
