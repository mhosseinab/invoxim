import type { Extraction } from "@invoxim/contracts";
import { expect, it } from "vitest";
import { createInferenceEngine } from "../src/ai/engine";
import type { AiUsage, ApprovedAiConfig } from "../src/ai/types";
import {
  validateExtraction,
  validatePersistableAiResult,
} from "../src/ai/validation";
import type { TenantContext } from "../src/tenant-context";

type RecordCandidate = Extraction["records"][number];
function candidate(total = "120.00"): RecordCandidate {
  return {
    merchant: "QA Store",
    documentDate: "2026-10-01",
    eventDate: "2026-10-01",
    currency: "EUR",
    total,
    tax: null,
    invoiceNumber: null,
    orderReference: null,
    category: "other",
    paymentEvidence: "explicitly-paid",
    refundEvidence: "none",
    paymentMethodHint: "card",
    recurringCadence: "unknown",
    paymentAmount: total,
    refundAmount: null,
    storeCreditAmount: null,
    evidence: [
      { field: "merchant", inputPartId: "receipt", quote: "QA Store" },
      { field: "documentDate", inputPartId: "receipt", quote: "2026-10-01" },
      { field: "eventDate", inputPartId: "receipt", quote: "2026-10-01" },
      { field: "currency", inputPartId: "receipt", quote: "EUR" },
      { field: "total", inputPartId: "receipt", quote: `Total EUR ${total}` },
      { field: "payment", inputPartId: "receipt", quote: `Paid EUR ${total}` },
      {
        field: "paymentAmount",
        inputPartId: "receipt",
        quote: `Paid EUR ${total}`,
      },
    ],
  };
}
function validate(
  record: RecordCandidate,
  text: string,
  documentType: Extraction["documentType"] = "receipt",
) {
  return validateExtraction(
    JSON.stringify({
      schemaVersion: 1,
      documentType,
      records: [record],
      warnings: [],
    }),
    [{ id: "receipt", text }],
    16384,
  );
}
it("AI-02 grounded complete receipt retains structured values and strips transient evidence quotes", () => {
  const result = validate(
    candidate(),
    "QA Store\n2026-10-01\nTotal EUR 120.00\nPaid EUR 120.00",
  );
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted")
    throw new Error("Required valid synthetic receipt rejected");
  expect(result.records[0]).toMatchObject({
    total: "120.00",
    paymentAmount: "120.00",
    currency: "EUR",
  });
  expect(JSON.stringify(result)).not.toContain('"quote"');
  expect(JSON.stringify(result)).not.toContain("Paid EUR 120.00");
});
it("AI-02 a naked subtotal quote cannot ground a gross total or cash payment", () => {
  const record = candidate("100.00");
  record.evidence = record.evidence.map((e) =>
    e.field === "total" || e.field === "paymentAmount"
      ? { ...e, quote: "100.00" }
      : e.field === "payment"
        ? { ...e, quote: "Paid EUR 120.00" }
        : e,
  );
  const result = validate(
    record,
    "QA Store\n2026-10-01\nSubtotal EUR 100.00\nTax EUR 20.00\nTotal EUR 120.00\nPaid EUR 120.00",
  );
  expect(result.status).toBe("needs-review");
});
it("AI-02 clipped paid evidence cannot remove source-line negation or turn unpaid into spending", () => {
  const record = candidate("100.00");
  record.evidence = record.evidence.map((e) =>
    e.field === "payment"
      ? { ...e, quote: "paid" }
      : e.field === "paymentAmount"
        ? { ...e, quote: "100.00" }
        : e,
  );
  expect(
    validate(record, "QA Store\n2026-10-01\nTotal EUR 100.00\nNot paid").status,
  ).toBe("needs-review");
});
it("AI-01 exact schema rejects self-reported confidence and model-selected destinations", () => {
  const raw = {
    schemaVersion: 1,
    documentType: "receipt",
    records: [candidate()],
    warnings: [],
    confidence: 1,
    destination: "https://invalid.example/steal",
  };
  expect(
    validateExtraction(
      JSON.stringify(raw),
      [
        {
          id: "receipt",
          text: "QA Store\n2026-10-01\nTotal EUR 120.00\nPaid EUR 120.00",
        },
      ],
      16384,
    ),
  ).toEqual({ status: "needs-review", reason: "schema" });
});

it("AI-02 mixed tender preserves gross100/card70/credit30 as separate grounded magnitudes", () => {
  const record = candidate("100.00");
  record.paymentAmount = "70.00";
  record.storeCreditAmount = "30.00";
  record.evidence = record.evidence.map((e) =>
    e.field === "payment" || e.field === "paymentAmount"
      ? { ...e, quote: "Paid by card EUR 70.00" }
      : e,
  );
  record.evidence.push({
    field: "storeCreditAmount",
    inputPartId: "receipt",
    quote: "Redeemed store credit EUR 30.00",
  });
  const result = validate(
    record,
    "QA Store\n2026-10-01\nTotal EUR 100.00\nPaid by card EUR 70.00\nRedeemed store credit EUR 30.00",
  );
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted")
    throw new Error("Grounded mixed-tender fixture rejected");
  expect(result.records[0]).toMatchObject({
    total: "100.00",
    paymentAmount: "70.00",
    storeCreditAmount: "30.00",
  });
});
it("AI-02 an explicit first installment50 is grounded without inventing store credit or paying gross100", () => {
  const record = candidate("100.00");
  record.paymentAmount = "50.00";
  record.evidence = record.evidence.map((e) =>
    e.field === "payment" || e.field === "paymentAmount"
      ? { ...e, quote: "First installment paid by card EUR 50.00" }
      : e,
  );
  const result = validate(
    record,
    "QA Store\n2026-10-01\nTotal EUR 100.00\nFirst installment paid by card EUR 50.00\nRemaining EUR 50.00 unpaid",
  );
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted")
    throw new Error("Grounded installment fixture rejected");
  expect(result.records[0]).toMatchObject({
    total: "100.00",
    paymentAmount: "50.00",
    storeCreditAmount: null,
  });
});
it("AI-02 clipped completed-refund quote cannot erase an explicit source no-refund statement", () => {
  const record = candidate("5.00");
  record.paymentEvidence = "unknown";
  record.paymentAmount = null;
  record.refundEvidence = "completed";
  record.refundAmount = "5.00";
  record.evidence = record.evidence.filter(
    (e) => e.field !== "payment" && e.field !== "paymentAmount",
  );
  record.evidence.push(
    { field: "refund", inputPartId: "receipt", quote: "refund completed" },
    { field: "refundAmount", inputPartId: "receipt", quote: "5.00" },
  );
  expect(
    validate(
      record,
      "QA Store\n2026-10-01\nTotal EUR 5.00\nNo refund completed. Approval is required.",
      "refund",
    ).status,
  ).toBe("needs-review");
});

it("AI-02 genuine gross-total100 evidence cannot ground cash100 when actual payment is50", () => {
  const record = candidate("100.00");
  record.evidence = record.evidence.map((e) =>
    e.field === "payment"
      ? { ...e, quote: "Paid EUR 50.00" }
      : e.field === "paymentAmount"
        ? { ...e, quote: "Total EUR 100.00" }
        : e,
  );
  expect(
    validate(record, "QA Store\n2026-10-01\nTotal EUR 100.00\nPaid EUR 50.00")
      .status,
  ).toBe("needs-review");
});
it("AI-02 tax5 is unrelated evidence for a completed refund whose actual amount is4", () => {
  const record = candidate("10.00");
  record.paymentEvidence = "unknown";
  record.paymentAmount = null;
  record.refundEvidence = "completed";
  record.refundAmount = "5.00";
  record.evidence = record.evidence.filter(
    (e) => e.field !== "payment" && e.field !== "paymentAmount",
  );
  record.evidence.push(
    {
      field: "refund",
      inputPartId: "receipt",
      quote: "Refund completed EUR 4.00",
    },
    { field: "refundAmount", inputPartId: "receipt", quote: "Tax EUR 5.00" },
  );
  expect(
    validate(
      record,
      "QA Store\n2026-10-01\nTotal EUR 10.00\nTax EUR 5.00\nRefund completed EUR 4.00",
      "refund",
    ).status,
  ).toBe("needs-review");
});
it("AI-02 explicit payment date cannot be replaced by a genuinely quoted earlier invoice date", () => {
  const record = candidate("100.00");
  expect(
    validate(
      record,
      "QA Store\nInvoice date 2026-10-01\nPayment date 2026-10-03\nTotal EUR 100.00\nPaid EUR 100.00",
    ).status,
  ).toBe("needs-review");
  record.eventDate = "2026-10-03";
  record.evidence = record.evidence.map((e) =>
    e.field === "eventDate" ? { ...e, quote: "2026-10-03" } : e,
  );
  expect(
    validate(
      record,
      "QA Store\nInvoice date 2026-10-01\nPayment date 2026-10-03\nTotal EUR 100.00\nPaid EUR 100.00",
    ).status,
  ).toBe("accepted");
});
it("AI-01 oversized structured cached records are rejected before traversing their contents", () => {
  const records = new Array(11);
  let traversed = false;
  Object.defineProperty(records, "0", {
    get() {
      traversed = true;
      throw new Error("Oversized synthetic records must not be traversed");
    },
  });
  expect(
    validatePersistableAiResult({
      status: "accepted",
      documentType: "receipt",
      records,
      warnings: [],
    }),
  ).toBeNull();
  expect(traversed).toBe(false);
});
it("AI-01 oversized provenance is rejected before traversing entries", () => {
  const provenance = new Array(21);
  let traversed = false;
  Object.defineProperty(provenance, "0", {
    get() {
      traversed = true;
      throw new Error("Oversized synthetic provenance must not be traversed");
    },
  });
  const { evidence, ...fields } = candidate();
  expect(evidence.length).toBeGreaterThan(0);
  expect(
    validatePersistableAiResult({
      status: "accepted",
      documentType: "receipt",
      records: [{ ...fields, provenance }],
      warnings: [],
    }),
  ).toBeNull();
  expect(traversed).toBe(false);
});
it("AI-02 tax5 cannot become cash5 merely because a receipt says Paid by card", () => {
  const record = candidate("100.00");
  record.paymentAmount = "5.00";
  record.evidence = record.evidence.map((e) =>
    e.field === "payment"
      ? { ...e, quote: "Paid by card." }
      : e.field === "paymentAmount"
        ? { ...e, quote: "Tax EUR 5.00" }
        : e,
  );
  expect(
    validate(
      record,
      "QA Store\n2026-10-01\nTotal EUR 100.00\nTax EUR 5.00\nPaid by card.",
    ).status,
  ).toBe("needs-review");
});
it("AI-02 tax currencyEUR cannot override actual gross and payment currencyUSD", () => {
  const record = candidate("100.00");
  record.evidence = record.evidence.map((e) =>
    e.field === "currency"
      ? { ...e, quote: "Tax EUR 5.00" }
      : e.field === "total"
        ? { ...e, quote: "Total USD 100.00" }
        : e.field === "payment" || e.field === "paymentAmount"
          ? { ...e, quote: "Paid USD 100.00" }
          : e,
  );
  expect(
    validate(
      record,
      "QA Store\n2026-10-01\nTotal USD 100.00\nTax EUR 5.00\nPaid USD 100.00",
    ).status,
  ).toBe("needs-review");
});
it.each([
  ["Never Paid by card.", "Paid by card."],
  ["No payment received.", "payment received."],
])(
  "AI-02 source %s cannot be clipped into completed cash evidence",
  (source, quote) => {
    const record = candidate("100.00");
    record.evidence = record.evidence.map((e) =>
      e.field === "payment"
        ? { ...e, quote }
        : e.field === "paymentAmount"
          ? { ...e, quote: "Total EUR 100.00" }
          : e,
    );
    expect(
      validate(record, `QA Store\n2026-10-01\nTotal EUR 100.00\n${source}`)
        .status,
    ).toBe("needs-review");
  },
);
it.each(["CAD", "SEK"])(
  "AI-02 unsupported source currency%s cannot be hidden by an unrelated EUR tax quote",
  (currency) => {
    const record = candidate("100.00");
    record.evidence = record.evidence.map((e) =>
      e.field === "currency"
        ? { ...e, quote: "Tax EUR 5.00" }
        : e.field === "total"
          ? { ...e, quote: `Total ${currency} 100.00` }
          : e.field === "payment" || e.field === "paymentAmount"
            ? { ...e, quote: `Paid ${currency} 100.00` }
            : e,
    );
    expect(
      validate(
        record,
        `QA Store\n2026-10-01\nTotal ${currency} 100.00\nTax EUR 5.00\nPaid ${currency} 100.00`,
      ).status,
    ).toBe("needs-review");
  },
);
it("AI-02 signed negative source amounts cannot become a positive cash payment", () => {
  const record = candidate("100.00");
  record.evidence = record.evidence.map((e) =>
    e.field === "total"
      ? { ...e, quote: "Total EUR -100.00" }
      : e.field === "payment" || e.field === "paymentAmount"
        ? { ...e, quote: "Paid EUR -100.00" }
        : e,
  );
  expect(
    validate(
      record,
      "QA Store\n2026-10-01\nTotal EUR -100.00\nPaid EUR -100.00",
    ).status,
  ).toBe("needs-review");
});
it.each([
  "EUR-100.00",
  "-EUR100.00",
  "-EUR 100.00",
  "(EUR100.00)",
  "(EUR 100.00)",
])(
  "AI-02 clipped amount cannot erase source sign or accounting wrapper %s",
  (amount) => {
    const record = candidate("100.00");
    record.evidence = record.evidence.map((e) =>
      e.field === "total" || e.field === "paymentAmount"
        ? { ...e, quote: "100.00" }
        : e.field === "payment"
          ? { ...e, quote: "Paid" }
          : e,
    );
    expect(
      validate(record, `QA Store\n2026-10-01\nTotal ${amount}\nPaid ${amount}`)
        .status,
    ).toBe("needs-review");
  },
);
it.each(["EUR100.00", "EUR 100.00"])(
  "AI-02 ordinary positive adjacency %s remains grounded",
  (amount) => {
    const record = candidate("100.00");
    record.evidence = record.evidence.map((e) =>
      e.field === "total"
        ? { ...e, quote: `Total ${amount}` }
        : e.field === "payment" || e.field === "paymentAmount"
          ? { ...e, quote: `Paid ${amount}` }
          : e,
    );
    expect(
      validate(record, `QA Store\n2026-10-01\nTotal ${amount}\nPaid ${amount}`)
        .status,
    ).toBe("accepted");
  },
);

it("AI-06 individually safe reported counters with unsafe aggregate retain exact usage and block acceptance", async () => {
  const usage: AiUsage = {
    input: Number.MAX_SAFE_INTEGER,
    output: 1,
    other: 0,
    source: "reported",
  };
  let captured: AiUsage | null = null;
  let completions = 0;
  const config: ApprovedAiConfig = {
    destinationId: "synthetic",
    modelId: "synthetic",
    mode: "hosted",
    settingsRevision: 1,
    consentId: "synthetic",
    fingerprint: "synthetic",
    promptVersion: "invoice-extraction-v1",
    schemaVersion: 1,
    maxInputBytes: 1000,
    maxOutputBytes: 1000,
    maxOutputTokens: 10,
    maxAttempts: 2,
    reservationUnits: 1000,
  };
  const engine = createInferenceEngine({
    extractor: {
      extract: async () => ({
        status: "ok",
        output: "{}",
        finish: "complete",
        usage,
      }),
    },
    store: {
      checkpoint: async () => ({ status: "ready" }),
      reserve: async () => "reserved",
      authorize: async () => true,
      settle: async (_attempt, settlement) => {
        captured = settlement.usage;
      },
      complete: async () => {
        completions++;
        return true;
      },
    },
  });
  expect(
    await engine.extract(
      { userId: "synthetic-user", authority: "job" } as TenantContext,
      {
        documentId: "synthetic-doc",
        contentHash: "a".repeat(64),
        extractionVersion: "v1",
      },
      [{ id: "body", text: "Synthetic" }],
      config,
    ),
  ).toEqual({ status: "needs-review", reason: "budget" });
  expect(captured).toEqual(usage);
  expect(completions).toBe(0);
});
