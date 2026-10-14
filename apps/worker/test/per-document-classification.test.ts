import { env } from "cloudflare:workers";
import { EXTRACTION_PROMPT_VERSION } from "@invoxim/contracts";
import {
  type AiTextPart,
  type ApprovedAiConfig,
  createDocumentTextExtractor,
  type DocumentInput,
  type JobLease,
  type TenantContext,
} from "@invoxim/core";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import initial from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import type { AiPriceSnapshot } from "../../../packages/adapters/src/ai/budget";
import { createReceiptClassifierFactory } from "../../../packages/adapters/src/ai/classifier-factory";
import type { ReceiptClassificationConfiguration } from "../../../packages/adapters/src/ai/clef";
import { computeAiFingerprint } from "../../../packages/adapters/src/ai/configuration";
import {
  createLocalPdfTextExtractor,
  LOCAL_PDF_PARSER_VERSION,
} from "../../../packages/adapters/src/documents/pdf";
import type { ContentLoadInput } from "../../../packages/adapters/src/pipeline/gmail-content";
import { createPipelineRepository } from "../../../packages/adapters/src/pipeline/repository";
import { createPipelineService } from "../../../packages/adapters/src/pipeline/service";
import { createInvocationDatabase } from "../src/invocation-database";
import { generateCompressedTextPdf } from "./fixtures/synthetic-pdf";

const db = env.DB;
const policy = {
  dailyDocuments: 50,
  monthlyDocuments: 500,
  dailyUnits: 1000000,
  monthlyUnits: 10000000,
  globalDailyUsdMicros: "1000000",
  globalMonthlyUsdMicros: "10000000",
};
const classification: ReceiptClassificationConfiguration = {
  enabled: true,
  model: "@cf/cloudflare/clef",
  version: "clef-v1",
  maxInputBytes: 24000,
  timeoutMs: 1000,
  negativeThreshold: 0.1,
  categoryThreshold: 0.5,
  pricing: {
    version: "clef-tariff-v1",
    approved: true,
    currency: "USD",
    source: "https://developers.cloudflare.com/workers-ai/models/clef/",
    checkedAt: "2026-10-13T00:00:00Z",
    inputUsdMicrosPerMillion: "240000",
    outputUsdMicrosPerMillion: "0",
    otherUsdMicrosPerMillion: "0",
  },
};
const tenant = {
  userId: "per-document-owner",
  authority: "job",
} as TenantContext;
const documents = createDocumentTextExtractor({
  pdf: {
    async extract(bytes) {
      return {
        status: "ready",
        pages: [new TextDecoder().decode(bytes).slice(5)],
        parserVersion: "synthetic-pdf-v2",
      };
    },
  },
});
const html =
  '<html lang="de"><body><h1>Caf&eacute; <strong>&Eacute;toile</strong></h1><table><tr><td>Gesamtbetrag</td><td><strong>19&#44;99&nbsp;&euro;</strong></td></tr><tr><td>Datum</td><td>14&nbsp;Oktober&nbsp;2026</td></tr><tr><td>Zahlung</td><td>erhalten</td></tr></table></body></html>';
const input: DocumentInput = {
  connectionId: "c",
  providerMessageId: "m",
  root: {
    partId: "",
    mimeType: "multipart/alternative",
    children: [
      {
        partId: "plain",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode(
          "Synthetic plain receipt alternative; details are in the rich body.",
        ),
      },
      {
        partId: "html",
        mimeType: "text/html",
        bytes: new TextEncoder().encode(html),
      },
    ],
  },
};
let config: ApprovedAiConfig;
let price: AiPriceSnapshot;
let lease: JobLease;
beforeAll(async () => {
  for (const sql of initial.split(";").filter((sql) => sql.trim()))
    await db.prepare(sql).run();
});
beforeEach(async () => {
  await db.prepare('DELETE FROM "user" WHERE id=?').bind(tenant.userId).run();
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Synthetic','direct@example.invalid',1,0,0)",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state,credential_ciphertext,credential_key_version,credential_version) VALUES('c',?,'mailbox','gmail','subject','direct@example.invalid','active','synthetic',1,1)",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO ai_settings(user_id,mode,provider_id,model_id,config_version,revision,consent_version) VALUES(?,'hosted','abacus','financial','v1',1,1)",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized,accepted_configuration_digest) VALUES('consent',?,'c',1,'abacus','local',1,?,1,?)",
    )
    .bind(tenant.userId, now, "f".repeat(64))
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('s',?,'c','m',?,1)",
    )
    .bind(tenant.userId, now)
    .run();
  lease = {
    context: tenant,
    jobId: "job",
    connectionId: "c",
    consentId: "consent",
    generation: 1,
    syncStateId: null,
    type: "source-extract",
    leaseId: "lease",
    fence: 1,
    expiresAt: now + 300000,
    attempt: 1,
  };
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,lease_id,lease_expires_at,fence) VALUES('job',?,'c','consent',1,'source-extract','clef-fixture','leased',?,'lease',?,1)",
    )
    .bind(tenant.userId, now, lease.expiresAt)
    .run();
  await db
    .prepare(
      "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id,pipeline_stage) VALUES(?,'job','s','parse')",
    )
    .bind(tenant.userId)
    .run();
  const fingerprint = await computeAiFingerprint({
    mode: "hosted",
    configurationDigest: "a".repeat(64),
    settingsRevision: 1,
    generation: 1,
    credentialVersion: 0,
    policyVersion: 1,
    consentId: "consent",
  });
  config = {
    destinationId: "abacus",
    modelId: "financial",
    mode: "hosted",
    settingsRevision: 1,
    consentId: "consent",
    fingerprint,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    schemaVersion: 1,
    maxInputBytes: 24000,
    maxOutputBytes: 4096,
    maxOutputTokens: 100,
    maxAttempts: 1,
    reservationUnits: 1000,
  };
  price = {
    ...classification.pricing,
    destinationId: "abacus",
    modelId: "financial",
    configVersion: "v1",
    policyVersion: 1,
    configurationDigest: "a".repeat(64),
    acceptedConfigurationDigest: "f".repeat(64),
  };
});

function flow(
  contentInput: DocumentInput = input,
  documentExtractor = documents,
) {
  const classify = vi.fn(
    async (_model: string, request: { state: { text: string }[] }) => {
      const text = request.state.map((part) => part.text).join("\n");
      const category =
        text.match(/RECEIPT-(software|transport)/)?.[1] ?? "uncategorized";
      return {
        model: "clef",
        answers: {
          documentType: {
            type: "choice",
            choice: text.includes("RECEIPT-") ? "invoice" : "delivery",
            probabilities: {
              [text.includes("RECEIPT-") ? "invoice" : "delivery"]: 1,
            },
            confidence: 1,
          },
          receipt: {
            type: "noul",
            noul: text.includes("RECEIPT-") ? 0.99 : 0.01,
          },
          category: {
            type: "choice",
            choice: category,
            probabilities: { [category]: 1 },
            confidence: 1,
          },
        },
        usage: { input_tokens: 50, output_tokens: 0 },
      };
    },
  );
  const extract = vi.fn(async (parts: readonly AiTextPart[]) => {
    expect(parts.length).toBeGreaterThan(0);
    return {
      status: "ok" as const,
      output: JSON.stringify(receipt(parts)),
      finish: "complete" as const,
      usage: { input: 50, output: 80, other: 0, source: "reported" as const },
    };
  });
  const load = vi.fn(async (request: ContentLoadInput) => {
    expect(request.providerMessageId).toBe("m");
    return { status: "ready" as const, input: contentInput };
  });
  const counts: number[] = [];
  const states: string[] = [];
  async function stage(current: JobLease) {
    const meter = createInvocationDatabase(db, 40);
    const pipeline = createPipelineService(meter.db, {
      repository: createPipelineRepository(meter.db, {
        processingDigest: async () => "f".repeat(64),
      }),
      documents: documentExtractor,
      directModelInputs: true,
      content: {
        open: async () => ({ load }),
      },
      inference: {
        open: async () => ({
          config,
          extractor: { extract },
          pricing: new Map([[config.fingerprint, price]]),
        }),
      },
      classification: createReceiptClassifierFactory(meter.db, classification, {
        binding: { run: classify },
      }),
      budget: policy,
      remainingStatements: () => meter.remainingStatements(),
    });
    const result = await pipeline.run(current, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    });
    states.push(
      (await db
        .prepare(
          "SELECT processing_status FROM source_messages WHERE user_id=?",
        )
        .bind(tenant.userId)
        .first<string>("processing_status")) ?? "missing",
    );
    counts.push(meter.executedStatements());
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
    expect(result).toEqual({ kind: "completed" });
  }
  async function drain(afterParse?: () => Promise<void>) {
    await stage(lease);
    await afterParse?.();
    for (let remaining = 8; remaining > 0; remaining--) {
      const id = await db
        .prepare(
          "SELECT id FROM jobs WHERE user_id=? AND status='ready' ORDER BY id LIMIT 1",
        )
        .bind(tenant.userId)
        .first<string>("id");
      if (!id) return;
      const leaseId = `lease-${id}`;
      await db
        .prepare(
          "UPDATE jobs SET status='leased',lease_id=?,lease_expires_at=?,fence=1 WHERE user_id=? AND id=? AND status='ready'",
        )
        .bind(leaseId, lease.expiresAt, tenant.userId, id)
        .run();
      await stage({ ...lease, jobId: id, leaseId });
    }
    throw new Error("Synthetic pipeline did not finish within bounded stages");
  }
  return { drain, stage, classify, extract, load, counts, states };
}

function receipt(parts: readonly AiTextPart[]) {
  const category =
    parts
      .map((part) => part.text)
      .join("\n")
      .match(/RECEIPT-(software|transport)/)?.[1] ?? "software";
  return {
    schemaVersion: 1,
    documentType: "receipt",
    warnings: [],
    records: [
      {
        merchant: `Synthetic ${category}`,
        documentDate: "2026-10-14",
        eventDate: "2026-10-14",
        currency: "EUR",
        total: "10.00",
        tax: null,
        invoiceNumber: null,
        orderReference: null,
        category: "other",
        paymentEvidence: "explicitly-paid",
        refundEvidence: "none",
        paymentMethodHint: "card",
        recurringCadence: "unknown",
        paymentAmount: "10.00",
        refundAmount: null,
        storeCreditAmount: null,
        evidence: [
          "merchant",
          "documentDate",
          "currency",
          "total",
          "payment",
          "eventDate",
          "paymentAmount",
        ].map((field) => ({
          field,
          inputPartId: "part-0",
          quote: "Synthetic receipt 2026-10-14 EUR 10.00 paid",
        })),
      },
    ],
  };
}
function mixed(body: string, pdf: string, opaque = false): DocumentInput {
  return {
    connectionId: "c",
    providerMessageId: "m",
    root: {
      partId: "mixed",
      mimeType: "multipart/mixed",
      children: [
        {
          partId: "body",
          mimeType: "text/plain",
          bytes: new TextEncoder().encode(body),
        },
        {
          partId: "attachment",
          mimeType: opaque ? "image/png" : "application/pdf",
          filename: opaque ? "unknown.png" : "synthetic.pdf",
          disposition: "attachment",
          bytes: new TextEncoder().encode(`%PDF-${pdf}`),
        },
      ],
    },
  };
}
it.each([
  [
    "shipping body and invoice PDF",
    "Shipping: your order is on the way",
    "RECEIPT-software Synthetic invoice EUR 10.00",
  ],
  [
    "invoice body and shipping PDF",
    "RECEIPT-transport Synthetic receipt EUR 10.00",
    "Shipping: your order is on the way",
  ],
])(
  "DOC-CLASSIFICATION-01 %s keeps the negative sibling out of financial extraction",
  async (_name, body, pdf) => {
    const current = flow(mixed(body, pdf));
    await current.drain();
    expect(current.classify).toHaveBeenCalledTimes(2);
    expect(current.extract).toHaveBeenCalledOnce();
    expect(
      current.extract.mock.calls[0]?.[0].map((part) => part.text).join(" "),
    ).toContain("RECEIPT-");
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM purchases WHERE user_id=?")
        .bind(tenant.userId)
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM review_items WHERE user_id=?")
        .bind(tenant.userId)
        .first("n"),
    ).toBe(0);
    expect(current.states.slice(0, -1)).not.toContain("processed");
    expect(current.states.at(-1)).toBe("processed");
  },
);
it("DOC-CLASSIFICATION-02 two receipts get independent classification and categories", async () => {
  const current = flow(
    mixed(
      "RECEIPT-software Synthetic invoice EUR 10.00",
      "RECEIPT-transport Synthetic receipt EUR 10.00",
    ),
  );
  await current.drain();
  expect(current.classify).toHaveBeenCalledTimes(2);
  expect(current.extract).toHaveBeenCalledTimes(2);
  expect(
    (
      await db
        .prepare(
          "SELECT merchant_raw,category FROM purchases WHERE user_id=? ORDER BY category",
        )
        .bind(tenant.userId)
        .all()
    ).results,
  ).toEqual([
    { merchant_raw: "Synthetic software", category: "software" },
    { merchant_raw: "Synthetic transport", category: "transport" },
  ]);
  expect(current.states.slice(0, -1)).not.toContain("processed");
});
it("DOC-CLASSIFICATION-03 all negative documents are individually decided without financial calls", async () => {
  const current = flow(mixed("Shipping notification", "Your order shipped"));
  await current.drain();
  expect(current.classify).toHaveBeenCalledTimes(2);
  expect(current.extract).not.toHaveBeenCalled();
  expect(
    (
      await db
        .prepare("SELECT parse_state,parse_code FROM documents WHERE user_id=?")
        .bind(tenant.userId)
        .all()
    ).results,
  ).toEqual([
    { parse_state: "extracted", parse_code: "non-purchase" },
    { parse_state: "extracted", parse_code: "non-purchase" },
  ]);
  expect(current.states.slice(0, -1)).not.toContain("processed");
  expect(current.states.at(-1)).toBe("processed");
});
it("DOC-CLASSIFICATION-04 a negative body cannot make an opaque attachment complete", async () => {
  const current = flow(mixed("Shipping notification", "unknown", true));
  await current.drain();
  expect(current.classify).toHaveBeenCalledOnce();
  expect(current.extract).not.toHaveBeenCalled();
  expect(current.states.at(-1)).toBe("review");
  expect(
    (
      await db
        .prepare(
          "SELECT reason,blocking_scope FROM review_items WHERE user_id=?",
        )
        .bind(tenant.userId)
        .all()
    ).results,
  ).toEqual([{ reason: "document-review", blocking_scope: "operational" }]);
});

async function nextLease(): Promise<JobLease> {
  const id = await db
    .prepare(
      "SELECT id FROM jobs WHERE user_id=? AND status='ready' ORDER BY id LIMIT 1",
    )
    .bind(tenant.userId)
    .first<string>("id");
  if (!id) throw new Error("Synthetic continuation missing");
  const leaseId = `lease-${id}`;
  await db
    .prepare(
      "UPDATE jobs SET status='leased',lease_id=?,lease_expires_at=?,fence=1 WHERE user_id=? AND id=?",
    )
    .bind(leaseId, lease.expiresAt, tenant.userId, id)
    .run();
  return { ...lease, jobId: id, leaseId };
}
it("DOC-CLASSIFICATION-05 a sibling's negative cache cannot skip another document or the whole source", async () => {
  const current = flow(
    mixed("Shipping notification", "RECEIPT-software Synthetic invoice"),
  );
  await current.stage(lease);
  const first = await nextLease();
  await current.stage(first);
  const firstCache = await db
    .prepare(
      "SELECT e.run_key FROM ai_extractions e JOIN documents d ON d.user_id=e.user_id AND d.id=e.document_id WHERE e.user_id=? AND d.pipeline_index=0",
    )
    .bind(tenant.userId)
    .first<{ run_key: string }>();
  const secondDocument = await db
    .prepare("SELECT id FROM documents WHERE user_id=? AND pipeline_index=1")
    .bind(tenant.userId)
    .first<{ id: string }>();
  if (!firstCache || !secondDocument)
    throw new Error("Synthetic cache missing");
  const second = await nextLease(),
    repo = createPipelineRepository(db, {
      processingDigest: async () => "f".repeat(64),
    });
  if (!repo.skipDocument || !repo.skipSource)
    throw new Error("Synthetic skip methods unavailable");
  expect(await repo.checkpoint(second)).toBe(true);
  expect(
    await repo.skipDocument(second, {
      documentId: secondDocument.id,
      classificationFingerprint: firstCache.run_key,
      nextDocumentIndex: null,
    }),
  ).toBe("stale");
  // Even a valid current negative decision cannot authorize the whole-source shortcut for two documents.
  await db
    .prepare(
      "UPDATE jobs SET status='leased',lease_id=?,lease_expires_at=? WHERE user_id=? AND id=?",
    )
    .bind(first.leaseId, first.expiresAt, tenant.userId, first.jobId)
    .run();
  expect(await repo.checkpoint(first)).toBe(true);
  expect(await repo.skipSource(first, firstCache.run_key)).toBe("stale");
  expect(
    await db
      .prepare("SELECT parse_state FROM documents WHERE user_id=? AND id=?")
      .bind(tenant.userId, secondDocument.id)
      .first("parse_state"),
  ).toBe("ready");
  expect(
    await db
      .prepare("SELECT processing_status FROM source_messages WHERE user_id=?")
      .bind(tenant.userId)
      .first("processing_status"),
  ).toBe("discovered");
  expect(current.extract).not.toHaveBeenCalled();
});
it("DOC-CLASSIFICATION-06 cold PDF-only stages retain the direct parser identity and one paid extraction", async () => {
  const pdf: DocumentInput = {
    connectionId: "c",
    providerMessageId: "m",
    root: {
      partId: "invoice",
      mimeType: "application/pdf",
      filename: "synthetic.pdf",
      disposition: "attachment",
      bytes: new TextEncoder().encode(
        "%PDF-RECEIPT-software Synthetic invoice EUR 10.00",
      ),
    },
  };
  const current = flow(pdf);
  await current.drain();
  expect(current.classify).toHaveBeenCalledOnce();
  expect(current.extract).toHaveBeenCalledOnce();
  expect(
    await db
      .prepare("SELECT parser_version FROM documents WHERE user_id=?")
      .bind(tenant.userId)
      .first<string>("parser_version"),
  ).toBe("documents-direct-pdf-v2/synthetic-pdf-v2");
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM purchases WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(1);
});

it("DOC-CLASSIFICATION-07 stale cached content hash cannot authorize a negative document decision", async () => {
  const current = flow(
    mixed("Shipping notification", "RECEIPT-software Synthetic invoice"),
  );
  await current.stage(lease);
  const first = await nextLease();
  await current.stage(first);
  const cached = await db
    .prepare(
      "SELECT document_id,run_key FROM ai_extractions WHERE user_id=? AND extraction_version='email-classification-v1'",
    )
    .bind(tenant.userId)
    .first<{ document_id: string; run_key: string }>();
  if (!cached) throw new Error("Synthetic cache missing");
  await db
    .prepare(
      "UPDATE jobs SET status='leased',lease_id=?,lease_expires_at=? WHERE user_id=? AND id=?",
    )
    .bind(first.leaseId, first.expiresAt, tenant.userId, first.jobId)
    .run();
  await db
    .prepare(
      "UPDATE ai_extractions SET content_hash=? WHERE user_id=? AND run_key=?",
    )
    .bind("c".repeat(64), tenant.userId, cached.run_key)
    .run();
  const repo = createPipelineRepository(db, {
    processingDigest: async () => "f".repeat(64),
  });
  if (!repo.skipDocument) throw new Error("Synthetic skip unavailable");
  expect(
    await repo.skipDocument(first, {
      documentId: cached.document_id,
      classificationFingerprint: cached.run_key,
      nextDocumentIndex: 1,
    }),
  ).toBe("stale");
  expect(
    await db
      .prepare("SELECT processing_status FROM source_messages WHERE user_id=?")
      .bind(tenant.userId)
      .first("processing_status"),
  ).toBe("discovered");
});
it("DOC-CLASSIFICATION-08 real local Flate PDF conversion flows through cold per-document stages without persisting text", async () => {
  const pdfBytes = await generateCompressedTextPdf(
    "RECEIPT-software Synthetic receipt 2026-10-14 EUR 10.00 paid",
  );
  const pdf: DocumentInput = {
    connectionId: "c",
    providerMessageId: "m",
    root: {
      partId: "invoice",
      mimeType: "application/pdf",
      filename: "synthetic.pdf",
      disposition: "attachment",
      bytes: pdfBytes,
    },
  };
  const current = flow(
    pdf,
    createDocumentTextExtractor({ pdf: createLocalPdfTextExtractor() }),
  );
  await current.drain();
  expect(current.classify).toHaveBeenCalledOnce();
  expect(current.extract).toHaveBeenCalledOnce();
  expect(current.extract.mock.calls[0]?.[0][0]?.text).toContain(
    "RECEIPT-software",
  );
  expect(
    await db
      .prepare(
        "SELECT parser_version,byte_length,content_hash FROM documents WHERE user_id=?",
      )
      .bind(tenant.userId)
      .first(),
  ).toMatchObject({
    parser_version: `documents-direct-pdf-v2/${LOCAL_PDF_PARSER_VERSION}`,
    byte_length: pdfBytes.length,
  });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM ledger_entries WHERE user_id=? AND amount_minor=1000 AND kind='payment'",
      )
      .bind(tenant.userId)
      .first("n"),
  ).toBe(1);
  const cache = (
    await db
      .prepare("SELECT result_json FROM ai_extractions WHERE user_id=?")
      .bind(tenant.userId)
      .all()
  ).results;
  expect(JSON.stringify(cache)).not.toContain("RECEIPT-software");
  expect(JSON.stringify(cache)).not.toContain("quote");
  expect(current.states.at(-1)).toBe("processed");
});

it("DOC-CLASSIFICATION-09 an old staged unsupported PDF becomes a typed source-change review without silently invoking models", async () => {
  const current = flow(
    mixed("Shipping notification", "RECEIPT-software Synthetic invoice"),
  );
  await current.drain(async () => {
    await db
      .prepare(
        "UPDATE documents SET parser_version='documents-direct-v1',parse_state='needs_review',parse_code='converter_unavailable' WHERE user_id=? AND mime='application/pdf'",
      )
      .bind(tenant.userId)
      .run();
  });
  expect(current.classify).not.toHaveBeenCalled();
  expect(current.extract).not.toHaveBeenCalled();
  expect(
    (
      await db
        .prepare("SELECT DISTINCT parse_code FROM documents WHERE user_id=?")
        .bind(tenant.userId)
        .all()
    ).results,
  ).toEqual([{ parse_code: "source-changed" }]);
  expect(
    (
      await db
        .prepare(
          "SELECT DISTINCT reason,blocking_scope FROM review_items WHERE user_id=?",
        )
        .bind(tenant.userId)
        .all()
    ).results,
  ).toEqual([{ reason: "document-review", blocking_scope: "operational" }]);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND status IN('ready','retry_wait','leased')",
      )
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
  expect(current.states.at(-1)).toBe("review");
});
it("DOC-CLASSIFICATION-10 already paid body evidence survives a sibling parser upgrade without another financial attempt", async () => {
  const current = flow(
    mixed(
      "RECEIPT-software Synthetic receipt",
      "RECEIPT-transport Synthetic invoice",
    ),
  );
  await current.stage(lease);
  const classified = await nextLease();
  await current.stage(classified);
  await current.stage(await nextLease());
  await current.stage(await nextLease());
  expect(current.extract).toHaveBeenCalledOnce();
  const beforePurchase = await db
    .prepare(
      "SELECT id,total_minor,payment_state,version FROM purchases WHERE user_id=?",
    )
    .bind(tenant.userId)
    .first();
  const beforeCash = (
    await db
      .prepare(
        "SELECT id,amount_minor,eligible,version FROM ledger_entries WHERE user_id=?",
      )
      .bind(tenant.userId)
      .all()
  ).results;
  expect(beforeCash).toHaveLength(1);
  await db
    .prepare(
      "UPDATE documents SET parser_version='documents-direct-v1',parse_state='needs_review',parse_code='converter_unavailable' WHERE user_id=? AND mime='application/pdf'",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "UPDATE jobs SET status='leased',lease_id='replay-body',lease_expires_at=?,fence=fence+1 WHERE user_id=? AND id=?",
    )
    .bind(lease.expiresAt, tenant.userId, classified.jobId)
    .run();
  await current.stage({
    ...classified,
    leaseId: "replay-body",
    fence: classified.fence + 1,
  });
  await current.stage(await nextLease());
  expect(current.extract).toHaveBeenCalledOnce();
  expect(current.classify).toHaveBeenCalledOnce();
  expect(
    await db
      .prepare(
        "SELECT id,total_minor,payment_state,version FROM purchases WHERE user_id=?",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual(beforePurchase);
  expect(
    (
      await db
        .prepare(
          "SELECT id,amount_minor,eligible,version FROM ledger_entries WHERE user_id=?",
        )
        .bind(tenant.userId)
        .all()
    ).results,
  ).toEqual(beforeCash);
  expect(
    (
      await db
        .prepare("SELECT DISTINCT parse_code FROM documents WHERE user_id=?")
        .bind(tenant.userId)
        .all()
    ).results,
  ).toEqual([{ parse_code: "source-changed" }]);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND status IN('ready','retry_wait','leased')",
      )
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
  expect(current.states.at(-1)).toBe("review");
});
