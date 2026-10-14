import { expect, it } from "vitest";
import type { PersistedAiRecord } from "../src/ai/types";
import { ledgerTotals, parseMoney } from "../src/index";
import { planLedgerIngestion } from "../src/ledger/plan";
import type { LedgerInput, LedgerSnapshot } from "../src/ledger/types";

/**
 * CORE-4: these scenarios used to assert the deleted test-only
 * `financialEntries` helper (K2 false coverage). They now exercise the
 * production planner `planLedgerIngestion`.
 */

const empty = (): LedgerSnapshot => ({
  observations: [],
  purchases: [],
  events: [],
  decisions: [],
});

type RecordPatch = Partial<
  Omit<PersistedAiRecord, "provenance"> & {
    provenance?: PersistedAiRecord["provenance"];
  }
>;

function input(
  patch: RecordPatch = {},
  documentType:
    | "receipt"
    | "invoice"
    | "order-confirmation"
    | "refund"
    | "credit-note"
    | "statement" = "receipt",
  status: "accepted" | "needs-review" = "accepted",
): LedgerInput {
  return {
    identity: {
      documentId: "doc-1",
      contentHash: "hash-1",
      extractionFingerprint: "v1",
    },
    result:
      status === "needs-review"
        ? { status: "needs-review", reason: "incomplete" }
        : {
            status: "accepted",
            documentType,
            warnings: [],
            records: [
              {
                merchant: "Synthetic shop",
                documentDate: "2026-10-01",
                eventDate: "2026-10-01",
                currency: "EUR",
                total: "24.90",
                tax: null,
                invoiceNumber: null,
                orderReference: null,
                category: "shopping",
                paymentEvidence: "explicitly-paid",
                refundEvidence: "none",
                paymentMethodHint: "card",
                recurringCadence: "unknown",
                paymentAmount: "24.90",
                refundAmount: null,
                storeCreditAmount: null,
                provenance: [],
                ...patch,
              },
            ],
          },
  };
}

function planOf(
  patch: RecordPatch = {},
  documentType:
    | "receipt"
    | "invoice"
    | "order-confirmation"
    | "refund"
    | "credit-note"
    | "statement" = "receipt",
  status: "accepted" | "needs-review" = "accepted",
) {
  return planLedgerIngestion(input(patch, documentType, status), empty());
}

it("MONEY-05 unpaid invoice is not spending; verified receipt is payment", () => {
  const invoice = planOf(
    { paymentEvidence: "explicitly-unpaid", paymentAmount: null },
    "invoice",
  );
  expect(invoice.events).toEqual([]);
  const receipt = planOf();
  expect(receipt.events.map((event) => event.amountMinor)).toEqual([2490]);
  expect(
    ledgerTotals(
      receipt.events.map((event) => ({
        kind: event.kind === "payment" ? "payment" : "refund",
        minor: String(event.amountMinor),
        currency: event.currency,
        date: event.eventDate,
        eligible: event.eligible,
      })),
      "EUR",
    ).paidMinor,
  ).toBe("2490");
  const unverified = planOf({}, "receipt", "needs-review");
  expect(unverified.events).toEqual([]);
  expect(unverified.reviews.map((review) => review.reason)).toContain(
    "extraction-review",
  );
});

it("MONEY-06 missing total needs review; explicit zero is distinct valid amount", () => {
  expect(
    planOf({ total: null, paymentAmount: null }).reviews.map((r) => r.reason),
  ).toContain("incomplete-financial-facts");
  expect(planOf({ total: null, paymentAmount: null }).events).toEqual([]);
  const zero = planOf({ total: "0.00", paymentAmount: "0.00" });
  expect(zero.events.map((event) => event.amountMinor)).toEqual([0]);
  expect(zero.reviews).toEqual([]);
  expect(parseMoney(null, "EUR")).toBeNull();
});

it("cash event magnitude differs from document total or pending refund", () => {
  expect(
    planOf({ total: "100.00", paymentAmount: "70.00" }).events[0]?.amountMinor,
  ).toBe(7000);
  expect(
    planOf({ total: "100.00", paymentAmount: "50.00" }).events[0]?.amountMinor,
  ).toBe(5000);
  expect(
    planOf(
      {
        paymentEvidence: "unknown",
        paymentAmount: null,
        refundEvidence: "pending",
        refundAmount: "5.00",
      },
      "refund",
    ).events,
  ).toEqual([]);
  expect(planOf({ paymentMethodHint: "store-credit" }).events).toEqual([]);
  expect(planOf({}, "statement").events).toEqual([]);
});

it("MONEY-03 planner keeps the printed calendar date on the cash event", () => {
  expect(planOf().events[0]?.eventDate).toBe("2026-10-01");
});

it("MONEY-05 unknown payment and no refund stays review; unpaid is known", () => {
  expect(
    planOf({
      paymentEvidence: "unknown",
      paymentAmount: null,
      refundEvidence: "none",
    }).reviews.map((review) => review.reason),
  ).toContain("unknown-payment");
  const unpaid = planOf(
    {
      paymentEvidence: "explicitly-unpaid",
      paymentAmount: null,
    },
    "invoice",
  );
  expect(unpaid.reviews).toEqual([]);
  expect(unpaid.events).toEqual([]);
  const pending = planOf(
    {
      paymentEvidence: "unknown",
      paymentAmount: null,
      refundEvidence: "pending",
      refundAmount: "5.00",
    },
    "refund",
  );
  expect(pending.reviews).toEqual([]);
  expect(pending.events).toEqual([]);
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
  const completed = planOf(
    {
      paymentEvidence: "unknown",
      paymentAmount: null,
      refundEvidence: "completed",
      refundAmount: "5.00",
    },
    "credit-note",
  );
  expect(completed.events).toEqual([]);
  expect(completed.reviews.map((review) => review.reason)).toContain(
    "credit-note-completion",
  );
  const none = planOf(
    {
      paymentEvidence: "unknown",
      paymentAmount: null,
      refundEvidence: "none",
    },
    "credit-note",
  );
  expect(none.events).toEqual([]);
  expect(none.reviews).toEqual([]);
});
