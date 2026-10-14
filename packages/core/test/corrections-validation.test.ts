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
  assertReviewAction,
  type CorrectionReviewFact,
  restorationEligibility,
  reviewActions,
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

// OD-2: an open operational document-review must not block financial restoration.
it("OD-2 operational document-review does not block financial restoration", () => {
  const operationalDocumentReview: CorrectionReviewFact = {
    id: "doc-review",
    observationId: null,
    documentId: "doc-1",
    reason: "document-review",
    blockingScope: "operational",
    status: "open",
    missingFields: [],
    purchaseId: null,
  };
  expect(restorationEligibility(payment, [operationalDocumentReview])).toBe(
    true,
  );
  expect(restorationEligibility(refund, [operationalDocumentReview])).toBe(
    true,
  );
});
it("OD-2 financial extraction-review with matching document blocks restoration", () => {
  const financialBlocker: CorrectionReviewFact = {
    id: "fin-block",
    observationId: null,
    documentId: "doc-1",
    reason: "extraction-review",
    blockingScope: "financial",
    status: "open",
    missingFields: [],
    purchaseId: null,
  };
  const entryWithDoc = { ...payment, documentId: "doc-1" };
  expect(restorationEligibility(entryWithDoc, [financialBlocker])).toBe(false);
});

// K8: reviewActions vocabulary — pin the action set for key review shapes.
it("reviewActions offers dismiss-operational for an open operational review", () => {
  const operational: CorrectionReviewFact = {
    id: "op",
    observationId: null,
    reason: "document-review",
    blockingScope: "operational",
    status: "open",
    missingFields: [],
    purchaseId: null,
  };
  expect(reviewActions(operational)).toContain("dismiss-operational");
});
it("reviewActions returns empty for a resolved review", () => {
  expect(reviewActions({ ...refundWarning, status: "resolved" })).toEqual([]);
});

// total/totalMinor unification: assertReviewAction maps the change key onto
// the missingFields vocabulary (totalMinor → total).
it("assertReviewAction accepts totalMinor change keyed to total in missingFields", () => {
  const review: CorrectionReviewFact = {
    id: "missing",
    observationId: null,
    reason: "extraction-review",
    blockingScope: "financial",
    status: "open",
    missingFields: ["total"],
    purchaseId: "synthetic",
  };
  expect(reviewActions(review)).toContain("correct-missing-fields");
  expect(() =>
    assertReviewAction(review, {
      version: 1,
      action: "correct-missing-fields",
      purchaseVersion: 1,
      changes: { totalMinor: "12345" },
    }),
  ).not.toThrow();
});
it("assertReviewAction rejects a change key that is not in missingFields", () => {
  const review: CorrectionReviewFact = {
    id: "missing",
    observationId: null,
    reason: "extraction-review",
    blockingScope: "financial",
    status: "open",
    missingFields: ["merchant"],
    purchaseId: "synthetic",
  };
  expect(() =>
    assertReviewAction(review, {
      version: 1,
      action: "correct-missing-fields",
      purchaseVersion: 1,
      changes: { totalMinor: "12345" },
    }),
  ).toThrow("INVALID_REQUEST");
});
