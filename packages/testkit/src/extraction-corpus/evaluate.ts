import { validateExtraction } from "../../../core/src/ai/validation";
import { createDocumentTextExtractor } from "../../../core/src/documents/extractor";
import type { MimePart } from "../../../core/src/documents/types";
import { planLedgerIngestion } from "../../../core/src/ledger/plan";
import type {
  LedgerPlan,
  LedgerSnapshot,
} from "../../../core/src/ledger/types";
import type { TenantContext } from "../../../core/src/tenant-context";
import type { CorpusCase, OfflineOutcome } from "./types";

const tenant = {
  userId: "offline-synthetic",
  authority: "job",
} as TenantContext;
const empty = (): LedgerSnapshot => ({
  observations: [],
  purchases: [],
  events: [],
  decisions: [],
});
function add(snapshot: LedgerSnapshot, plan: LedgerPlan): LedgerSnapshot {
  return {
    observations: [...snapshot.observations, ...plan.observations],
    purchases: [...snapshot.purchases, ...plan.purchases],
    events: [...snapshot.events, ...plan.events],
    decisions: snapshot.decisions,
  };
}
export async function evaluateOfflineCase(
  input: CorpusCase,
): Promise<OfflineOutcome> {
  const base: OfflineOutcome = {
    parser: "unsupported",
    validation: "not-run",
    events: [],
    replayEvents: 0,
    providerRequests: 0,
    costMinor: 0,
  };
  const bytes =
    input.representation === "png" ||
    input.representation === "jpeg" ||
    input.representation === "pdf" ||
    input.representation === "invalid-utf8"
      ? Uint8Array.from(atob(input.source), (value) => value.charCodeAt(0))
      : new TextEncoder().encode(input.source);
  const body: MimePart = {
    partId: "body",
    mimeType:
      input.representation === "html"
        ? "text/html"
        : input.representation === "png"
          ? "image/png"
          : input.representation === "jpeg"
            ? "image/jpeg"
            : input.representation === "pdf"
              ? "application/pdf"
              : "text/plain",
    bytes,
  };
  const root: MimePart =
    input.representation === "mime"
      ? {
          partId: "root",
          mimeType: "multipart/alternative",
          children: [
            body,
            {
              partId: "logo",
              mimeType: "image/png",
              disposition: "inline",
              bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
            },
          ],
        }
      : body;
  const parsed = await createDocumentTextExtractor({}).extract(
    { connectionId: "synthetic-mailbox", providerMessageId: input.id, root },
    { tenant },
  );
  base.parser = parsed.status;
  if (parsed.status !== "ready") return base;
  if (input.response !== "complete") {
    base.validation = "needs-review";
    return base;
  }
  const parts = parsed.documents.flatMap((document) =>
    document.status === "ready"
      ? document.textParts.map((page) => ({
          id: document.identity.partId,
          text: page.text,
        }))
      : [],
  );
  const result = validateExtraction(input.preset, parts, 65536);
  base.validation = result.status;
  let snapshot = empty();
  if (input.seedPayment) {
    const seedText =
      "Corpus Shop\n2026-10-01\nTotal EUR 100.00\nPaid EUR 100.00\nOrder ORDER-1";
    const seedRecord = {
      merchant: "Corpus Shop",
      documentDate: "2026-10-01",
      eventDate: "2026-10-01",
      currency: "EUR",
      total: "100.00",
      tax: null,
      invoiceNumber: null,
      orderReference: "ORDER-1",
      category: "other",
      paymentEvidence: "explicitly-paid",
      refundEvidence: "none",
      paymentMethodHint: "card",
      recurringCadence: "unknown",
      paymentAmount: "100.00",
      refundAmount: null,
      storeCreditAmount: null,
      evidence: [
        { field: "merchant", quote: "Corpus Shop" },
        { field: "documentDate", quote: "2026-10-01" },
        { field: "eventDate", quote: "2026-10-01" },
        { field: "currency", quote: "EUR" },
        { field: "total", quote: "Total EUR 100.00" },
        { field: "payment", quote: "Paid EUR 100.00" },
        { field: "paymentAmount", quote: "Paid EUR 100.00" },
        { field: "orderReference", quote: "ORDER-1" },
      ].map((item) => ({ ...item, inputPartId: "seed" })),
    };
    const seed = validateExtraction(
      JSON.stringify({
        schemaVersion: 1,
        documentType: "receipt",
        records: [seedRecord],
        warnings: [],
      }),
      [{ id: "seed", text: seedText }],
      65536,
    );
    const plan = planLedgerIngestion(
      {
        identity: {
          documentId: "seed",
          contentHash: "seed-content",
          extractionFingerprint: "offline-v1",
        },
        result: seed,
      },
      snapshot,
    );
    snapshot = add(snapshot, plan);
  }
  const first = parsed.documents[0];
  if (!first) throw new Error("MISSING_PARSED_DOCUMENT");
  const identity = {
    documentId: input.id,
    contentHash: first.contentHash,
    extractionFingerprint: "offline-v1",
  };
  const plan = planLedgerIngestion({ identity, result }, snapshot);
  base.events = plan.events.map((event) => ({
    kind: event.kind,
    amountMinor: event.amountMinor,
    currency: event.currency,
  }));
  const replay = planLedgerIngestion(
    {
      identity: input.duplicateSource
        ? { ...identity, documentId: `${input.id}-duplicate` }
        : identity,
      result,
    },
    add(snapshot, plan),
  );
  base.replayEvents = replay.events.length;
  return base;
}
