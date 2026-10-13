import { expect, it } from "vitest";
import receipts from "../../../test-design/fixtures/receipts.json";
import { validateExtraction } from "../src/ai/validation";

function candidate(reference: string, quote: string, line: string) {
  const fixture = receipts.fixtures[0];
  if (!fixture) throw new Error("MISSING_FIXTURE");
  const record = fixture.expectedExtraction.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  return {
    data: {
      ...fixture.expectedExtraction,
      records: [
        {
          ...record,
          paymentReference: reference,
          refundReference: null,
          evidence: [
            ...record.evidence,
            {
              field: "documentDate",
              inputPartId: "body-1",
              quote: "2026-10-01",
            },
            { field: "paymentReference", inputPartId: "body-1", quote },
          ],
        },
      ],
    },
    parts: fixture.inputParts.map((part) => ({
      ...part,
      text: `${part.text}\n${line}`,
    })),
  };
}

it("LEDGER-03 accepts an explicit source-grounded payment reference without retaining its quote", () => {
  const value = candidate(
    "PAY-001",
    "Payment reference: PAY-001",
    "Payment reference: PAY-001",
  );
  const result = validateExtraction(
    JSON.stringify(value.data),
    value.parts,
    10000,
  );
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error("EXPECTED_ACCEPTANCE");
  expect(result.records[0]?.paymentReference).toBe("PAY-001");
  expect(JSON.stringify(result)).not.toContain('"quote"');
});

it.each([
  ["PAY-001", "PAY-001", "Order reference: PAY-001"],
  ["PAY-001", "Payment reference: PAY-001", "Payment reference: PAY-001-extra"],
  ["PAY-001", "PAY-001", "Original payment reference: PAY-001; refund pending"],
])(
  "rejects a borrowed or clipped cash reference %s/%s",
  (reference, quote, line) => {
    const value = candidate(reference, quote, line);
    expect(
      validateExtraction(JSON.stringify(value.data), value.parts, 10000),
    ).toEqual({ status: "needs-review", reason: "evidence" });
  },
);

it.each(["invoiceNumber", "orderReference"] as const)(
  "requires an actual source identifier for strong purchase field %s",
  (field) => {
    const fixture = receipts.fixtures[0];
    if (!fixture) throw new Error("MISSING_FIXTURE");
    const record = fixture.expectedExtraction.records[0];
    if (!record) throw new Error("MISSING_RECORD");
    const data = {
      ...fixture.expectedExtraction,
      records: [
        {
          ...record,
          [field]: "12345",
          evidence: [
            ...record.evidence,
            {
              field: "documentDate",
              inputPartId: "body-1",
              quote: "2026-10-01",
            },
            { field, inputPartId: "body-1", quote: "12345" },
          ],
        },
      ],
    };
    const parts = fixture.inputParts.map((part) => ({
      ...part,
      text: `${part.text}\nSupport phone: 12345`,
    }));
    expect(validateExtraction(JSON.stringify(data), parts, 10000)).toEqual({
      status: "needs-review",
      reason: "evidence",
    });
    const label =
      field === "invoiceNumber" ? "Invoice number" : "Order reference";
    const control = fixture.inputParts.map((part) => ({
      ...part,
      text: `${part.text}\n${label}: 12345`,
    }));
    expect(
      validateExtraction(JSON.stringify(data), control, 10000).status,
    ).toBe("accepted");
  },
);
