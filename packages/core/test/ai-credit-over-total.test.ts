import { expect, it } from "vitest";
import receipts from "../../../test-design/fixtures/receipts.json";
import { validateExtraction } from "../src/ai/validation";
import { planLedgerIngestion } from "../src/ledger/plan";
import type { LedgerSnapshot } from "../src/ledger/types";

const fixture = receipts.fixtures[0];
if (!fixture) throw new Error("MISSING_FIXTURE");

const empty = (): LedgerSnapshot => ({
  observations: [],
  purchases: [],
  events: [],
  decisions: [],
});

/**
 * AI-1 / P0.6 / K7: paid=null with credit > total must not be accepted as a
 * settled financial fact. The model validator (validateModelExtraction) rejects
 * `credit > total`; the grounded validator (validateExtraction) and the
 * ingestion planner must agree.
 */
it("AI-1 P0.6 K7 paid=null with credit>total routes to review end-to-end", () => {
  const data = structuredClone(fixture.expectedExtraction);
  const record = data.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  record.paymentAmount = null;
  record.storeCreditAmount = "30.00";
  record.total = "24.90";
  record.paymentEvidence = "explicitly-unpaid";
  record.evidence = record.evidence.filter(
    (item) => item.field !== "paymentAmount",
  );
  for (const item of record.evidence) {
    if (item.field === "payment") item.quote = "Unpaid.";
  }
  record.evidence.push(
    {
      field: "documentDate",
      inputPartId: "body-1",
      quote: "2026-10-01",
    },
    {
      field: "storeCreditAmount",
      inputPartId: "body-1",
      quote: "30.00",
    },
  );
  const parts = [
    {
      id: "body-1",
      text: "North Market\nReceipt 2026-10-01\nTotal EUR 24.90\nStore credit EUR 30.00\nUnpaid.",
    },
  ];
  const validated = validateExtraction(JSON.stringify(data), parts, 10000);
  const identity = {
    documentId: "doc-credit-over-total",
    contentHash: "hash-credit-over-total",
    extractionFingerprint: "v1",
  };
  const plan =
    validated.status === "accepted"
      ? planLedgerIngestion({ identity, result: validated }, empty())
      : null;
  const routedToReview =
    validated.status === "needs-review" || (plan?.reviews.length ?? 0) > 0;
  expect(routedToReview).toBe(true);
  if (validated.status === "accepted" && plan) {
    expect(plan.reviews.map((r) => r.reason).length).toBeGreaterThan(0);
    expect(plan.events).toEqual([]);
  }
});
