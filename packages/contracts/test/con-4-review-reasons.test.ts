import { expect, it } from "vitest";
import { CORRECTION_REVIEW_REASONS } from "../../core/src/index";
import {
  PURCHASE_REVIEW_REASONS,
  purchaseReviewSchema,
} from "../src/purchases";

// ---------------------------------------------------------------------------
// CON-4 / OD-2 — `purchaseReviewSchema.reason` derives from
// `PURCHASE_REVIEW_REASONS`, which must stay equal to core
// `CORRECTION_REVIEW_REASONS` (`LEDGER_REVIEW_REASONS` + `document-review`).
// `document-review` is kept: an open operational document-review does not block
// financial restoration (OD-2). contracts cannot import `@invoxim/core`
// (package boundaries), so the equality is pinned here instead of by import.
// ---------------------------------------------------------------------------

const review = (reason: string) => ({
  id: "rev-1",
  documentId: "doc-1",
  purchaseId: "pur-1",
  reason,
  missingFields: [] as string[],
});

it("CON-4 reason enum is derived from PURCHASE_REVIEW_REASONS", () => {
  expect([...purchaseReviewSchema.shape.reason.options]).toEqual([
    ...PURCHASE_REVIEW_REASONS,
  ]);
});

it("CON-4 keeps document-review per OD-2", () => {
  expect(PURCHASE_REVIEW_REASONS).toContain("document-review");
  expect(
    purchaseReviewSchema.safeParse(review("document-review")).success,
  ).toBe(true);
});

it("CON-4 accepts every vocabulary member", () => {
  for (const reason of PURCHASE_REVIEW_REASONS)
    expect(purchaseReviewSchema.safeParse(review(reason)).success).toBe(true);
});

it("CON-4 rejects a reason outside the vocabulary", () => {
  expect(
    purchaseReviewSchema.safeParse(review("not-a-review-reason")).success,
  ).toBe(false);
});

it("CON-4 vocabulary equals core CORRECTION_REVIEW_REASONS", () => {
  expect([...PURCHASE_REVIEW_REASONS]).toEqual([...CORRECTION_REVIEW_REASONS]);
});
