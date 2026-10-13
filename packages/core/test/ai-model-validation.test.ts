import type { Extraction } from "@invoxim/contracts";
import { expect, it } from "vitest";
import { createInferenceEngine } from "../src/ai/engine";
import type { AiUsageStore, ApprovedAiConfig } from "../src/ai/types";
import { validateModelExtraction } from "../src/ai/validation";
import type { TenantContext } from "../src/tenant-context";

const parts = [
  {
    id: "html",
    interpretation: "model" as const,
    mimeType: "text/html" as const,
    text: "<h1>Épicerie &amp; Cie</h1><p>Date : <b>13 octobre 2026</b></p><p>Total : <b>15,00 &euro;</b></p><p>Non payé</p>",
  },
];
function candidate(): Extraction {
  return {
    schemaVersion: 1,
    documentType: "invoice",
    warnings: [],
    records: [
      {
        merchant: "Épicerie & Cie",
        documentDate: "2026-10-13",
        eventDate: null,
        currency: "EUR",
        total: "15.00",
        tax: null,
        invoiceNumber: null,
        orderReference: null,
        paymentReference: null,
        refundReference: null,
        category: "groceries",
        paymentEvidence: "explicitly-unpaid",
        refundEvidence: "none",
        paymentMethodHint: "unknown",
        recurringCadence: "unknown",
        paymentAmount: null,
        refundAmount: null,
        storeCreditAmount: null,
        evidence: [
          { field: "merchant", inputPartId: "html", quote: "Épicerie & Cie" },
          {
            field: "documentDate",
            inputPartId: "html",
            quote: "13 octobre 2026",
          },
          { field: "currency", inputPartId: "html", quote: "€" },
          { field: "total", inputPartId: "html", quote: "Total : 15,00 €" },
          { field: "payment", inputPartId: "html", quote: "Non payé" },
        ],
      },
    ],
  };
}
function result(output: Extraction) {
  return validateModelExtraction(JSON.stringify(output), parts, 10000);
}
it("MODEL-01 accepts foreign-language raw HTML structured facts without literal text interpretation", () => {
  expect(result(candidate()).status).toBe("accepted");
  expect(JSON.stringify(result(candidate()))).not.toContain("quote");
});
it("MODEL-02 rejects invalid calendar dates", () => {
  const output = candidate();
  recordOf(output).documentDate = "2026-02-30";
  expect(result(output)).toEqual({ status: "needs-review", reason: "schema" });
});
it.each(["15.001", "15.000"])("MODEL-03 rejects EUR precision %s", (amount) => {
  const output = candidate();
  recordOf(output).total = amount;
  expect(result(output)).toEqual({ status: "needs-review", reason: "money" });
});
it("MODEL-04 absent date stays a missing-fact review", () => {
  const output = candidate();
  recordOf(output).documentDate = null;
  expect(result(output)).toEqual({
    status: "needs-review",
    reason: "incomplete",
    missingFields: ["documentDate"],
  });
});
it("MODEL-05 rejects evidence from an unsupplied source part", () => {
  const output = candidate();
  firstEvidence(recordOf(output)).inputPartId = "another-email";
  expect(result(output)).toEqual({
    status: "needs-review",
    reason: "evidence",
  });
});
it("MODEL-06 rejects paid invoice without cash date and amount", () => {
  const output = candidate();
  recordOf(output).paymentEvidence = "explicitly-paid";
  expect(result(output)).toEqual({
    status: "needs-review",
    reason: "semantics",
  });
});
it("MODEL-07 rejects amount inconsistent with unpaid typed evidence", () => {
  const output = candidate();
  recordOf(output).paymentAmount = "15.00";
  recordOf(output).evidence.push({
    field: "paymentAmount",
    inputPartId: "html",
    quote: "15,00 €",
  });
  expect(result(output)).toEqual({
    status: "needs-review",
    reason: "semantics",
  });
});
it("MODEL-08 cash requires explicit typed evidence, amount and event date citations", () => {
  const output = candidate();
  const record = recordOf(output);
  record.paymentEvidence = "explicitly-paid";
  record.paymentAmount = "15.00";
  record.eventDate = "2026-10-13";
  record.evidence.push(
    { field: "paymentAmount", inputPartId: "html", quote: "Payé 15,00 €" },
    {
      field: "eventDate",
      inputPartId: "html",
      quote: "Payé le 13 octobre 2026",
    },
  );
  expect(result(output).status).toBe("accepted");
  record.evidence = record.evidence.filter((e) => e.field !== "payment");
  expect(result(output)).toEqual({
    status: "needs-review",
    reason: "evidence",
  });
});
it("MODEL-09 independent payment reference cannot reuse an invoice reference", () => {
  const output = candidate();
  const record = recordOf(output);
  record.invoiceNumber = "INV-1";
  record.paymentReference = "INV-1";
  record.evidence.push(
    { field: "invoiceNumber", inputPartId: "html", quote: "Facture INV-1" },
    { field: "paymentReference", inputPartId: "html", quote: "INV-1" },
  );
  expect(result(output)).toEqual({
    status: "needs-review",
    reason: "semantics",
  });
});

function recordOf(output: Extraction) {
  const record = output.records[0];
  if (!record) throw new Error("Missing synthetic record");
  return record;
}
function firstEvidence(record: Extraction["records"][number]) {
  const evidence = record.evidence[0];
  if (!evidence) throw new Error("Missing synthetic evidence");
  return evidence;
}
it("MODEL-10 engine routes only wholly model-interpreted originals to the direct validator and meters completion", async () => {
  const config: ApprovedAiConfig = {
    destinationId: "synthetic",
    modelId: "synthetic",
    mode: "hosted",
    settingsRevision: 1,
    consentId: "synthetic",
    fingerprint: "synthetic",
    promptVersion: "invoice-extraction-v5",
    schemaVersion: 1,
    maxInputBytes: 10000,
    maxOutputBytes: 10000,
    maxOutputTokens: 1000,
    maxAttempts: 1,
    reservationUnits: 2000,
  };
  let reserves = 0,
    settlements = 0,
    completions = 0;
  const store: AiUsageStore = {
    checkpoint: async () => ({ status: "ready" }),
    reserve: async () => {
      reserves++;
      return "reserved";
    },
    authorize: async () => true,
    settle: async () => {
      settlements++;
    },
    complete: async () => {
      completions++;
      return true;
    },
  };
  const engine = createInferenceEngine({
    store,
    extractor: {
      extract: async () => ({
        status: "ok",
        output: JSON.stringify(candidate()),
        finish: "complete",
        usage: { input: 10, output: 10, other: 0, source: "reported" },
      }),
    },
  });
  const run = async (inputs: typeof parts | { id: string; text: string }[]) =>
    engine.extract(
      { userId: "synthetic-user", authority: "job" } as TenantContext,
      {
        documentId: "synthetic-document",
        contentHash: "synthetic-hash",
        extractionVersion: "invoice-extraction-v5",
      },
      inputs,
      config,
    );
  expect((await run(parts)).status).toBe("accepted");
  expect(await run(parts.map(({ id, text }) => ({ id, text })))).toEqual({
    status: "needs-review",
    reason: "evidence",
  });
  expect([reserves, settlements, completions]).toEqual([2, 2, 2]);
});
it("MODEL-11 rejects completed refund without date, amount or typed refund citation", () => {
  const output = candidate();
  recordOf(output).refundEvidence = "completed";
  expect(result(output).status).toBe("needs-review");
});
it("MODEL-12 rejects tax exceeding gross total", () => {
  const output = candidate();
  const record = recordOf(output);
  record.tax = "20.00";
  record.evidence.push({
    field: "tax",
    inputPartId: "html",
    quote: "TVA 20,00",
  });
  expect(result(output)).toEqual({
    status: "needs-review",
    reason: "semantics",
  });
});
it("MODEL-13 rejects unsupported currency", () => {
  const output = candidate();
  recordOf(output).currency = "ZZZ";
  expect(result(output)).toEqual({ status: "needs-review", reason: "money" });
});
