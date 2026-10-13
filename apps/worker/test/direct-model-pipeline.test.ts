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
import type { ContentLoadInput } from "../../../packages/adapters/src/pipeline/gmail-content";
import { createPipelineRepository } from "../../../packages/adapters/src/pipeline/repository";
import { createPipelineService } from "../../../packages/adapters/src/pipeline/service";
import { createInvocationDatabase } from "../src/invocation-database";

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
  userId: "direct-model-owner",
  authority: "job",
} as TenantContext;
const documents = createDocumentTextExtractor();
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

function modelReceipt(unpaid = false) {
  return {
    schemaVersion: 1,
    documentType: unpaid ? "invoice" : "receipt",
    warnings: [],
    records: [
      {
        merchant: "Café Étoile",
        documentDate: "2026-10-14",
        eventDate: unpaid ? null : "2026-10-14",
        currency: "EUR",
        total: "19.99",
        tax: null,
        invoiceNumber: null,
        orderReference: null,
        category: "dining",
        paymentEvidence: unpaid ? "explicitly-unpaid" : "explicitly-paid",
        refundEvidence: "none",
        paymentMethodHint: unpaid ? "unknown" : "card",
        recurringCadence: "unknown",
        paymentAmount: unpaid ? null : "19.99",
        refundAmount: null,
        storeCreditAmount: null,
        evidence: [
          { field: "merchant", inputPartId: "part-1", quote: "Café Étoile" },
          {
            field: "documentDate",
            inputPartId: "part-1",
            quote: "14 Oktober 2026",
          },
          { field: "currency", inputPartId: "part-1", quote: "€" },
          { field: "total", inputPartId: "part-1", quote: "19,99 €" },
          {
            field: "payment",
            inputPartId: "part-1",
            quote: unpaid ? "Noch nicht bezahlt" : "Zahlung erhalten",
          },
          ...(!unpaid
            ? [
                {
                  field: "eventDate",
                  inputPartId: "part-1",
                  quote: "14 Oktober 2026",
                },
                {
                  field: "paymentAmount",
                  inputPartId: "part-1",
                  quote: "19,99 €",
                },
              ]
            : []),
        ],
      },
    ],
  };
}
function flow(
  output: unknown,
  contentInput: DocumentInput = input,
  classificationEnabled = true,
) {
  const classify = vi.fn(async () => ({
    model: "clef",
    answers: {
      receipt: { type: "noul", noul: 0.99 },
      category: {
        type: "choice",
        choice: "dining",
        probabilities: { dining: 0.99, uncategorized: 0.01 },
        confidence: 0.99,
      },
    },
    usage: { input_tokens: 50, output_tokens: 0 },
  }));
  const extract = vi.fn(async (parts: readonly AiTextPart[]) => {
    expect(parts.length).toBeGreaterThan(0);
    return {
      status: "ok" as const,
      output: JSON.stringify(output),
      finish: "complete" as const,
      usage: { input: 50, output: 80, other: 0, source: "reported" as const },
    };
  });
  const load = vi.fn(async (request: ContentLoadInput) => {
    expect(request.providerMessageId).toBe("m");
    return { status: "ready" as const, input: contentInput };
  });
  const counts: number[] = [];
  async function stage(current: JobLease) {
    const meter = createInvocationDatabase(db, 40);
    const pipeline = createPipelineService(meter.db, {
      repository: createPipelineRepository(meter.db),
      documents,
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
      ...(classificationEnabled
        ? {
            classification: createReceiptClassifierFactory(
              meter.db,
              classification,
              { binding: { run: classify } },
            ),
          }
        : {}),
      budget: policy,
      remainingStatements: () => meter.remainingStatements(),
    });
    const result = await pipeline.run(current, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    });
    counts.push(meter.executedStatements());
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
    expect(result).toEqual({ kind: "completed" });
  }
  async function drain() {
    await stage(lease);
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
  return { drain, stage, classify, extract, load, counts };
}
it("direct model MIME alternatives retain raw foreign HTML and commit one exact paid purchase", async () => {
  const current = flow(modelReceipt());
  await current.drain();
  expect(current.classify).toHaveBeenCalledOnce();
  expect(current.extract).toHaveBeenCalledOnce();
  const parts = current.extract.mock.calls[0]?.[0];
  expect(parts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "part-0",
        text: expect.stringContaining("Synthetic plain"),
        interpretation: "model",
      }),
      expect.objectContaining({
        id: "part-1",
        text: html,
        interpretation: "model",
      }),
    ]),
  );
  expect(
    (
      await db
        .prepare(
          "SELECT merchant_raw,document_date,total_minor,currency,payment_state FROM purchases WHERE user_id=?",
        )
        .bind(tenant.userId)
        .all()
    ).results,
  ).toEqual([
    {
      merchant_raw: "Café Étoile",
      document_date: "2026-10-14",
      total_minor: 1999,
      currency: "EUR",
      payment_state: "paid",
    },
  ]);
  expect(
    (
      await db
        .prepare(
          "SELECT amount_minor,currency,event_date,kind FROM ledger_entries WHERE user_id=?",
        )
        .bind(tenant.userId)
        .all()
    ).results,
  ).toEqual([
    {
      amount_minor: 1999,
      currency: "EUR",
      event_date: "2026-10-14",
      kind: "payment",
    },
  ]);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM documents WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(1);
  const cache = await db
    .prepare(
      "SELECT result_json FROM ai_extractions WHERE user_id=? AND extraction_version=?",
    )
    .bind(tenant.userId, EXTRACTION_PROMPT_VERSION)
    .first<string>("result_json");
  expect(cache).not.toContain('"quote"');
  expect(cache).not.toContain("<html");
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM review_items WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
});
it("direct model unpaid invoice remains a purchase with no payment ledger entry", async () => {
  const unpaidInput: DocumentInput = {
    ...input,
    root: {
      ...input.root,
      children: (input.root.children ?? []).map((part) =>
        part.mimeType === "text/html"
          ? {
              ...part,
              bytes: new TextEncoder().encode(
                html.replace(
                  "<td>erhalten</td>",
                  "<td>Noch nicht bezahlt</td>",
                ),
              ),
            }
          : part,
      ),
    },
  };
  const current = flow(modelReceipt(true), unpaidInput);
  await current.drain();
  expect(
    (
      await db
        .prepare(
          "SELECT total_minor,payment_state FROM purchases WHERE user_id=?",
        )
        .bind(tenant.userId)
        .all()
    ).results,
  ).toEqual([{ total_minor: 1999, payment_state: "unpaid" }]);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM ledger_entries WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
});
it("direct model invalid part provenance cannot publish a purchase", async () => {
  const output = modelReceipt();
  for (const evidence of output.records[0]?.evidence ?? [])
    evidence.inputPartId = "missing-part";
  await flow(output).drain();
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM purchases WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM review_items WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(1);
});
it("direct model ambiguous missing total remains review-only", async () => {
  const output = modelReceipt();
  const record = output.records[0];
  if (!record) throw new Error("Synthetic model record missing");
  const ambiguous = {
    ...output,
    records: [
      {
        ...record,
        total: null,
        paymentAmount: null,
        eventDate: null,
        paymentEvidence: "unknown",
        paymentMethodHint: "unknown",
      },
    ],
    warnings: ["missing-total"],
  };
  await flow(ambiguous).drain();
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM purchases WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM review_items WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(1);
});

it("direct model multipart body remains whole when classifier is disabled and PDF is unsupported", async () => {
  const mixed: DocumentInput = {
    ...input,
    root: {
      partId: "",
      mimeType: "multipart/mixed",
      children: [
        { ...input.root, partId: "alternative" },
        {
          partId: "pdf",
          mimeType: "application/pdf",
          filename: "synthetic.pdf",
          disposition: "attachment",
          bytes: new TextEncoder().encode(
            "%PDF-1.4\nsynthetic unsupported binary",
          ),
        },
      ],
    },
  };
  const current = flow(modelReceipt(), mixed, false);
  await current.drain();
  expect(current.classify).not.toHaveBeenCalled();
  expect(current.extract).toHaveBeenCalledOnce();
  expect(
    current.load.mock.calls.every(([request]) => request.partKey === undefined),
  ).toBe(true);
  expect(
    (
      await db
        .prepare(
          "SELECT total_minor,payment_state FROM purchases WHERE user_id=?",
        )
        .bind(tenant.userId)
        .all()
    ).results,
  ).toEqual([{ total_minor: 1999, payment_state: "paid" }]);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM ledger_entries WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(1);
});
