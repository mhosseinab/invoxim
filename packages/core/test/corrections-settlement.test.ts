import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  allocationReviewStatus,
  type CorrectionSettlementEvent,
  evaluateCorrectionSettlement,
  settlementEvents,
} from "../src/corrections/settlement";
import type { CorrectionEventFact } from "../src/corrections/validation";

const purchase = { currency: "EUR", totalMinor: "10000", paymentState: "paid" };
const payment: CorrectionSettlementEvent = {
  kind: "payment",
  amountMinor: "5000",
  currency: "EUR",
  origin: "user-confirmed",
  supported: true,
};
describe("correction settlement evidence", () => {
  it("sums every independently confirmed installment exactly", () => {
    expect(
      evaluateCorrectionSettlement(purchase, [payment, payment], []),
    ).toMatchObject({
      supportedMinor: "10000",
      paymentState: "paid",
      balanced: true,
    });
  });
  it("uses the largest compatible credit proof without counting duplicate invoice or receipt credit twice", () => {
    expect(
      evaluateCorrectionSettlement(
        purchase,
        [{ ...payment, amountMinor: "6000" }],
        [
          { currency: "EUR", totalMinor: "10000", creditMinor: "4000" },
          { currency: "EUR", totalMinor: "10000", creditMinor: "4000" },
        ],
      ),
    ).toMatchObject({
      supportedMinor: "10000",
      paymentState: "paid",
      balanced: true,
    });
  });
  it("does not borrow credit proof for a changed gross or currency", () => {
    expect(
      evaluateCorrectionSettlement(
        { ...purchase, totalMinor: "12000" },
        [payment],
        [{ currency: "EUR", totalMinor: "10000", creditMinor: "7000" }],
      ),
    ).toMatchObject({
      supportedMinor: "5000",
      paymentState: "partially_paid",
      balanced: false,
    });
  });
  it("keeps an allocation question open with a partial or mixed-currency confirmation", () => {
    expect(
      allocationReviewStatus(
        "partially_paid",
        evaluateCorrectionSettlement(purchase, [payment], []),
        true,
      ),
    ).toBe("open");
    expect(
      allocationReviewStatus(
        "paid",
        evaluateCorrectionSettlement(
          purchase,
          [payment, payment, { ...payment, currency: "USD" }],
          [],
        ),
        true,
      ),
    ).toBe("open");
  });
  it("closes only the fully supported compatible remainder", () => {
    expect(
      allocationReviewStatus(
        "partially_paid",
        evaluateCorrectionSettlement(purchase, [payment, payment], []),
        true,
      ),
    ).toBe("resolved");
  });
  it("leaves unrelated source-blocked cash unsupported without losing independent user cash", () => {
    expect(
      evaluateCorrectionSettlement(
        purchase,
        [payment, { ...payment, origin: "source", supported: false }],
        [],
      ),
    ).toMatchObject({ supportedMinor: "5000", paymentState: "partially_paid" });
  });
});

it("CORE-6 supported refunds suppress unpaid fallback without subtracting from paid cash", () => {
  const unpaid = { ...purchase, paymentState: "unpaid" };
  const refund: CorrectionSettlementEvent = { ...payment, kind: "refund" };
  expect(evaluateCorrectionSettlement(unpaid, [refund], [])).toMatchObject({
    paymentState: "unknown",
    supportedMinor: "0",
  });
  expect(
    evaluateCorrectionSettlement(unpaid, [payment, payment, refund], []),
  ).toMatchObject({
    paymentState: "paid",
    supportedMinor: "10000",
  });
  expect(
    evaluateCorrectionSettlement(unpaid, [{ ...refund, supported: false }], []),
  ).toMatchObject({
    paymentState: "unpaid",
    supportedMinor: "0",
  });
});

describe("settlement eligibility (rule 04: excluded cash never raises payment state)", () => {
  const confirmed: CorrectionEventFact = {
    id: "entry-excluded",
    observationId: null,
    documentId: null,
    kind: "payment",
    amountMinor: "10000",
    currency: "EUR",
    eventDate: "2026-01-01",
    origin: "user-confirmed",
    eligible: false,
    accepted: true,
    evidenceCode: "manual-confirmation",
  };
  it("treats proven but ineligible (excluded/merged) cash as unsupported", () => {
    expect(settlementEvents([confirmed], [])).toEqual([
      expect.objectContaining({ supported: false }),
    ]);
    expect(
      evaluateCorrectionSettlement(
        { ...purchase, paymentState: "unknown" },
        settlementEvents([confirmed], []),
        [],
      ),
    ).toMatchObject({
      paymentState: "unknown",
      supportedMinor: "0",
      sourceProof: false,
    });
  });
  it("property: ineligible entries never change the settlement outcome", () => {
    const fact = fc.record({
      kind: fc.constantFrom("payment" as const, "refund" as const),
      amountMinor: fc.bigInt({ min: 0n, max: 10n ** 12n }).map(String),
      currency: fc.constantFrom("EUR", "USD"),
      origin: fc.constantFrom("source" as const, "user-confirmed" as const),
      eligible: fc.boolean(),
      accepted: fc.boolean(),
      evidenceCode: fc.constantFrom(
        null,
        "explicitly-paid",
        "completed-refund",
        "manual-confirmation",
      ),
    });
    fc.assert(
      fc.property(
        fc.array(fact, { maxLength: 8 }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }).map(String),
        fc.constantFrom("unknown", "unpaid", "partially_paid", "paid"),
        (raw, totalMinor, paymentState) => {
          const entries: CorrectionEventFact[] = raw.map((item, index) => ({
            ...item,
            id: `entry-${index}`,
            observationId: `obs-${index}`,
            documentId: `doc-${index}`,
            eventDate: "2026-01-01",
          }));
          const target = { currency: "EUR", totalMinor, paymentState };
          expect(
            evaluateCorrectionSettlement(
              target,
              settlementEvents(entries, []),
              [],
            ),
          ).toEqual(
            evaluateCorrectionSettlement(
              target,
              settlementEvents(
                entries.filter((entry) => entry.eligible),
                [],
              ),
              [],
            ),
          );
        },
      ),
    );
  });
});
