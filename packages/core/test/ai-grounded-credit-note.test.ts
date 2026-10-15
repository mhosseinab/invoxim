import { expect, it } from "vitest";
import receipts from "../../../test-design/fixtures/receipts.json";
import { validateExtraction } from "../src/ai/validation";

/**
 * AI-1 / K7 pin: the grounded validator treats `credit-note` as a non-cash
 * document type (shared NON_CASH_DOCUMENT_TYPES). A credit note is not proof
 * of a completed cash refund or of a payment (.agents/rules/04), so grounded
 * cash evidence on a credit note goes to needs-review/semantics. Each case
 * has a positive control that differs only in documentType.
 */
const firstFixture = receipts.fixtures[0];
if (!firstFixture) throw new Error("MISSING_FIXTURE");
const fixture = firstFixture;

const refundText =
  "North Market\nCredit 2026-10-01\nEUR 24.90\nRefund completed EUR 24.90.";

function completedRefund(documentType: string) {
  const data = structuredClone(fixture.expectedExtraction) as {
    documentType: string;
    records: Array<Record<string, unknown>>;
  };
  data.documentType = documentType;
  const record = data.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  Object.assign(record, {
    paymentEvidence: "unknown",
    paymentMethodHint: "unknown",
    paymentAmount: null,
    refundEvidence: "completed",
    refundAmount: "24.90",
    evidence: [
      { field: "merchant", inputPartId: "body-1", quote: "North Market" },
      { field: "documentDate", inputPartId: "body-1", quote: "2026-10-01" },
      { field: "eventDate", inputPartId: "body-1", quote: "2026-10-01" },
      { field: "currency", inputPartId: "body-1", quote: "EUR" },
      { field: "total", inputPartId: "body-1", quote: "24.90" },
      {
        field: "refund",
        inputPartId: "body-1",
        quote: "Refund completed EUR 24.90.",
      },
      {
        field: "refundAmount",
        inputPartId: "body-1",
        quote: "Refund completed EUR 24.90",
      },
    ],
  });
  return validateExtraction(
    JSON.stringify(data),
    [{ id: "body-1", text: refundText }],
    10000,
  );
}

function explicitlyPaid(documentType: string) {
  const data = structuredClone(fixture.expectedExtraction);
  data.documentType = documentType as typeof data.documentType;
  data.records[0]?.evidence.push({
    field: "documentDate",
    inputPartId: "body-1",
    quote: "2026-10-01",
  });
  return validateExtraction(JSON.stringify(data), fixture.inputParts, 10000);
}

it("AI-1 positive control: a grounded receipt with completed refund evidence is accepted", () => {
  expect(completedRefund("receipt")).toMatchObject({
    status: "accepted",
    documentType: "receipt",
  });
});

it("AI-1 grounded credit note with refundEvidence completed is needs-review/semantics because a credit note is not proof of a completed cash refund", () => {
  expect(completedRefund("credit-note")).toEqual({
    status: "needs-review",
    reason: "semantics",
  });
});

it("AI-1 positive control: the grounded explicitly-paid receipt fixture is accepted", () => {
  expect(explicitlyPaid("receipt")).toMatchObject({
    status: "accepted",
    documentType: "receipt",
  });
});

it("AI-1 grounded credit note with paymentEvidence explicitly-paid is needs-review/semantics because credit-note is in the shared non-cash document set", () => {
  expect(explicitlyPaid("credit-note")).toEqual({
    status: "needs-review",
    reason: "semantics",
  });
});
