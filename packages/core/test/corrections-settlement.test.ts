import { describe, expect, it } from "vitest";
import {
  allocationReviewStatus,
  type CorrectionSettlementEvent,
  evaluateCorrectionSettlement,
} from "../src/corrections/settlement";

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
