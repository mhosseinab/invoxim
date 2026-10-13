import { type Extraction, extractionSchema } from "@invoxim/contracts";
import { expect, it } from "vitest";
import { validateExtraction } from "../src/ai/validation";

function candidate(printedDate: string | null): {
  output: Extraction;
  text: string;
} {
  const text = `Synthetic Store\n${printedDate ? `Invoice date: ${printedDate}\n` : ""}Total EUR 15.00\nUnpaid invoice`;
  const output = extractionSchema.parse({
    schemaVersion: 1,
    documentType: "invoice",
    warnings: [],
    records: [
      {
        merchant: "Synthetic Store",
        documentDate: printedDate ? "2026-10-13" : null,
        eventDate: null,
        currency: "EUR",
        total: "15.00",
        tax: null,
        invoiceNumber: null,
        orderReference: null,
        paymentReference: null,
        refundReference: null,
        category: "software",
        paymentEvidence: "explicitly-unpaid",
        refundEvidence: "none",
        paymentMethodHint: "unknown",
        recurringCadence: "unknown",
        paymentAmount: null,
        refundAmount: null,
        storeCreditAmount: null,
        evidence: [
          { field: "merchant", inputPartId: "body", quote: "Synthetic Store" },
          { field: "currency", inputPartId: "body", quote: "EUR" },
          { field: "total", inputPartId: "body", quote: "Total EUR 15.00" },
          { field: "payment", inputPartId: "body", quote: "Unpaid invoice" },
          ...(printedDate
            ? [
                {
                  field: "documentDate",
                  inputPartId: "body",
                  quote: printedDate,
                },
              ]
            : []),
        ],
      },
    ],
  });
  return { output, text };
}
it.each(["October 13, 2026", "13 October 2026", "Oct 13 2026", "13 Oct. 2026"])(
  "DATE-01 normalizes explicitly printed %s without inventing a financial date",
  (printedDate) => {
    const { output, text } = candidate(printedDate);
    expect(
      validateExtraction(JSON.stringify(output), [{ id: "body", text }], 10000)
        .status,
    ).toBe("accepted");
  },
);
it("DATE-02 true absence remains a missing-date review even when email transport context has a date", () => {
  const { output, text } = candidate(null);
  expect(
    validateExtraction(
      JSON.stringify(output),
      [{ id: "body", text: `Email sent date: 2026-10-13\n${text}` }],
      10000,
    ),
  ).toEqual({
    status: "needs-review",
    reason: "incomplete",
    missingFields: ["documentDate"],
  });
});
it.each(["10/13/2026", "13/10/2026", "10/11/2026", "12026-10-13"])(
  "DATE-03 unsupported or ambiguous printed date %s cannot authorize a normalized date",
  (printedDate) => {
    const { output, text } = candidate(printedDate);
    expect(
      validateExtraction(JSON.stringify(output), [{ id: "body", text }], 10000),
    ).toEqual({ status: "needs-review", reason: "date" });
  },
);
it("CURRENCY-01 the unambiguous euro symbol grounds EUR without requiring a printed ISO code", () => {
  const { output, text } = candidate("October 13, 2026");
  const record = output.records[0];
  if (!record) throw new Error("synthetic record missing");
  for (const evidence of record.evidence)
    evidence.quote = evidence.quote.replaceAll("EUR", "€");
  expect(
    validateExtraction(
      JSON.stringify(output),
      [{ id: "body", text: text.replaceAll("EUR", "€") }],
      10000,
    ).status,
  ).toBe("accepted");
});
it.each(["$", "£", "¥"])(
  "CURRENCY-02 %s cannot ground EUR through an invented symbol mapping",
  (symbol) => {
    const { output, text } = candidate("October 13, 2026");
    const record = output.records[0];
    if (!record) throw new Error("synthetic record missing");
    for (const evidence of record.evidence)
      evidence.quote = evidence.quote.replaceAll("EUR", symbol);
    expect(
      validateExtraction(
        JSON.stringify(output),
        [{ id: "body", text: text.replaceAll("EUR", symbol) }],
        10000,
      ),
    ).toEqual({ status: "needs-review", reason: "evidence" });
  },
);
it("CURRENCY-02 a bare dollar symbol cannot ground USD", () => {
  const { output, text } = candidate("October 13, 2026");
  const record = output.records[0];
  if (!record) throw new Error("synthetic record missing");
  record.currency = "USD";
  for (const evidence of record.evidence)
    evidence.quote = evidence.quote.replaceAll("EUR", "$");
  expect(
    validateExtraction(
      JSON.stringify(output),
      [{ id: "body", text: text.replaceAll("EUR", "$") }],
      10000,
    ),
  ).toEqual({ status: "needs-review", reason: "evidence" });
});
it("CURRENCY-03 a dollar amount cannot borrow a euro currency label from another line", () => {
  const { output, text } = candidate("October 13, 2026");
  const record = output.records[0];
  if (!record) throw new Error("synthetic record missing");
  for (const evidence of record.evidence)
    evidence.quote =
      evidence.field === "currency"
        ? "€"
        : evidence.quote.replaceAll("EUR", "$");
  expect(
    validateExtraction(
      JSON.stringify(output),
      [{ id: "body", text: `Currency: €\n${text.replaceAll("EUR", "$")}` }],
      10000,
    ),
  ).toEqual({ status: "needs-review", reason: "money" });
});
