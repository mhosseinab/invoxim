import { describe, expect, it } from "vitest";
import receipts from "../../../test-design/fixtures/receipts.json";
import { validateExtraction } from "../src/ai/validation";

const fixture = receipts.fixtures[0];
if (!fixture) throw new Error("MISSING_FIXTURE");
describe("AI-01/02 deterministic evidence", () => {
  it("rejects a fabricated total despite matching evidence", () => {
    const data = structuredClone(fixture.expectedExtraction);
    const record = data.records[0];
    if (!record) throw new Error("MISSING_RECORD");
    record.total = "99.00";
    expect(
      validateExtraction(JSON.stringify(data), fixture.inputParts, 10000)
        .status,
    ).toBe("needs-review");
  });
  it("rejects fenced JSON", () =>
    expect(
      validateExtraction(
        `\`\`\`json\n${JSON.stringify(fixture.expectedExtraction)}\n\`\`\``,
        fixture.inputParts,
        10000,
      ),
    ).toEqual({ status: "needs-review", reason: "schema" }));
  it("strips evidence quotes after accepting grounded facts", () => {
    const data = structuredClone(fixture.expectedExtraction);
    const record = data.records[0];
    if (!record) throw new Error("MISSING_RECORD");
    record.evidence.push({
      field: "documentDate",
      inputPartId: "body-1",
      quote: "2026-10-01",
    });
    const result = validateExtraction(
      JSON.stringify(data),
      fixture.inputParts,
      10000,
    );
    expect(result.status).toBe("accepted");
    expect(JSON.stringify(result)).not.toContain('"quote"');
  });
});

it("AI-02 rejects subtotal digits relabeled as total with a naked quote", () => {
  const data = structuredClone(fixture.expectedExtraction);
  const record = data.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  record.evidence.push({
    field: "documentDate",
    inputPartId: "body-1",
    quote: "2026-10-01",
  });
  const parts = [
    {
      id: "body-1",
      text: "North Market\nReceipt 2026-10-01\nSubtotal EUR 24.90\nTotal EUR 29.90\nPaid by card.",
    },
  ];
  expect(validateExtraction(JSON.stringify(data), parts, 10000).status).toBe(
    "needs-review",
  );
});
it("AI-02 rejects gross total substituted for a mixed-tender cash event", () => {
  const data = structuredClone(fixture.expectedExtraction);
  const record = data.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  record.evidence.push({
    field: "documentDate",
    inputPartId: "body-1",
    quote: "2026-10-01",
  });
  const parts = [
    {
      id: "body-1",
      text: "North Market\nReceipt 2026-10-01\nTotal EUR 24.90\nPaid by card. Card payment EUR 14.90 plus store credit EUR 10.00",
    },
  ];
  expect(validateExtraction(JSON.stringify(data), parts, 10000).status).toBe(
    "needs-review",
  );
});

it("AI-02 rejects an ISO date clipped from a larger invalid token", () => {
  const data = structuredClone(fixture.expectedExtraction);
  const record = data.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  record.evidence.push({
    field: "documentDate",
    inputPartId: "body-1",
    quote: "2026-10-01",
  });
  const parts = [
    {
      id: "body-1",
      text: "North Market\nReceipt 12026-10-01\nEUR 24.90\nPaid by card.",
    },
  ];
  expect(validateExtraction(JSON.stringify(data), parts, 10000).status).toBe(
    "needs-review",
  );
});

it("AI-02 accepts explicit German dotted dates without binary money conversion", () => {
  const data = structuredClone(fixture.expectedExtraction);
  const record = data.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  for (const item of record.evidence) {
    if (item.field === "eventDate") item.quote = "01.10.2026";
  }
  record.evidence.push({
    field: "documentDate",
    inputPartId: "body-1",
    quote: "01.10.2026",
  });
  const parts = [
    {
      id: "body-1",
      text: "North Market\nReceipt 01.10.2026\nEUR 24.90\nPaid by card.",
    },
  ];
  expect(validateExtraction(JSON.stringify(data), parts, 10000).status).toBe(
    "accepted",
  );
});

it("AI-02 accepts a separately evidenced first installment without invented store credit", () => {
  const data = structuredClone(fixture.expectedExtraction);
  const record = data.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  record.total = "100.00";
  record.paymentAmount = "50.00";
  record.evidence = record.evidence.map((item) =>
    item.field === "total"
      ? { ...item, quote: "100.00" }
      : item.field === "paymentAmount"
        ? { ...item, quote: "50.00" }
        : item,
  );
  record.evidence.push({
    field: "documentDate",
    inputPartId: "body-1",
    quote: "2026-10-01",
  });
  expect(
    validateExtraction(
      JSON.stringify(data),
      [
        {
          id: "body-1",
          text: "North Market\nReceipt 2026-10-01\nTotal EUR 100.00\nFirst installment paid EUR 50.00\nPaid by card.",
        },
      ],
      10000,
    ).status,
  ).toBe("accepted");
});
it("AI-02 rejects clipped completed-refund quote in a negated source line", () => {
  const data = structuredClone(fixture.expectedExtraction);
  const record = data.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  record.refundEvidence = "completed";
  record.refundAmount = "5.00";
  record.evidence.push(
    { field: "documentDate", inputPartId: "body-1", quote: "2026-10-01" },
    { field: "refund", inputPartId: "body-1", quote: "refund completed" },
    { field: "refundAmount", inputPartId: "body-1", quote: "5.00" },
  );
  expect(
    validateExtraction(
      JSON.stringify(data),
      [
        {
          id: "body-1",
          text: "North Market\nReceipt 2026-10-01\nEUR 24.90\nPaid by card.\nNo refund completed. Approval is required. Requested amount EUR 5.00",
        },
      ],
      10000,
    ).status,
  ).toBe("needs-review");
});

it("AI-01 rejects oversized persistable arrays before reading record fields", async () => {
  const { validatePersistableAiResult } = await import("../src/ai/validation");
  const explosive = new Proxy(
    {},
    {
      get() {
        throw new Error("RECORD_TRAVERSED");
      },
    },
  );
  expect(() =>
    validatePersistableAiResult({
      status: "accepted",
      documentType: "receipt",
      records: Array.from({ length: 11 }, () => explosive),
      warnings: [],
    }),
  ).not.toThrow();
  expect(
    validatePersistableAiResult({
      status: "accepted",
      documentType: "receipt",
      records: Array.from({ length: 11 }, () => explosive),
      warnings: [],
    }),
  ).toBeNull();
});
it("AI-02 rejects gross100 when source explicitly documents only50paid", () => {
  const data = structuredClone(fixture.expectedExtraction);
  const record = data.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  record.total = "100.00";
  record.paymentAmount = "100.00";
  record.evidence = record.evidence.map((item) =>
    item.field === "total" || item.field === "paymentAmount"
      ? { ...item, quote: "100.00" }
      : item,
  );
  record.evidence.push({
    field: "documentDate",
    inputPartId: "body-1",
    quote: "2026-10-01",
  });
  expect(
    validateExtraction(
      JSON.stringify(data),
      [
        {
          id: "body-1",
          text: "North Market\nReceipt 2026-10-01\nTotal EUR 100.00\nPaid EUR 50.00\nPaid by card.",
        },
      ],
      10000,
    ).status,
  ).toBe("needs-review");
});
it("AI-02 rejects refundAmount digits borrowed from unrelated tax", () => {
  const data = structuredClone(fixture.expectedExtraction);
  const record = data.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  record.refundEvidence = "completed";
  record.refundAmount = "5.00";
  record.evidence.push(
    { field: "documentDate", inputPartId: "body-1", quote: "2026-10-01" },
    { field: "refund", inputPartId: "body-1", quote: "Refund completed" },
    { field: "refundAmount", inputPartId: "body-1", quote: "5.00" },
  );
  expect(
    validateExtraction(
      JSON.stringify(data),
      [
        {
          id: "body-1",
          text: "North Market\nReceipt 2026-10-01\nEUR 24.90\nPaid by card.\nTax EUR 5.00\nRefund completed",
        },
      ],
      10000,
    ).status,
  ).toBe("needs-review");
});

it("AI-02 rejects invoice date substituted for explicit later payment date", () => {
  const data = structuredClone(fixture.expectedExtraction);
  data.documentType = "invoice";
  const record = data.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  record.evidence.push({
    field: "documentDate",
    inputPartId: "body-1",
    quote: "2026-10-01",
  });
  const parts = [
    {
      id: "body-1",
      text: "North Market\nInvoice date 2026-10-01\nPayment date 2026-10-03\nEUR 24.90\nPaid by card.",
    },
  ];
  expect(validateExtraction(JSON.stringify(data), parts, 10000).status).toBe(
    "needs-review",
  );
  record.eventDate = "2026-10-03";
  for (const item of record.evidence) {
    if (item.field === "eventDate") item.quote = "2026-10-03";
  }
  expect(validateExtraction(JSON.stringify(data), parts, 10000).status).toBe(
    "accepted",
  );
});

it("AI-02 cannot borrow a tax amount as implicit full-total payment", () => {
  const data = structuredClone(fixture.expectedExtraction);
  const record = data.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  record.total = "100.00";
  record.paymentAmount = "5.00";
  record.evidence = record.evidence.map((item) =>
    item.field === "total"
      ? { ...item, quote: "100.00" }
      : item.field === "paymentAmount"
        ? { ...item, quote: "5.00" }
        : item,
  );
  record.evidence.push({
    field: "documentDate",
    inputPartId: "body-1",
    quote: "2026-10-01",
  });
  expect(
    validateExtraction(
      JSON.stringify(data),
      [
        {
          id: "body-1",
          text: "North Market\nReceipt 2026-10-01\nTotal EUR 100.00\nTax EUR 5.00\nPaid by card.",
        },
      ],
      10000,
    ).status,
  ).toBe("needs-review");
});
it("AI-02 binds each amount to its actual currency rather than unrelated tax currency", () => {
  const data = structuredClone(fixture.expectedExtraction);
  const record = data.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  record.total = "100.00";
  record.paymentAmount = "100.00";
  record.evidence = record.evidence.map((item) =>
    item.field === "total" || item.field === "paymentAmount"
      ? { ...item, quote: "100.00" }
      : item,
  );
  record.evidence.push({
    field: "documentDate",
    inputPartId: "body-1",
    quote: "2026-10-01",
  });
  expect(
    validateExtraction(
      JSON.stringify(data),
      [
        {
          id: "body-1",
          text: "North Market\nReceipt 2026-10-01\nTotal USD 100.00\nTax EUR 5.00\nPaid USD 100.00\nPaid by card.",
        },
      ],
      10000,
    ).status,
  ).toBe("needs-review");
});
for (const negation of [
  "Never Paid by card.",
  "No payment received.Though Paid by card.",
]) {
  it(`AI-02 rejects clipped payment evidence from ${negation}`, () => {
    const data = structuredClone(fixture.expectedExtraction);
    const record = data.records[0];
    if (!record) throw new Error("MISSING_RECORD");
    record.evidence.push({
      field: "documentDate",
      inputPartId: "body-1",
      quote: "2026-10-01",
    });
    if (negation.startsWith("No")) {
      record.evidence = record.evidence.map((item) =>
        item.field === "payment"
          ? { ...item, quote: "payment received" }
          : item,
      );
    }
    expect(
      validateExtraction(
        JSON.stringify(data),
        [
          {
            id: "body-1",
            text: `North Market\nReceipt 2026-10-01\nEUR 24.90\n${negation}`,
          },
        ],
        10000,
      ).status,
    ).toBe("needs-review");
  });
}
it("AI-02 preserves full-total receipts with one shared currency heading", () => {
  const data = structuredClone(fixture.expectedExtraction);
  const record = data.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  record.evidence.push({
    field: "documentDate",
    inputPartId: "body-1",
    quote: "2026-10-01",
  });
  expect(
    validateExtraction(
      JSON.stringify(data),
      [
        {
          id: "body-1",
          text: "North Market\nReceipt 2026-10-01\nCurrency EUR\nTotal 24.90\nPaid by card.",
        },
      ],
      10000,
    ).status,
  ).toBe("accepted");
});

for (const unsupportedCurrency of ["CAD", "SEK"]) {
  it(`AI-02 cannot reinterpret explicit unsupported ${unsupportedCurrency} as unrelated EUR`, () => {
    const data = structuredClone(fixture.expectedExtraction);
    const record = data.records[0];
    if (!record) throw new Error("MISSING_RECORD");
    record.total = "100.00";
    record.paymentAmount = "100.00";
    record.evidence = record.evidence.map((item) =>
      item.field === "total" || item.field === "paymentAmount"
        ? { ...item, quote: "100.00" }
        : item,
    );
    record.evidence.push({
      field: "documentDate",
      inputPartId: "body-1",
      quote: "2026-10-01",
    });
    expect(
      validateExtraction(
        JSON.stringify(data),
        [
          {
            id: "body-1",
            text: `North Market\nReceipt 2026-10-01\nTotal ${unsupportedCurrency} 100.00\nTax EUR 5.00\nPaid ${unsupportedCurrency} 100.00\nPaid by card.`,
          },
        ],
        10000,
      ).status,
    ).toBe("needs-review");
  });
}
for (const signed of ["-100.00", "+100.00", "−100.00", "(100.00)"]) {
  it(`AI-02 does not strip unsupported signed monetary form ${signed}`, () => {
    const data = structuredClone(fixture.expectedExtraction);
    const record = data.records[0];
    if (!record) throw new Error("MISSING_RECORD");
    record.total = "100.00";
    record.paymentAmount = "100.00";
    record.evidence = record.evidence.map((item) =>
      item.field === "total" || item.field === "paymentAmount"
        ? { ...item, quote: "100.00" }
        : item,
    );
    record.evidence.push({
      field: "documentDate",
      inputPartId: "body-1",
      quote: "2026-10-01",
    });
    expect(
      validateExtraction(
        JSON.stringify(data),
        [
          {
            id: "body-1",
            text: `North Market\nReceipt 2026-10-01\nTotal EUR ${signed}\nPaid EUR ${signed}\nPaid by card.`,
          },
        ],
        10000,
      ).status,
    ).toBe("needs-review");
  });
}

for (const signed of [
  "EUR-100.00",
  "-EUR 100.00",
  "(EUR 100.00)",
  "+EUR100.00",
  "EUR+100.00",
  "(100.00EUR)",
  "EUR100.00-",
]) {
  it(`AI-02 rejects currency-bound signed token ${signed}`, () => {
    const data = structuredClone(fixture.expectedExtraction);
    const record = data.records[0];
    if (!record) throw new Error("MISSING_RECORD");
    record.total = "100.00";
    record.paymentAmount = "100.00";
    record.evidence = record.evidence.map((item) =>
      item.field === "total" || item.field === "paymentAmount"
        ? { ...item, quote: "100.00" }
        : item,
    );
    record.evidence.push({
      field: "documentDate",
      inputPartId: "body-1",
      quote: "2026-10-01",
    });
    expect(
      validateExtraction(
        JSON.stringify(data),
        [
          {
            id: "body-1",
            text: `North Market\nReceipt 2026-10-01\nTotal ${signed}\nPaid ${signed}\nPaid by card.`,
          },
        ],
        10000,
      ).status,
    ).toBe("needs-review");
  });
}
it("AI-02 retains ordinary unsigned currency-adjacent money", () => {
  const data = structuredClone(fixture.expectedExtraction);
  const record = data.records[0];
  if (!record) throw new Error("MISSING_RECORD");
  record.total = "100.00";
  record.paymentAmount = "100.00";
  record.evidence = record.evidence.map((item) =>
    item.field === "total" || item.field === "paymentAmount"
      ? { ...item, quote: "100.00" }
      : item,
  );
  record.evidence.push({
    field: "documentDate",
    inputPartId: "body-1",
    quote: "2026-10-01",
  });
  expect(
    validateExtraction(
      JSON.stringify(data),
      [
        {
          id: "body-1",
          text: "North Market\nReceipt 2026-10-01\nCurrency EUR\nTotal EUR100.00\nPaid EUR100.00\nPaid by card.",
        },
      ],
      10000,
    ).status,
  ).toBe("accepted");
});
