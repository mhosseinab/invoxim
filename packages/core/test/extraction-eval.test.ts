import { expect, it } from "vitest";
import { evaluateOfflineCase } from "../../testkit/src/extraction-corpus/evaluate";
import type { CorpusCase } from "../../testkit/src/extraction-corpus/types";

const source = "Corpus Shop\n2026-10-01\nTotal EUR 100.00\nPaid EUR 100.00";
const evidence = [
  { field: "merchant", quote: "Corpus Shop" },
  { field: "documentDate", quote: "2026-10-01" },
  { field: "eventDate", quote: "2026-10-01" },
  { field: "currency", quote: "EUR" },
  { field: "total", quote: "Total EUR 100.00" },
  { field: "payment", quote: "Paid EUR 100.00" },
  { field: "paymentAmount", quote: "Paid EUR 100.00" },
].map((item) => ({ ...item, inputPartId: "body" }));
const clean: CorpusCase = {
  id: "CATALOG-RED",
  partition: "development",
  family: "full-paid",
  language: "en",
  clean: true,
  representation: "plain",
  source,
  response: "complete",
  preset: JSON.stringify({
    schemaVersion: 1,
    documentType: "receipt",
    records: [
      {
        merchant: "Corpus Shop",
        documentDate: "2026-10-01",
        eventDate: "2026-10-01",
        currency: "EUR",
        total: "100.00",
        tax: null,
        invoiceNumber: null,
        orderReference: null,
        category: "other",
        paymentEvidence: "explicitly-paid",
        refundEvidence: "none",
        paymentMethodHint: "card",
        recurringCadence: "unknown",
        paymentAmount: "100.00",
        refundAmount: null,
        storeCreditAmount: null,
        evidence,
      },
    ],
    warnings: [],
  }),
  expected: {
    parser: "ready",
    validation: "accepted",
    events: [{ kind: "payment", amountMinor: 10000, currency: "EUR" }],
    replayEvents: 0,
  },
};
it("T22 offline harness uses actual parser, validator and replay-idempotent ledger with independent literal10000 oracle", async () => {
  const result = await evaluateOfflineCase(clean);
  expect(result.parser).toBe("ready");
  expect(result.validation).toBe("accepted");
  expect(result.events).toEqual(clean.expected.events);
  expect(result.replayEvents).toBe(0);
  expect(result.providerRequests).toBe(0);
  expect(result.costMinor).toBe(0);
});

import development from "../../testkit/src/extraction-corpus/development.json";
import holdout from "../../testkit/src/extraction-corpus/holdout.json";

const developmentCases = development.cases as CorpusCase[];
const holdoutCases = holdout.cases as CorpusCase[];

import { summarizeOffline } from "../../testkit/src/extraction-corpus/metrics";

it("T22 report distinguishes fabricated cash from missing expected cash", () => {
  const missing = {
    parser: "ready",
    validation: "accepted",
    events: [],
    replayEvents: 0,
    providerRequests: 0,
    costMinor: 0,
  } as const;
  expect(
    summarizeOffline(
      [clean],
      new Map([[clean.id, { ...missing, events: [] }]]),
    ),
  ).toMatchObject({
    falseCashCases: 0,
    missingCashCases: 1,
    incorrectFinancialCases: 1,
  });
});

import manifest from "../../testkit/src/extraction-corpus/manifest.json";
import type { OfflineOutcome } from "../../testkit/src/extraction-corpus/types";

const allCases = [...developmentCases, ...holdoutCases];
const outcomes = new Map<string, OfflineOutcome>();
async function digest(value: unknown): Promise<string> {
  const data = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(data), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
it("T22 immutable120 catalog has disjoint80/40 partitions and verifies frozen case/partition hashes", async () => {
  expect(developmentCases).toHaveLength(80);
  expect(holdoutCases).toHaveLength(40);
  expect(new Set(allCases.map((input) => input.id)).size).toBe(120);
  expect(new Set(allCases.map((input) => input.family)).size).toBe(40);
  expect(await digest(development)).toBe(
    manifest.partitions.development.sha256,
  );
  expect(await digest(holdout)).toBe(manifest.partitions.holdout.sha256);
  for (const input of allCases)
    expect(await digest(input)).toBe(
      manifest.caseHashes[input.id as keyof typeof manifest.caseHashes],
    );
});
it.each(allCases)(
  "T22 frozen application conformance $id $partition $family $representation",
  async (input) => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      throw new Error("OFFLINE_CORPUS_NETWORK_FORBIDDEN");
    };
    try {
      const result = await evaluateOfflineCase(input);
      outcomes.set(input.id, result);
      expect({
        parser: result.parser,
        validation: result.validation,
        events: result.events,
        replayEvents: result.replayEvents,
      }).toEqual(input.expected);
      expect(requests).toBe(0);
      expect(result.providerRequests).toBe(0);
      expect(result.costMinor).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
it("T22 aggregate results retain split denominators and make no model quality claim", () => {
  const report = {
    development: summarizeOffline(developmentCases, outcomes),
    holdout: summarizeOffline(holdoutCases, outcomes),
  };
  expect(report.development.clean).toEqual({ accepted: 44, denominator: 44 });
  expect(report.holdout.clean).toEqual({ accepted: 22, denominator: 22 });
  expect(report.development.falseCashCases).toBe(0);
  expect(report.holdout.falseCashCases).toBe(0);
  expect(report.development.incorrectFinancialCases).toBe(0);
  expect(report.holdout.incorrectFinancialCases).toBe(0);
  console.info("T22_OFFLINE_CONFORMANCE", JSON.stringify(report));
});

import { createDocumentTextExtractor } from "../src/documents/extractor";
import type { TenantContext } from "../src/tenant-context";

it("T22 malformed MIME duplicate identities expose no partial receipt evidence", async () => {
  const tenant = { userId: "synthetic", authority: "job" } as TenantContext;
  const result = await createDocumentTextExtractor({}).extract(
    {
      connectionId: "mail",
      providerMessageId: "duplicate-parts",
      root: {
        partId: "root",
        mimeType: "multipart/mixed",
        children: [
          {
            partId: "same",
            mimeType: "text/plain",
            bytes: new TextEncoder().encode(source),
          },
          {
            partId: "same",
            mimeType: "text/html",
            bytes: new TextEncoder().encode(`<p>${source}</p>`),
          },
        ],
      },
    },
    { tenant },
  );
  expect(result.status).toBe("unreadable");
  expect(result.code).toBe("invalid_mime");
  expect(result.documents).toEqual([]);
});
it("T22 text-bound truncation cannot expose first-page partial numeric evidence", async () => {
  const tenant = { userId: "synthetic", authority: "job" } as TenantContext;
  const result = await createDocumentTextExtractor({
    limits: { textCharacters: 20 },
  }).extract(
    {
      connectionId: "mail",
      providerMessageId: "truncated",
      root: {
        partId: "body",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode(source),
      },
    },
    { tenant },
  );
  expect(result.status).toBe("incomplete");
  expect(result.code).toBe("text_limit");
  expect(result.documents).toEqual([]);
});

it("T22 duplicate cash surplus is reported as false cash even when every event has a matching value", () => {
  const event = {
    kind: "payment",
    amountMinor: 10000,
    currency: "EUR",
  } as const;
  const result: OfflineOutcome = {
    parser: "ready",
    validation: "accepted",
    events: [event, event],
    replayEvents: 0,
    providerRequests: 0,
    costMinor: 0,
  };
  expect(
    summarizeOffline([clean], new Map([[clean.id, result]])),
  ).toMatchObject({
    falseCashCases: 1,
    missingCashCases: 0,
    incorrectFinancialCases: 1,
  });
});
it("T22 duplicate cash deficit is reported as missing cash even when a matching value exists", () => {
  const event = {
    kind: "payment",
    amountMinor: 10000,
    currency: "EUR",
  } as const;
  const expected = {
    ...clean,
    expected: { ...clean.expected, events: [event, event] },
  };
  const result: OfflineOutcome = {
    parser: "ready",
    validation: "accepted",
    events: [event],
    replayEvents: 0,
    providerRequests: 0,
    costMinor: 0,
  };
  expect(
    summarizeOffline([expected], new Map([[clean.id, result]])),
  ).toMatchObject({
    falseCashCases: 0,
    missingCashCases: 1,
    incorrectFinancialCases: 1,
  });
});
it("T22 surplus/deficit counts preserve order-independent event quantities while exact projection remains order-sensitive", () => {
  const payment = {
    kind: "payment",
    amountMinor: 10000,
    currency: "EUR",
  } as const;
  const refund = { kind: "refund", amountMinor: 500, currency: "EUR" } as const;
  const expected = {
    ...clean,
    expected: { ...clean.expected, events: [payment, refund] },
  };
  const result: OfflineOutcome = {
    parser: "ready",
    validation: "accepted",
    events: [refund, payment],
    replayEvents: 0,
    providerRequests: 0,
    costMinor: 0,
  };
  expect(
    summarizeOffline([expected], new Map([[clean.id, result]])),
  ).toMatchObject({
    falseCashCases: 0,
    missingCashCases: 0,
    incorrectFinancialCases: 1,
  });
});
