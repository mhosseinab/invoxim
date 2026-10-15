import { PURCHASE_REVIEW_REASONS } from "@invoxim/contracts";
import { expect, it } from "vitest";
import { CORRECTION_REVIEW_REASONS } from "../src/index";

// CON-4 / OD-2 parity: contracts `PURCHASE_REVIEW_REASONS` (which
// `purchaseReviewSchema.reason` derives from) must equal core
// `CORRECTION_REVIEW_REASONS`. Lives in core because core may import
// `@invoxim/contracts` through its package root; contracts may not import core.
it("CON-4 vocabulary equals core CORRECTION_REVIEW_REASONS", () => {
  expect([...PURCHASE_REVIEW_REASONS]).toEqual([...CORRECTION_REVIEW_REASONS]);
});
