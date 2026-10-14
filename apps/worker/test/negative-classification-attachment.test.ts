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
  userId: "negative-attachment-owner",
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

function flow(
  output: unknown,
  contentInput: DocumentInput = input,
  probability = 0.01,
) {
  const classify = vi.fn(async () => ({
    model: "clef",
    answers: {
      receipt: { type: "noul", noul: probability },
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
  return { drain, stage, classify, extract, load, counts };
}

const withPdf: DocumentInput = {
  ...input,
  root: {
    partId: "mixed",
    mimeType: "multipart/mixed",
    children: [
      input.root,
      {
        partId: "pdf",
        mimeType: "application/pdf",
        filename: "synthetic.pdf",
        disposition: "attachment",
        bytes: new TextEncoder().encode("%PDF-synthetic bytes"),
      },
    ],
  },
};
it("NEGATIVE-BINARY-01 a negative readable body never enters financial extraction while its unreadable PDF remains reviewable", async () => {
  const current = flow({}, withPdf, 0.01);
  await current.drain();
  expect(current.classify).toHaveBeenCalledOnce();
  expect(current.extract).not.toHaveBeenCalled();
  expect(
    (
      await db
        .prepare(
          "SELECT r.reason,r.blocking_scope,d.part_key,d.parse_code FROM review_items r JOIN documents d ON d.user_id=r.user_id AND d.id=r.document_id WHERE r.user_id=?",
        )
        .bind(tenant.userId)
        .all()
    ).results,
  ).toEqual([
    {
      reason: "document-review",
      blocking_scope: "operational",
      part_key: "pdf",
      parse_code: "converter_unavailable",
    },
  ]);
  expect(
    await db
      .prepare("SELECT processing_status FROM source_messages WHERE user_id=?")
      .bind(tenant.userId)
      .first("processing_status"),
  ).toBe("review");
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM purchases WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT parse_state,parse_code FROM documents WHERE user_id=? AND part_key!='pdf'",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual({ parse_state: "extracted", parse_code: "non-purchase" });
});
it("NEGATIVE-BINARY-02 a positive readable body still reaches extraction despite an unreadable PDF", async () => {
  const current = flow({}, withPdf, 0.99);
  await current.drain();
  expect(current.extract).toHaveBeenCalledOnce();
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM review_items r JOIN documents d ON d.user_id=r.user_id AND d.id=r.document_id WHERE r.user_id=? AND d.part_key='pdf' AND r.blocking_scope='operational'",
      )
      .bind(tenant.userId)
      .first("n"),
  ).toBe(1);
});

it("NEGATIVE-BINARY-03 attachment-first durable ordering retains unresolved attachment without extracting a negative body", async () => {
  const current = flow({}, withPdf, 0.01);
  await current.drain(async () => {
    await db
      .prepare("UPDATE documents SET pipeline_index=NULL WHERE user_id=?")
      .bind(tenant.userId)
      .run();
    await db
      .prepare(
        "UPDATE documents SET pipeline_index=CASE WHEN part_key='pdf' THEN 0 ELSE 1 END WHERE user_id=?",
      )
      .bind(tenant.userId)
      .run();
  });
  expect(current.classify).toHaveBeenCalledOnce();
  expect(current.extract).not.toHaveBeenCalled();
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
  expect(
    await db
      .prepare("SELECT processing_status FROM source_messages WHERE user_id=?")
      .bind(tenant.userId)
      .first("processing_status"),
  ).toBe("review");
});
it.each([
  "stale-lease",
  "other-tenant",
  "generation",
  "credential",
  "revision",
  "unfinished",
  "positive",
] as const)(
  "NEGATIVE-BINARY-04 %s cannot authorize per-document skipping",
  async (change) => {
    await flow({}, withPdf, 0.01).drain();
    const cached = await db
      .prepare(
        "SELECT run_key FROM ai_extractions WHERE user_id=? AND extraction_version='email-classification-v1'",
      )
      .bind(tenant.userId)
      .first<{ run_key: string }>();
    const body = await db
      .prepare("SELECT id FROM documents WHERE user_id=? AND part_key!='pdf'")
      .bind(tenant.userId)
      .first<{ id: string }>();
    if (!cached || !body) throw new Error("Synthetic classification missing");
    await db
      .prepare(
        "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,lease_id,lease_expires_at,fence) VALUES('guarded-skip',?,'c','consent',1,'source-extract','guarded-skip','leased',0,'guarded-lease',?,1)",
      )
      .bind(tenant.userId, lease.expiresAt)
      .run();
    await db
      .prepare(
        "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id,pipeline_stage,document_index) VALUES(?,'guarded-skip','s','infer',0)",
      )
      .bind(tenant.userId)
      .run();
    const current = {
      ...lease,
      jobId: "guarded-skip",
      leaseId: "guarded-lease",
    };
    const repo = createPipelineRepository(db);
    expect(await repo.checkpoint(current)).toBe(true);
    if (change === "stale-lease") current.fence = 2;
    else if (change === "other-tenant")
      current.context = {
        userId: "another-user",
        authority: "job",
      } as TenantContext;
    else {
      const assignments = {
        generation: "generation=generation+1",
        credential: "credential_version=credential_version+1",
        revision: "settings_revision=settings_revision+1",
        unfinished: "completed_at=NULL,result_json=NULL",
        positive:
          'result_json=\'{"status":"classified","isReceipt":true,"category":"dining"}\'',
      };
      await db
        .prepare(
          `UPDATE ai_extractions SET ${assignments[change]} WHERE user_id=? AND run_key=?`,
        )
        .bind(tenant.userId, cached.run_key)
        .run();
    }
    if (!repo.skipDocument) throw new Error("Per-document skip unavailable");
    expect(
      await repo.skipDocument(current, {
        documentId: body.id,
        classificationFingerprint: cached.run_key,
        nextDocumentIndex: 1,
      }),
    ).toBe("stale");
    expect(
      await db
        .prepare(
          "SELECT status FROM jobs WHERE user_id=? AND id='guarded-skip'",
        )
        .bind(tenant.userId)
        .first("status"),
    ).toBe("leased");
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM review_items WHERE user_id=?")
        .bind(tenant.userId)
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT processing_status FROM source_messages WHERE user_id=?",
        )
        .bind(tenant.userId)
        .first("processing_status"),
    ).toBe("review");
  },
);

it("NEGATIVE-BINARY-05 reprocessing a negative body preserves accepted cash and incomplete import counts", async () => {
  lease = { ...lease, type: "reprocess" };
  await db
    .prepare("UPDATE jobs SET type='reprocess' WHERE user_id=?")
    .bind(tenant.userId)
    .run();
  const current = flow({}, withPdf, 0.01);
  await current.drain(async () => {
    const body = await db
      .prepare("SELECT id FROM documents WHERE user_id=? AND part_key!='pdf'")
      .bind(tenant.userId)
      .first<{ id: string }>();
    if (!body) throw new Error("Synthetic body missing");
    await db
      .prepare(
        "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state,version) VALUES('prior-purchase',?,'Synthetic prior','synthetic prior','2026-10-14',1200,'EUR','paid',7)",
      )
      .bind(tenant.userId)
      .run();
    await db
      .prepare(
        "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('prior-observation',?,?,0,'prior',1,'explicitly-paid','{\"schemaVersion\":1}','accepted')",
      )
      .bind(tenant.userId, body.id)
      .run();
    await db
      .prepare(
        "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,'prior-purchase','prior-observation','document')",
      )
      .bind(tenant.userId)
      .run();
    await db
      .prepare(
        "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES('prior-payment',?,'prior-purchase','prior-observation','prior-payment','payment',1200,'EUR','2026-10-14','explicit-event-date',1)",
      )
      .bind(tenant.userId)
      .run();
    await db
      .prepare(
        "INSERT INTO import_runs(id,user_id,connection_id,consent_id,connection_generation,frozen_start,frozen_cutoff,timezone,request_fingerprint,started_at,discovered_count) VALUES('prior-import',?,'c','consent',1,'2025-10-14T00:00:00.000Z','2026-10-15T00:00:00.000Z','UTC','prior-import',0,1)",
      )
      .bind(tenant.userId)
      .run();
    await db
      .prepare(
        "INSERT INTO discovery_run_sources(user_id,import_run_id,source_message_id,candidate_kind) VALUES(?,'prior-import','s','matched')",
      )
      .bind(tenant.userId)
      .run();
  });
  expect(current.extract).not.toHaveBeenCalled();
  expect(
    await db
      .prepare(
        "SELECT total_minor,payment_state,version FROM purchases WHERE user_id=? AND id='prior-purchase'",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual({ total_minor: 1200, payment_state: "paid", version: 7 });
  expect(
    await db
      .prepare(
        "SELECT amount_minor,eligible,version,observation_id FROM ledger_entries WHERE user_id=?",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual({
    amount_minor: 1200,
    eligible: 1,
    version: 1,
    observation_id: "prior-observation",
  });
  expect(
    await db
      .prepare(
        "SELECT discovered_count,processed_count,completed_at FROM import_runs WHERE user_id=?",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual({ discovered_count: 1, processed_count: 0, completed_at: null });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM review_items WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(1);
  expect(Math.max(...current.counts)).toBeLessThanOrEqual(40);
});
