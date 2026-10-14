import { describe, expect, it } from "vitest";
import {
  type CorrectionEventFact,
  validateEntryChange,
  validateRefundAllocation,
} from "../src/corrections/validation";

const payment: CorrectionEventFact = {
  id: "payment",
  observationId: "paid-proof",
  kind: "payment",
  amountMinor: "100",
  currency: "EUR",
  eventDate: "2026-01-01",
  origin: "source",
  eligible: true,
  accepted: true,
  evidenceCode: "explicitly-paid",
};
const refund: CorrectionEventFact = {
  ...payment,
  id: "refund",
  observationId: "refund-proof",
  kind: "refund",
  amountMinor: "30",
  evidenceCode: "completed-refund",
};

describe("correction cash allocation", () => {
  it("rejects zeroing the last payment backing a source refund", () => {
    expect(() =>
      validateEntryChange(payment, { amountMinor: "0" }, [payment, refund]),
    ).toThrow("CONFLICT");
  });
  it("allows an explicit standalone user refund without inventing a payment", () => {
    expect(() =>
      validateRefundAllocation([
        { ...refund, origin: "user-confirmed", observationId: null },
      ]),
    ).not.toThrow();
  });
  it("permits zeroing a payment that has no dependent refund", () => {
    expect(() =>
      validateEntryChange(payment, { amountMinor: "0" }, [payment]),
    ).not.toThrow();
  });
  it("rejects a refund above the remaining known payment in the same currency", () => {
    expect(() =>
      validateEntryChange(payment, { amountMinor: "20" }, [payment, refund]),
    ).toThrow("CONFLICT");
  });
});

import {
  type CorrectionReviewFact,
  restorationEligibility,
} from "../src/corrections/validation";

const refundWarning: CorrectionReviewFact = {
  id: "warning",
  observationId: "refund-proof",
  reason: "event-conflict",
  blockingScope: "financial",
  status: "open",
  missingFields: [],
  purchaseId: "synthetic",
};
it("EDIT-05 restore retains independently proved payment with an unrelated refund blocker", () => {
  expect(restorationEligibility(payment, [refundWarning])).toBe(true);
  expect(restorationEligibility(refund, [refundWarning])).toBe(false);
});
it("EDIT-05 restore never clears a blocker on the same source proof", () => {
  expect(
    restorationEligibility(payment, [
      { ...refundWarning, observationId: payment.observationId },
    ]),
  ).toBe(false);
});
