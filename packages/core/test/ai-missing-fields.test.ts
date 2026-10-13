import { extractionSchema } from "@invoxim/contracts";
import { expect, it } from "vitest";
import receipts from "../../../test-design/fixtures/receipts.json";
import {
  validateExtraction,
  validatePersistableAiResult,
} from "../src/ai/validation";
import { planLedgerIngestion } from "../src/ledger/plan";

const fixture = receipts.fixtures[0];
if (!fixture) throw new Error("MISSING_FIXTURE");
it("HOME-05 incomplete extraction preserves only actual missing field names", () => {
  const data = extractionSchema.parse(fixture.expectedExtraction);
  const record = data.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  record.merchant = null;
  record.currency = null;
  record.total = null;
  record.documentDate = null;
  expect(
    validateExtraction(JSON.stringify(data), fixture.inputParts, 10000),
  ).toEqual({
    status: "needs-review",
    reason: "incomplete",
    missingFields: ["merchant", "currency", "total", "documentDate"],
  });
});
it("HOME-05 strict persisted boundary accepts bounded unique missing fields and rejects raw/unknown metadata", () => {
  expect(
    validatePersistableAiResult({
      status: "needs-review",
      reason: "incomplete",
      missingFields: ["total"],
    }),
  ).toEqual({
    status: "needs-review",
    reason: "incomplete",
    missingFields: ["total"],
  });
  for (const value of [
    {
      status: "needs-review",
      reason: "incomplete",
      missingFields: ["raw receipt"],
    },
    { status: "needs-review", reason: "evidence", missingFields: ["total"] },
    {
      status: "needs-review",
      reason: "incomplete",
      missingFields: ["total", "total"],
    },
    {
      status: "needs-review",
      reason: "incomplete",
      missingFields: ["total"],
      raw: "secret",
    },
  ])
    expect(validatePersistableAiResult(value)).toBeNull();
  expect(
    validatePersistableAiResult({
      status: "needs-review",
      reason: "incomplete",
    }),
  ).toEqual({ status: "needs-review", reason: "incomplete" });
});
it("HOME-05 planner copies validated metadata and versions review identity per extraction fingerprint", () => {
  const identity = {
    documentId: "doc",
    contentHash: "hash",
    extractionFingerprint: "v1",
  };
  const result = validatePersistableAiResult({
    status: "needs-review",
    reason: "incomplete",
    missingFields: ["currency", "total"],
  });
  if (!result) throw new Error("EXPECTED_VALID_RESULT");
  const snapshot = {
    observations: [],
    purchases: [],
    events: [],
    decisions: [],
  };
  const one = planLedgerIngestion({ identity, result }, snapshot);
  const two = planLedgerIngestion(
    { identity: { ...identity, extractionFingerprint: "v2" }, result },
    snapshot,
  );
  expect(one.reviews[0]).toMatchObject({
    reason: "extraction-review",
    missingFields: ["currency", "total"],
  });
  expect(one.reviews[0]?.id).not.toBe(two.reviews[0]?.id);
  expect(one.events).toEqual([]);
});
