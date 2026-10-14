import { env } from "cloudflare:workers";
import { EXTRACTION_PROMPT_VERSION } from "@invoxim/contracts";
import {
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
import { createPipelineRepository } from "../../../packages/adapters/src/pipeline/repository";
import { createPipelineService } from "../../../packages/adapters/src/pipeline/service";
import { createInvocationDatabase } from "../src/invocation-database";
import { createPipelineRuntime } from "../src/pipeline-runtime";

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
const tenant = { userId: "clef-owner", authority: "job" } as TenantContext;
const documents = createDocumentTextExtractor();
const input = {
  connectionId: "c",
  providerMessageId: "m",
  root: {
    partId: "body",
    mimeType: "text/plain",
    bytes: new TextEncoder().encode(
      "Synthetic software invoice 15 EUR. Unpaid.",
    ),
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
  expectedDigest = "f".repeat(64);
  await db.prepare('DELETE FROM "user" WHERE id=?').bind(tenant.userId).run();
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Synthetic','clef@example.invalid',1,0,0)",
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
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state,credential_ciphertext,credential_key_version,credential_version) VALUES('c',?,'mailbox','gmail','subject','clef@example.invalid','active','synthetic',1,1)",
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
  const parsed = await documents.extract(input, { tenant });
  const document = parsed.documents[0];
  if (!document) throw new Error("fixture missing");
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length,pipeline_index,parser_version,parse_state) VALUES('d',?,'s','body',?,'text/plain',100,0,?,'ready')",
    )
    .bind(tenant.userId, document.contentHash, document.parserVersion)
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
      "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id,pipeline_stage) VALUES(?,'job','s','infer')",
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
/** P7: tests pass processingDigest explicitly; consent-renewal cases rotate it. */
let expectedDigest = "f".repeat(64);
function service(
  probability: number,
  budget = policy,
  contentInput: DocumentInput = input,
  override?: () => unknown,
  uncertainAction: "review" | "extract" = "review",
) {
  const run = vi.fn(async () =>
    override
      ? override()
      : {
          model: "clef",
          answers: {
            documentType: {
              type: "choice",
              choice: probability <= 0.1 ? "delivery" : "invoice",
              probabilities: {
                [probability <= 0.1 ? "delivery" : "invoice"]: 1,
              },
              confidence: 1,
            },
            receipt: { type: "noul", noul: probability },
            category: {
              type: "choice",
              choice: "software",
              probabilities: { software: 0.9, uncategorized: 0.1 },
              confidence: 0.9,
            },
          },
          usage: { input_tokens: 50, output_tokens: 0 },
        },
  );
  const extract = vi.fn(async () => ({
    status: "ok" as const,
    output: "{}",
    finish: "complete" as const,
    usage: { input: 20, output: 1, other: 0, source: "reported" as const },
  }));
  const counts: number[] = [];
  const pipeline = {
    async run(
      current: JobLease,
      control: { signal: AbortSignal; checkpoint: () => Promise<boolean> },
    ) {
      const meter = createInvocationDatabase(db, 40);
      const handler = createPipelineService(meter.db, {
        repository: createPipelineRepository(meter.db, {
          processingDigest: async () => expectedDigest,
        }),
        documents,
        content: {
          open: async () => ({
            load: async () => ({ status: "ready", input: contentInput }),
          }),
        },
        inference: {
          open: async () => ({
            config,
            extractor: { extract },
            pricing: new Map([[config.fingerprint, price]]),
          }),
        },
        classification: createReceiptClassifierFactory(
          meter.db,
          { ...classification, uncertainAction },
          { binding: { run } },
        ),
        budget,
        remainingStatements: () => 40 - meter.executedStatements(),
      });
      const result = await handler.run(current, control);
      counts.push(meter.executedStatements());
      expect(meter.executedStatements()).toBeLessThanOrEqual(40);
      return result;
    },
  };
  return { pipeline, run, extract, counts };
}
const control = {
  signal: new AbortController().signal,
  checkpoint: async () => true,
};
it("CLEF-01 native negative decision consumes Cloudflare allowance but creates no financial request or purchase", async () => {
  const { pipeline, run, extract } = service(0.01);
  expect(await pipeline.run(lease, control)).toEqual({ kind: "completed" });
  expect(run).toHaveBeenCalledTimes(1);
  expect(extract).not.toHaveBeenCalled();
  expect(
    await db
      .prepare(
        "SELECT processing_status FROM source_messages WHERE user_id=? AND id='s'",
      )
      .bind(tenant.userId)
      .first("processing_status"),
  ).toBe("processed");
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM purchases WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
  const events = await db
    .prepare(
      "SELECT destination_id,model_id,state,actual_usd_micros FROM usage_events WHERE user_id=?",
    )
    .bind(tenant.userId)
    .all();
  expect(events.results).toMatchObject([
    {
      destination_id: "cloudflare-clef",
      model_id: "@cf/cloudflare/clef",
      state: "known",
      actual_usd_micros: "12",
    },
  ]);
  expect(
    await db
      .prepare(
        "SELECT MAX(documents) AS n FROM usage_buckets WHERE scope='tenant' AND user_id=?",
      )
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
  expect(await pipeline.run(lease, control)).toEqual({
    kind: "paused",
    code: "auth",
  });
  expect(run).toHaveBeenCalledTimes(1);
});
it("CLEF-01 native positive decision resumes a fresh invocation and bills classifier and financial extraction separately", async () => {
  const { pipeline, run, extract } = service(0.9);
  expect(await pipeline.run(lease, control)).toEqual({ kind: "completed" });
  expect(extract).not.toHaveBeenCalled();
  const next = await db
    .prepare("SELECT id FROM jobs WHERE user_id=? AND status='ready'")
    .bind(tenant.userId)
    .first<string>("id");
  if (!next) throw new Error("continuation missing");
  await db
    .prepare(
      "UPDATE jobs SET status='leased',lease_id='next-lease',lease_expires_at=?,fence=1 WHERE user_id=? AND id=?",
    )
    .bind(lease.expiresAt, tenant.userId, next)
    .run();
  expect(
    await pipeline.run(
      { ...lease, jobId: next, leaseId: "next-lease" },
      control,
    ),
  ).toEqual({ kind: "completed" });
  expect(run).toHaveBeenCalledTimes(1);
  expect(extract).toHaveBeenCalledTimes(1);
  const events = await db
    .prepare(
      "SELECT destination_id FROM usage_events WHERE user_id=? ORDER BY destination_id",
    )
    .bind(tenant.userId)
    .all();
  expect(events.results).toEqual([
    { destination_id: "abacus" },
    { destination_id: "cloudflare-clef" },
  ]);
});
it("CLEF-01 native classifier budget denial sends no email to either provider", async () => {
  const { pipeline, run, extract } = service(0.9, { ...policy, dailyUnits: 1 });
  expect(await pipeline.run(lease, control)).toEqual({
    kind: "paused",
    code: "budget",
  });
  expect(run).not.toHaveBeenCalled();
  expect(extract).not.toHaveBeenCalled();
});
it("CLEF-01 native missing usage retains the conservative reservation and accepts the decision", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { pipeline, run } = service(0.01, policy, input, () => ({
      model: "clef",
      answers: {
        documentType: {
          type: "choice",
          choice: "delivery",
          probabilities: { delivery: 1 },
          confidence: 1,
        },
        receipt: { type: "noul", noul: 0.01 },
        category: {
          type: "choice",
          choice: "software",
          probabilities: { software: 1 },
          confidence: 1,
        },
      },
    }));
    expect(await pipeline.run(lease, control)).toEqual({ kind: "completed" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      await db
        .prepare("SELECT state FROM usage_events WHERE user_id=?")
        .bind(tenant.userId)
        .first("state"),
    ).toBe("uncertain");
    expect(
      await db
        .prepare(
          "SELECT MAX(reserved_usd_micros) AS n FROM usage_buckets WHERE scope='global'",
        )
        .first("n"),
    ).toBeGreaterThan(0);
  } finally {
    warning.mockRestore();
  }
});
it("CLEF-01 native changed settings, revoked consent and stolen lease prevent either provider call", async () => {
  for (const update of [
    "UPDATE ai_settings SET status='deleted' WHERE user_id=?",
    "UPDATE processing_consents SET revoked_at=1 WHERE user_id=?",
    "UPDATE jobs SET fence=2 WHERE user_id=?",
  ]) {
    const { pipeline, run, extract } = service(0.01);
    await db.prepare(update).bind(tenant.userId).run();
    expect(await pipeline.run(lease, control)).toEqual({
      kind: "paused",
      code: "auth",
    });
    expect(run).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    // Restore only this synthetic test's fences before the next independent case.
    await db
      .prepare("UPDATE ai_settings SET status='active' WHERE user_id=?")
      .bind(tenant.userId)
      .run();
    await db
      .prepare("UPDATE processing_consents SET revoked_at=NULL WHERE user_id=?")
      .bind(tenant.userId)
      .run();
    await db
      .prepare("UPDATE jobs SET fence=1 WHERE user_id=?")
      .bind(tenant.userId)
      .run();
  }
});
it.each([0.9, 0.45])(
  "CLEF-01 native BYOK score %s extraction destination remains selected while the classifier is operator funded",
  async (probability) => {
    await db
      .prepare(
        "UPDATE ai_settings SET mode='byok',encrypted_key='synthetic',key_version=1 WHERE user_id=?",
      )
      .bind(tenant.userId)
      .run();
    config = {
      ...config,
      mode: "byok",
      fingerprint: await computeAiFingerprint({
        mode: "byok",
        configurationDigest: price.configurationDigest,
        settingsRevision: 1,
        generation: 1,
        credentialVersion: 0,
        policyVersion: 1,
        consentId: "consent",
      }),
    };
    const { pipeline, run, extract } = service(
      probability,
      policy,
      input,
      undefined,
      "extract",
    );
    expect(await pipeline.run(lease, control)).toEqual({ kind: "completed" });
    const next = await db
      .prepare("SELECT id FROM jobs WHERE user_id=? AND status='ready'")
      .bind(tenant.userId)
      .first<string>("id");
    if (!next) throw new Error("continuation missing");
    await db
      .prepare(
        "UPDATE jobs SET status='leased',lease_id='next',lease_expires_at=?,fence=CASE WHEN fence=0 THEN 1 ELSE fence END WHERE user_id=? AND id=?",
      )
      .bind(lease.expiresAt, tenant.userId, next)
      .run();
    expect(
      await pipeline.run({ ...lease, jobId: next, leaseId: "next" }, control),
    ).toEqual({ kind: "completed" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);
    const events = await db
      .prepare(
        "SELECT destination_id,mode FROM usage_events WHERE user_id=? ORDER BY destination_id",
      )
      .bind(tenant.userId)
      .all();
    expect(events.results).toEqual([
      { destination_id: "abacus", mode: "byok" },
      { destination_id: "cloudflare-clef", mode: "hosted" },
    ]);
  },
);
it("CLEF-01 actual runtime with encrypted Gmail credential and consent digest completes classifier and extraction within forty statements", async () => {
  const { aiConfiguration } =
    await import("../../../packages/adapters/src/ai/configuration");
  const { gmailConfiguration } =
    await import("../../../packages/adapters/src/mailbox/configuration");
  const { createCredentialCipher, encodeBase64url } =
    await import("../../../packages/adapters/src/security/cipher");
  const { selectedOnboardingConfigurationDigest } =
    await import("../../../packages/adapters/src/onboarding/configuration");
  const { createGmailContentFactory } =
    await import("../../../packages/adapters/src/pipeline/gmail-factory");
  const keyring = {
    activeVersion: 1,
    keys: { 1: encodeBase64url(new Uint8Array(32).fill(11)) },
  };
  const binding = {
    run: vi.fn(async () => ({
      model: "clef",
      answers: {
        documentType: {
          type: "choice",
          choice: "invoice",
          probabilities: { invoice: 1 },
          confidence: 1,
        },
        receipt: { type: "noul", noul: 0.9 },
        category: {
          type: "choice",
          choice: "software",
          probabilities: { software: 1 },
          confidence: 1,
        },
      },
      usage: { input_tokens: 50, output_tokens: 0 },
    })),
  };
  const bindings = {
    DB: db,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://synthetic.example",
    AUTH_SECRET: "synthetic-qa-secret-never-production-12345",
    AUTH_GOOGLE_CLIENT_ID: "synthetic",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic",
    AUTH_ALLOWED_EMAILS: '["qa@example.invalid"]',
    GMAIL_ENABLED: "true",
    GMAIL_CLIENT_ID: "synthetic",
    GMAIL_CLIENT_SECRET: "synthetic",
    CREDENTIAL_KEYRING: JSON.stringify(keyring),
    AI_ENABLED: "true",
    AI_HOSTED_DESTINATION: "abacus",
    AI_HOSTED_MODEL: "financial",
    AI_HOSTED_KEY: "synthetic-key",
    AI_BUDGET_JSON: JSON.stringify(policy),
    AI_CLASSIFICATION_JSON: JSON.stringify(classification),
    AI: binding,
    AI_REGISTRY_JSON: JSON.stringify([
      {
        id: "abacus",
        endpoint: "https://model.example.invalid/v1/chat/completions",
        configVersion: "v1",
        policyVersion: 1,
        noticeRefs: ["synthetic"],
        notices: [
          {
            id: "synthetic",
            displayName: "Synthetic financial processor",
            dataUseSummary: "Synthetic only",
            retentionSummary: "Synthetic only",
            privacyUrl: "https://policy.example.invalid",
          },
        ],
        timeoutMs: 1000,
        maxInputBytes: 24000,
        maxOutputBytes: 4096,
        maxOutputTokens: 100,
        models: [
          {
            id: "financial",
            capabilities: {
              jsonSchema: false,
              jsonObject: true,
              outputLimit: "max_tokens",
              usage: true,
              idempotency: false,
            },
            pricing: classification.pricing,
          },
        ],
      },
    ]),
  };
  const ai = aiConfiguration(bindings),
    gmail = gmailConfiguration(bindings);
  if (!ai || !gmail) throw new Error("runtime config missing");
  const destination = ai.destinations[0],
    model = destination?.models[0];
  if (!destination || !model) throw new Error("fixture model missing");
  const digest = await selectedOnboardingConfigurationDigest({
    mode: "hosted",
    settingsRevision: 1,
    destination,
    model,
    ...(ai.classification ? { classification: ai.classification } : {}),
  });
  await db
    .prepare(
      "UPDATE processing_consents SET accepted_configuration_digest=? WHERE user_id=?",
    )
    .bind(digest, tenant.userId)
    .run();
  const encrypted = await createCredentialCipher(keyring).seal(
    tenant,
    { entityId: "c", purpose: "mailbox-credentials" },
    {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: Date.now() + 3600000,
    },
  );
  await db
    .prepare(
      "UPDATE connections SET credential_ciphertext=?,scopes=? WHERE user_id=?",
    )
    .bind(
      encrypted,
      JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
      tenant.userId,
    )
    .run();
  let financialCalls = 0;
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (request) => {
      if (String(request).startsWith("https://gmail.googleapis.com/"))
        return Response.json({
          id: "m",
          payload: {
            partId: "body",
            mimeType: "text/plain",
            body: {
              size: input.root.bytes.length,
              data: encodeBase64url(input.root.bytes),
            },
          },
        });
      if (String(request).startsWith("https://model.example.invalid/")) {
        financialCalls++;
        return Response.json({
          choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 },
        });
      }
      throw new Error("unexpected synthetic destination");
    });
  try {
    const execute = async (current: JobLease) => {
      const meter = createInvocationDatabase(db, 40);
      const result = await createPipelineRuntime({
        db: meter.db,
        content: createGmailContentFactory(meter.db, gmail),
        ai,
        classificationBinding: binding,
        remainingStatements: () => 40 - meter.executedStatements(),
      }).run(current, control);
      expect(meter.executedStatements()).toBeLessThanOrEqual(40);
      return result;
    };
    expect(await execute(lease)).toEqual({ kind: "completed" });
    expect(financialCalls).toBe(0);
    const next = await db
      .prepare("SELECT id FROM jobs WHERE user_id=? AND status='ready'")
      .bind(tenant.userId)
      .first<string>("id");
    if (!next) throw new Error("runtime continuation missing");
    await db
      .prepare(
        "UPDATE jobs SET status='leased',lease_id='next',lease_expires_at=?,fence=CASE WHEN fence=0 THEN 1 ELSE fence END WHERE user_id=? AND id=?",
      )
      .bind(lease.expiresAt, tenant.userId, next)
      .run();
    expect(await execute({ ...lease, jobId: next, leaseId: "next" })).toEqual({
      kind: "completed",
    });
    expect(financialCalls).toBe(1);
    expect(binding.run).toHaveBeenCalledTimes(1);
  } finally {
    fetcher.mockRestore();
  }
});
async function sourceDocuments(content: DocumentInput) {
  const parsed = await documents.extract(content, { tenant });
  await db
    .prepare("DELETE FROM documents WHERE user_id=?")
    .bind(tenant.userId)
    .run();
  for (const [index, document] of parsed.documents.entries())
    await db
      .prepare(
        "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length,pipeline_index,parser_version,parse_state,parse_code) VALUES(?,?,'s',?,?,?,100,?,?,?,?)",
      )
      .bind(
        index === 0 ? "d" : `d-${index}`,
        tenant.userId,
        document.identity.partId,
        document.contentHash,
        document.mimeType,
        index,
        document.parserVersion,
        document.status,
        document.status === "ready" ? null : document.code,
      )
      .run();
}
function twoParts(unsupported = false): DocumentInput {
  return {
    connectionId: "c",
    providerMessageId: "m",
    root: {
      partId: "",
      mimeType: "multipart/mixed",
      children: [
        input.root,
        {
          partId: "attachment",
          mimeType: unsupported ? "image/jpeg" : "text/plain",
          bytes: new TextEncoder().encode(
            "Synthetic second software invoice EUR 30 unpaid.",
          ),
        },
      ],
    },
  };
}
async function continueLease(): Promise<JobLease> {
  const row = await db
    .prepare(
      "SELECT id FROM jobs WHERE user_id=? AND status='ready' ORDER BY rowid LIMIT 1",
    )
    .bind(tenant.userId)
    .first<{ id: string }>();
  if (!row) throw new Error("fixture continuation missing");
  const leaseId = `lease-${row.id}`;
  await db
    .prepare(
      "UPDATE jobs SET status='leased',lease_id=?,lease_expires_at=?,fence=1 WHERE user_id=? AND id=?",
    )
    .bind(leaseId, lease.expiresAt, tenant.userId, row.id)
    .run();
  return { ...lease, jobId: row.id, leaseId };
}
it("CLEF-01 two documents in one email receive independent classifier results across durable sibling jobs", async () => {
  const content = twoParts();
  await sourceDocuments(content);
  const { pipeline, run, extract } = service(0.9, policy, content);
  let current = lease;
  for (let index = 0; index < 6; index++) {
    expect(await pipeline.run(current, control)).toEqual({ kind: "completed" });
    if (index < 5) current = await continueLease();
  }
  expect(run).toHaveBeenCalledTimes(2);
  expect(extract).toHaveBeenCalledTimes(2);
});
it("CLEF-01 a changed sibling document cannot reuse a previous classification or silently disappear", async () => {
  const content = twoParts();
  await sourceDocuments(content);
  const { pipeline, run, extract } = service(0.9, policy, content);
  expect(await pipeline.run(lease, control)).toEqual({ kind: "completed" });
  const attachment = content.root.children?.[1];
  if (!attachment) throw new Error("fixture sibling missing");
  Object.assign(attachment, {
    bytes: new TextEncoder().encode("Changed synthetic receipt"),
  });
  expect(await pipeline.run(await continueLease(), control)).toEqual({
    kind: "completed",
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(extract).not.toHaveBeenCalled();
  expect(
    await db
      .prepare("SELECT parse_code FROM documents WHERE user_id=? AND id='d'")
      .bind(tenant.userId)
      .first("parse_code"),
  ).toBe("source-changed");
});
it("CLEF-01 unreadable attachment prevents a negative body decision from discarding the source", async () => {
  const content = twoParts(true);
  await sourceDocuments(content);
  const { pipeline, run, extract } = service(0.01, policy, content);
  expect(await pipeline.run(lease, control)).toEqual({ kind: "completed" });
  expect(run).toHaveBeenCalledTimes(1);
  expect(extract).not.toHaveBeenCalled();
  expect(
    await db
      .prepare(
        "SELECT processing_status FROM source_messages WHERE user_id=? AND id='s'",
      )
      .bind(tenant.userId)
      .first("processing_status"),
  ).toBe("review");
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND status='ready'",
      )
      .bind(tenant.userId)
      .first("n"),
  ).toBe(1);
});
it("CLEF-01 Clef category reaches a persisted purchase and reprocessing preserves the owner's manual category", async () => {
  const text =
    "Merchant: Synthetic Software\nInvoice date: 2026-10-13\nCurrency: EUR\nTotal: 15.00 EUR\nUnpaid invoice\nInvoice number: SYN-1";
  const content: DocumentInput = {
    connectionId: "c",
    providerMessageId: "m",
    root: {
      partId: "body",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode(text),
    },
  };
  await sourceDocuments(content);
  const financial = {
    schemaVersion: 1,
    documentType: "invoice",
    warnings: [],
    records: [
      {
        merchant: "Synthetic Software",
        documentDate: "2026-10-13",
        eventDate: null,
        currency: "EUR",
        total: "15.00",
        tax: null,
        invoiceNumber: "SYN-1",
        orderReference: null,
        paymentReference: null,
        refundReference: null,
        category: "shopping",
        paymentEvidence: "explicitly-unpaid",
        refundEvidence: "none",
        paymentMethodHint: "unknown",
        recurringCadence: "unknown",
        paymentAmount: null,
        refundAmount: null,
        storeCreditAmount: null,
        evidence: [
          { field: "merchant", quote: "Synthetic Software" },
          { field: "documentDate", quote: "Invoice date: 2026-10-13" },
          { field: "currency", quote: "Currency: EUR" },
          { field: "total", quote: "Total: 15.00 EUR" },
          { field: "invoiceNumber", quote: "Invoice number: SYN-1" },
          { field: "payment", quote: "Unpaid invoice" },
        ].map((item) => ({ ...item, inputPartId: "part-0" })),
      },
    ],
  };
  const { validateExtraction } = await import("@invoxim/core");
  expect(
    validateExtraction(
      JSON.stringify(financial),
      [{ id: "part-0", text }],
      4096,
    ).status,
  ).toBe("accepted");
  const { pipeline, run, extract } = service(0.9, policy, content);
  extract.mockResolvedValue({
    status: "ok",
    output: JSON.stringify(financial),
    finish: "complete",
    usage: { input: 20, output: 1, other: 0, source: "reported" },
  });
  let current = lease;
  for (let index = 0; index < 3; index++) {
    expect(await pipeline.run(current, control)).toEqual({ kind: "completed" });
    if (index < 2) current = await continueLease();
  }
  const purchase = await db
    .prepare("SELECT id,category FROM purchases WHERE user_id=?")
    .bind(tenant.userId)
    .first<{ id: string; category: string }>();
  expect(purchase?.category).toBe("software");
  if (!purchase) throw new Error("persisted purchase missing");
  await db
    .prepare(
      "INSERT INTO field_overrides(user_id,entity_kind,entity_id,field,original_value_json,value_json,revision) VALUES(?,'purchase',?,'category','\"software\"','\"home\"',1)",
    )
    .bind(tenant.userId, purchase.id)
    .run();
  await db
    .prepare("UPDATE purchases SET category='home' WHERE user_id=? AND id=?")
    .bind(tenant.userId, purchase.id)
    .run();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,lease_id,lease_expires_at,fence) VALUES('reprocess',?,'c','consent',1,'reprocess','clef-reprocess','leased',?,'reprocess',?,1)",
    )
    .bind(tenant.userId, Date.now(), lease.expiresAt)
    .run();
  await db
    .prepare(
      "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id,pipeline_stage) VALUES(?,'reprocess','s','infer')",
    )
    .bind(tenant.userId)
    .run();
  current = {
    ...lease,
    jobId: "reprocess",
    leaseId: "reprocess",
    type: "reprocess",
  };
  for (let index = 0; index < 3; index++) {
    expect(await pipeline.run(current, control)).toEqual({ kind: "completed" });
    if (index < 2) current = { ...(await continueLease()), type: "reprocess" };
  }
  expect(
    await db
      .prepare("SELECT category FROM purchases WHERE user_id=? AND id=?")
      .bind(tenant.userId, purchase.id)
      .first("category"),
  ).toBe("home");
  expect(run).toHaveBeenCalledTimes(1);
  expect(extract).toHaveBeenCalledTimes(1);
});
it("CLEF-01 classifier authorization cannot substitute consent, revision, mode or provider model", async () => {
  const { createClassificationUsageStore } =
    await import("../../../packages/adapters/src/ai/budget");
  const repository = createPipelineRepository(db, {
    processingDigest: async () => "f".repeat(64),
  });
  const work = await repository.load(lease);
  if (!work) throw new Error("fixture work missing");
  const selected = {
    config,
    extractor: { extract: vi.fn() },
    pricing: new Map([[config.fingerprint, price]]),
  };
  const classifier = await createReceiptClassifierFactory(db, classification, {
    binding: { run: vi.fn() },
  }).open(lease, work, [], selected);
  const identity = {
    documentId: "d",
    contentHash: work.documents[0]?.contentHash ?? "",
    extractionVersion: "email-classification-v1",
  };
  for (const mutation of [
    {
      config: classifier.config,
      authorization: {
        ...classifier.authorization,
        config: { ...config, settingsRevision: 2 },
      },
    },
    {
      config: classifier.config,
      authorization: {
        ...classifier.authorization,
        config: { ...config, consentId: "wrong-consent" },
      },
    },
    {
      config: { ...classifier.config, mode: "byok" as const },
      authorization: classifier.authorization,
    },
    {
      config: { ...classifier.config, modelId: "unreviewed" },
      authorization: classifier.authorization,
    },
  ]) {
    const store = createClassificationUsageStore(db, {
      lease,
      policy,
      pricing: classifier.pricing,
      authorization: mutation.authorization,
    });
    expect(
      await store.checkpoint({ tenant, identity, config: mutation.config }),
    ).toEqual({ status: "stale" });
  }
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
});
for (const pauseAfter of [
  "classifier",
  "financial",
  "financial-policy-change",
  "classifier-uncertain",
  "classifier-malformed",
  "classifier-overrun",
] as const) {
  it(`CLEF-01 consent renewal resumes after ${pauseAfter} cache without repeating paid calls`, async () => {
    const {
      onboardingConfigurationDigest,
      LOCAL_PARSER_POLICY,
      RECEIPT_CLASSIFIER_NOTICE,
    } = await import("../../../packages/adapters/src/onboarding/configuration");
    const { createJobStore } =
      await import("../../../packages/adapters/src/jobs/store");
    const digest = await onboardingConfigurationDigest({
      mode: "hosted",
      settingsRevision: 1,
      aiConfigurationDigest: price.configurationDigest,
      parser: LOCAL_PARSER_POLICY,
      classification,
      classificationNotice: RECEIPT_CLASSIFIER_NOTICE,
    });
    price = { ...price, acceptedConfigurationDigest: digest };
    expectedDigest = digest;
    await db
      .prepare(
        "UPDATE processing_consents SET accepted_configuration_digest=? WHERE user_id=?",
      )
      .bind(digest, tenant.userId)
      .run();
    const { pipeline, run, extract } = service(0.9);
    expect(await pipeline.run(lease, control)).toEqual({ kind: "completed" });
    if (pauseAfter.startsWith("financial"))
      expect(await pipeline.run(await continueLease(), control)).toEqual({
        kind: "completed",
      });
    const oldLease = await continueLease();
    let currentClassification = classification;
    let currentDigest = digest;
    if (pauseAfter === "financial-policy-change") {
      currentClassification = { ...classification, version: "clef-v2" };
      currentDigest = await onboardingConfigurationDigest({
        mode: "hosted",
        settingsRevision: 1,
        aiConfigurationDigest: price.configurationDigest,
        parser: LOCAL_PARSER_POLICY,
        classification: currentClassification,
        classificationNotice: RECEIPT_CLASSIFIER_NOTICE,
      });
      expectedDigest = currentDigest;
    }
    if (pauseAfter === "classifier-uncertain") {
      await db
        .prepare(
          "UPDATE ai_extractions SET result_json=NULL,completed_at=NULL WHERE user_id=? AND extraction_version='email-classification-v1'",
        )
        .bind(tenant.userId)
        .run();
      await db
        .prepare(
          "UPDATE usage_events SET state='uncertain' WHERE user_id=? AND destination_id='cloudflare-clef'",
        )
        .bind(tenant.userId)
        .run();
    }
    if (pauseAfter === "classifier-malformed")
      await db
        .prepare(
          'UPDATE ai_extractions SET result_json=\'{"status":"classified","isReceipt":true,"unknown":"software"}\' WHERE user_id=? AND extraction_version=\'email-classification-v1\'',
        )
        .bind(tenant.userId)
        .run();
    if (pauseAfter === "classifier-overrun")
      await db
        .prepare(
          "UPDATE usage_events SET state='overrun' WHERE user_id=? AND destination_id='cloudflare-clef'",
        )
        .bind(tenant.userId)
        .run();
    const at = Date.now();
    await db
      .prepare(
        "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized,accepted_configuration_digest) VALUES('renewed',?,'c',1,'abacus','local',1,?,1,?)",
      )
      .bind(tenant.userId, at, currentDigest)
      .run();
    await db
      .prepare(
        "UPDATE processing_consents SET revoked_at=? WHERE user_id=? AND id='consent'",
      )
      .bind(at, tenant.userId)
      .run();
    await db
      .prepare(
        "INSERT INTO import_runs(id,user_id,connection_id,consent_id,connection_generation,frozen_start,frozen_cutoff,timezone,request_fingerprint,started_at,onboarding_interval_key) VALUES('renewed-run',?,'c','renewed',1,'2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z','UTC','renewed-request',?,?)",
      )
      .bind(tenant.userId, at, "d".repeat(64))
      .run();
    await db
      .prepare(
        "INSERT INTO discovery_run_sources(user_id,import_run_id,source_message_id,candidate_kind) VALUES(?,'renewed-run','s','matched')",
      )
      .bind(tenant.userId)
      .run();
    await db
      .prepare("UPDATE jobs SET status='paused_auth' WHERE user_id=? AND id=?")
      .bind(tenant.userId, oldLease.jobId)
      .run();
    expect(await pipeline.run(oldLease, control)).toEqual({
      kind: "paused",
      code: "auth",
    });
    const jobPolicy = {
      dispatchLimit: 5,
      scheduleLimit: 5,
      tenantConcurrency: 1,
      globalConcurrency: 1,
      maxAttempts: 3,
      leaseMs: 300000,
      redeliveryMs: 300000,
    };
    const recoveryOptions = {
      policy: jobPolicy,
      classification: currentClassification,
      processingReview: async (selection: { acceptedDigest: string | null }) =>
        selection.acceptedDigest === currentDigest ? currentDigest : null,
    };
    for (let tick = 0; tick < 8; tick++) {
      const meter = createInvocationDatabase(db, 40);
      await createJobStore(meter.db, recoveryOptions).recover();
      expect(meter.executedStatements()).toBeLessThanOrEqual(40);
    }
    if (
      pauseAfter === "financial-policy-change" ||
      pauseAfter.startsWith("classifier-")
    ) {
      expect(
        await db
          .prepare(
            "SELECT status,consent_id,outcome_code FROM jobs WHERE user_id=? AND id=?",
          )
          .bind(tenant.userId, oldLease.jobId)
          .first(),
      ).toEqual({
        status: "paused_auth",
        consent_id: "renewed",
        outcome_code: "cache-review-required",
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(extract).toHaveBeenCalledTimes(
        pauseAfter === "financial-policy-change" ? 1 : 0,
      );
      expect(
        await db
          .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE user_id=?")
          .bind(tenant.userId)
          .first("n"),
      ).toBe(pauseAfter === "financial-policy-change" ? 2 : 1);
      return;
    }
    expect(
      await db
        .prepare(
          "SELECT status,consent_id,outcome_code FROM jobs WHERE user_id=? AND id=?",
        )
        .bind(tenant.userId, oldLease.jobId)
        .first(),
    ).toEqual({ status: "ready", consent_id: "renewed", outcome_code: null });
    expect(await pipeline.run(oldLease, control)).toEqual({
      kind: "paused",
      code: "auth",
    });
    config = {
      ...config,
      consentId: "renewed",
      fingerprint: await computeAiFingerprint({
        mode: "hosted",
        configurationDigest: price.configurationDigest,
        settingsRevision: 1,
        generation: 1,
        credentialVersion: 0,
        policyVersion: 1,
        consentId: "renewed",
      }),
    };
    const current = await createJobStore(db, recoveryOptions).claim(
      oldLease.jobId,
    );
    if (!current) throw new Error("recovered lease missing");
    expect(await pipeline.run(current, control)).toEqual({ kind: "completed" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM usage_events WHERE user_id=? AND destination_id='cloudflare-clef'",
        )
        .bind(tenant.userId)
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM usage_events WHERE user_id=? AND destination_id='abacus'",
        )
        .bind(tenant.userId)
        .first("n"),
    ).toBe(1);
  });
}
it("DATE-01 multipart plain boilerplate plus complete HTML euro invoice becomes exactly one purchase", async () => {
  const content: DocumentInput = {
    connectionId: "c",
    providerMessageId: "m",
    root: {
      partId: "",
      mimeType: "multipart/alternative",
      children: [
        {
          partId: "plain",
          mimeType: "text/plain",
          bytes: new TextEncoder().encode("View your receipt online."),
        },
        {
          partId: "html",
          mimeType: "text/html",
          bytes: new TextEncoder().encode(
            "<p>Synthetic Store</p><p>Invoice date: October 13, 2026</p><p>Total €15.00</p><p>Unpaid invoice</p>",
          ),
        },
      ],
    },
  };
  await sourceDocuments(content);
  const { pipeline, run, extract } = service(0.9, policy, content);
  const financial = {
    schemaVersion: 1,
    documentType: "invoice",
    warnings: [],
    records: [
      {
        merchant: "Synthetic Store",
        documentDate: "2026-10-13",
        eventDate: null,
        currency: "EUR",
        total: "15.00",
        tax: null,
        invoiceNumber: null,
        orderReference: null,
        paymentReference: null,
        refundReference: null,
        category: "shopping",
        paymentEvidence: "explicitly-unpaid",
        refundEvidence: "none",
        paymentMethodHint: "unknown",
        recurringCadence: "unknown",
        paymentAmount: null,
        refundAmount: null,
        storeCreditAmount: null,
        evidence: [
          { field: "merchant", quote: "Synthetic Store" },
          { field: "documentDate", quote: "October 13, 2026" },
          { field: "currency", quote: "€" },
          { field: "total", quote: "Total €15.00" },
          { field: "payment", quote: "Unpaid invoice" },
        ].map((item) => ({ ...item, inputPartId: "part-0" })),
      },
    ],
  };
  extract.mockImplementation(async (...args: unknown[]) => {
    const parts = args[0] as { id: string; text: string }[];
    expect(parts).toHaveLength(1);
    expect(parts[0]?.text).toContain("October 13, 2026");
    expect(parts[0]?.text).toContain("Total €15.00");
    expect(parts[0]?.text).not.toContain("View your receipt online");
    return {
      status: "ok",
      output: JSON.stringify(financial),
      finish: "complete",
      usage: { input: 20, output: 1, other: 0, source: "reported" },
    };
  });
  let current = lease;
  for (let stage = 0; stage < 3; stage++) {
    expect(await pipeline.run(current, control)).toEqual({ kind: "completed" });
    if (stage < 2) current = await continueLease();
  }
  expect(run).toHaveBeenCalledTimes(1);
  expect(extract).toHaveBeenCalledTimes(1);
  expect(
    await db
      .prepare(
        "SELECT category,currency,total_minor,document_date FROM purchases WHERE user_id=?",
      )
      .bind(tenant.userId)
      .all(),
  ).toMatchObject({
    results: [
      {
        category: "software",
        currency: "EUR",
        total_minor: 1500,
        document_date: "2026-10-13",
      },
    ],
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
});
async function interruptedFinancial(
  version: string,
  unfinished = false,
  paidReceipt?: { content: DocumentInput; output: string },
) {
  const { hashJsonValue } =
    await import("../../../packages/adapters/src/hash");
  config = {
    ...config,
    promptVersion: version,
    fingerprint: await hashJsonValue([
      config.mode,
      price.configurationDigest,
      1,
      1,
      0,
      1,
      "consent",
      version,
      1,
    ]),
  };
  if (paidReceipt) await sourceDocuments(paidReceipt.content);
  const selected = service(0.9, policy, paidReceipt?.content ?? input);
  if (paidReceipt)
    selected.extract.mockResolvedValue({
      status: "ok",
      output: paidReceipt.output,
      finish: "complete",
      usage: { input: 20, output: 1, other: 0, source: "reported" },
    });
  expect(await selected.pipeline.run(lease, control)).toEqual({
    kind: "completed",
  });
  const paidLease = await continueLease();
  expect(await selected.pipeline.run(paidLease, control)).toEqual({
    kind: "completed",
  });
  if (paidReceipt)
    expect(await selected.pipeline.run(await continueLease(), control)).toEqual(
      { kind: "completed" },
    );
  await db
    .prepare("DELETE FROM jobs WHERE user_id=? AND status='ready'")
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "UPDATE jobs SET status='leased',lease_id='interrupted',lease_expires_at=?,fence=fence+1 WHERE user_id=? AND id=?",
    )
    .bind(lease.expiresAt, tenant.userId, paidLease.jobId)
    .run();
  if (unfinished) {
    await db
      .prepare(
        "UPDATE ai_extractions SET result_json=NULL,completed_at=NULL WHERE user_id=? AND destination_id='abacus'",
      )
      .bind(tenant.userId)
      .run();
    await db
      .prepare(
        "UPDATE usage_events SET state='sent' WHERE user_id=? AND destination_id='abacus'",
      )
      .bind(tenant.userId)
      .run();
  }
  return {
    ...selected,
    current: {
      ...paidLease,
      leaseId: "interrupted",
      fence: paidLease.fence + 1,
    },
  };
}
it("VERSION-01 completed paid v3 extraction is reused after v4 repair without duplicate model calls", async () => {
  const { pipeline, run, extract, current } = await interruptedFinancial(
    "invoice-extraction-v3",
  );
  config = {
    ...config,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    fingerprint: await computeAiFingerprint({
      mode: "hosted",
      configurationDigest: price.configurationDigest,
      settingsRevision: 1,
      generation: 1,
      credentialVersion: 0,
      policyVersion: 1,
      consentId: "consent",
    }),
  };
  expect(await pipeline.run(current, control)).toEqual({ kind: "completed" });
  expect(await pipeline.run(await continueLease(), control)).toEqual({
    kind: "completed",
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(extract).toHaveBeenCalledTimes(1);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM usage_events WHERE user_id=? AND destination_id='abacus'",
      )
      .bind(tenant.userId)
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
});
it("VERSION-02 sent unfinished v3 attempt remains visible and cannot be charged again by v4", async () => {
  const { pipeline, run, extract, current } = await interruptedFinancial(
    "invoice-extraction-v3",
    true,
  );
  config = {
    ...config,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    fingerprint: await computeAiFingerprint({
      mode: "hosted",
      configurationDigest: price.configurationDigest,
      settingsRevision: 1,
      generation: 1,
      credentialVersion: 0,
      policyVersion: 1,
      consentId: "consent",
    }),
  };
  expect(await pipeline.run(current, control)).toEqual({ kind: "completed" });
  expect(run).toHaveBeenCalledTimes(1);
  expect(extract).toHaveBeenCalledTimes(1);
  expect(
    await db
      .prepare("SELECT parse_code FROM documents WHERE user_id=? AND id='d'")
      .bind(tenant.userId)
      .first("parse_code"),
  ).toBe("cache-review-required");
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM usage_events WHERE user_id=? AND destination_id='abacus'",
      )
      .bind(tenant.userId)
      .first("n"),
  ).toBe(1);
});
it("VERSION-03 incompatible paid v3 configuration is held without a new provider request", async () => {
  const { pipeline, run, extract, current } = await interruptedFinancial(
    "invoice-extraction-v3",
  );
  price = { ...price, configurationDigest: "b".repeat(64) };
  config = {
    ...config,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    fingerprint: await computeAiFingerprint({
      mode: "hosted",
      configurationDigest: price.configurationDigest,
      settingsRevision: 1,
      generation: 1,
      credentialVersion: 0,
      policyVersion: 1,
      consentId: "consent",
    }),
  };
  expect(await pipeline.run(current, control)).toEqual({ kind: "completed" });
  expect(run).toHaveBeenCalledTimes(1);
  expect(extract).toHaveBeenCalledTimes(1);
  expect(
    await db
      .prepare("SELECT parse_code FROM documents WHERE user_id=? AND id='d'")
      .bind(tenant.userId)
      .first("parse_code"),
  ).toBe("cache-review-required");
});
it("VERSION-04 current v4 paid cache still replays without an extra model request", async () => {
  const { pipeline, run, extract, current } = await interruptedFinancial(
    EXTRACTION_PROMPT_VERSION,
  );
  expect(await pipeline.run(current, control)).toEqual({ kind: "completed" });
  expect(run).toHaveBeenCalledTimes(1);
  expect(extract).toHaveBeenCalledTimes(1);
});
it("VERSION-05 already reconciled paid v3 receipt cannot create a duplicate purchase or payment under v4", async () => {
  const text =
    "Synthetic Store\nReceipt 2026-10-13\nTotal EUR 15.00\nPaid EUR 15.00 by card.";
  const content: DocumentInput = {
    connectionId: "c",
    providerMessageId: "m",
    root: {
      partId: "body",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode(text),
    },
  };
  const output = JSON.stringify({
    schemaVersion: 1,
    documentType: "receipt",
    warnings: [],
    records: [
      {
        merchant: "Synthetic Store",
        documentDate: "2026-10-13",
        eventDate: "2026-10-13",
        currency: "EUR",
        total: "15.00",
        tax: null,
        invoiceNumber: null,
        orderReference: null,
        paymentReference: null,
        refundReference: null,
        category: "shopping",
        paymentEvidence: "explicitly-paid",
        refundEvidence: "none",
        paymentMethodHint: "card",
        recurringCadence: "unknown",
        paymentAmount: "15.00",
        refundAmount: null,
        storeCreditAmount: null,
        evidence: [
          { field: "merchant", quote: "Synthetic Store" },
          { field: "documentDate", quote: "2026-10-13" },
          { field: "eventDate", quote: "2026-10-13" },
          { field: "currency", quote: "EUR" },
          { field: "total", quote: "Total EUR 15.00" },
          { field: "payment", quote: "Paid EUR 15.00 by card." },
          { field: "paymentAmount", quote: "Paid EUR 15.00 by card." },
        ].map((item) => ({ ...item, inputPartId: "part-0" })),
      },
    ],
  });
  const { validateExtraction } = await import("@invoxim/core");
  expect(
    validateExtraction(output, [{ id: "part-0", text }], 4096).status,
  ).toBe("accepted");
  const { pipeline, run, extract, current } = await interruptedFinancial(
    "invoice-extraction-v3",
    false,
    { content, output },
  );
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM purchases WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(1);
  config = {
    ...config,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    fingerprint: await computeAiFingerprint({
      mode: "hosted",
      configurationDigest: price.configurationDigest,
      settingsRevision: 1,
      generation: 1,
      credentialVersion: 0,
      policyVersion: 1,
      consentId: "consent",
    }),
  };
  expect(await pipeline.run(current, control)).toEqual({ kind: "completed" });
  expect(
    await db
      .prepare("SELECT outcome_code FROM jobs WHERE user_id=? AND id=?")
      .bind(tenant.userId, current.jobId)
      .first("outcome_code"),
  ).toBe("pipeline_staged");
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND status='ready'",
      )
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
  expect(run).toHaveBeenCalledTimes(1);
  expect(extract).toHaveBeenCalledTimes(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM purchases WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT amount_minor,currency FROM ledger_entries WHERE user_id=?",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual({ amount_minor: 1500, currency: "EUR" });
});

it("AI-CLEF-PRECISION-01 uncertain classification is metered and never invokes financial extraction", async () => {
  const { pipeline, run, extract } = service(0.45);
  expect(await pipeline.run(lease, control)).toEqual({ kind: "completed" });
  expect(run).toHaveBeenCalledTimes(1);
  expect(extract).not.toHaveBeenCalled();
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM purchases WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT parse_code FROM documents WHERE user_id=? AND id='d'")
      .bind(tenant.userId)
      .first("parse_code"),
  ).toBe("classification-uncertain");
  expect(
    await db
      .prepare(
        "SELECT state FROM usage_events WHERE user_id=? AND destination_id='cloudflare-clef'",
      )
      .bind(tenant.userId)
      .first("state"),
  ).toBe("known");
});
it("AI-CLEF-PRECISION-01 policy identity invalidates custom configuration cache fingerprints", async () => {
  const { hashJsonValue } =
    await import("../../../packages/adapters/src/hash");
  const { CLEF_RECEIPT_POLICY_VERSION } =
    await import("../../../packages/adapters/src/ai/clef");
  const repository = createPipelineRepository(db, {
    processingDigest: async () => "f".repeat(64),
  });
  const work = await repository.load(lease);
  if (!work) throw new Error("fixture work missing");
  const selected = {
    config,
    extractor: { extract: vi.fn() },
    pricing: new Map([[config.fingerprint, price]]),
  };
  const classifier = await createReceiptClassifierFactory(db, classification, {
    binding: { run: vi.fn() },
  }).open(lease, work, [], selected);
  const sourceDocuments = work.documents.map((document) => ({
    partKey: document.partKey,
    contentHash: document.contentHash,
    parserVersion: document.parserVersion,
  }));
  const previousDigest = await hashJsonValue({
    classification,
    sourceDocuments,
  });
  const currentDigest = await hashJsonValue({
    classification,
    classifierPolicyVersion: CLEF_RECEIPT_POLICY_VERSION,
    sourceDocuments,
  });
  const currentPrice = classifier.pricing.get(classifier.config.fingerprint);
  expect(currentPrice?.configurationDigest).toBe(currentDigest);
  expect(currentPrice?.configurationDigest).not.toBe(previousDigest);
  expect(classifier.config.promptVersion).toBe("email-classification-v1");
});

async function resumeSynthetic(
  pipeline: ReturnType<typeof service>["pipeline"],
) {
  const next = await db
    .prepare("SELECT id FROM jobs WHERE user_id=? AND status='ready'")
    .bind(tenant.userId)
    .first<string>("id");
  if (!next) throw new Error("continuation missing");
  await db
    .prepare(
      "UPDATE jobs SET status='leased',lease_id='next',lease_expires_at=?,fence=CASE WHEN fence=0 THEN 1 ELSE fence END WHERE user_id=? AND id=?",
    )
    .bind(lease.expiresAt, tenant.userId, next)
    .run();
  return pipeline.run({ ...lease, jobId: next, leaseId: "next" }, control);
}
it("CLEF-UNCERTAIN valid uncertainty uses one normal metered selected extraction after durable continuation", async () => {
  const { pipeline, run, extract, counts } = service(
    0.45,
    policy,
    input,
    undefined,
    "extract",
  );
  expect(await pipeline.run(lease, control)).toEqual({ kind: "completed" });
  expect(extract).not.toHaveBeenCalled();
  expect(await resumeSynthetic(pipeline)).toEqual({ kind: "completed" });
  expect(run).toHaveBeenCalledTimes(1);
  expect(extract).toHaveBeenCalledTimes(1);
  expect(counts.every((count) => count <= 40)).toBe(true);
  const events = await db
    .prepare(
      "SELECT destination_id,state FROM usage_events WHERE user_id=? ORDER BY destination_id",
    )
    .bind(tenant.userId)
    .all();
  expect(events.results).toEqual([
    { destination_id: "abacus", state: "known" },
    { destination_id: "cloudflare-clef", state: "known" },
  ]);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM purchases WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
});
it.each(["schema", "outage"])(
  "CLEF-UNCERTAIN %s never escalates even when enabled",
  async (reason) => {
    const override = () => {
      if (reason === "outage") throw new Error("synthetic outage");
      return {};
    };
    const { pipeline, extract } = service(
      0.45,
      policy,
      input,
      override,
      "extract",
    );
    expect(await pipeline.run(lease, control)).toEqual({ kind: "completed" });
    expect(extract).not.toHaveBeenCalled();
  },
);

it.each([
  { probability: 0.45, stage: "infer" },
  { probability: 0.99, stage: "infer" },
  { probability: 0.45, stage: "reconcile" },
])(
  "CLEF-VERIFY %j cached accepted order cannot bypass financial verification or charge again",
  async ({ probability, stage }) => {
    const { aiRunIdentityKey } = await import("@invoxim/core");
    const { pipeline, run, extract } = service(
      probability,
      policy,
      input,
      undefined,
      "extract",
    );
    expect(await pipeline.run(lease, control)).toEqual({ kind: "completed" });
    const document = await db
      .prepare("SELECT content_hash FROM documents WHERE user_id=? AND id='d'")
      .bind(tenant.userId)
      .first<{ content_hash: string }>();
    if (!document) throw new Error("document missing");
    const key = await aiRunIdentityKey({
      tenant,
      identity: {
        documentId: "d",
        contentHash: document.content_hash,
        extractionVersion: config.promptVersion,
      },
      config,
    });
    const cached = {
      status: "accepted",
      documentType: "order-confirmation",
      warnings: [],
      records: [
        {
          merchant: "Synthetic Store",
          documentDate: "2026-10-13",
          eventDate: null,
          currency: "EUR",
          total: "15.00",
          tax: null,
          invoiceNumber: null,
          orderReference: "ORDER-SYN",
          paymentReference: null,
          refundReference: null,
          category: "shopping",
          paymentEvidence: "unknown",
          refundEvidence: "none",
          paymentMethodHint: "unknown",
          recurringCadence: "unknown",
          paymentAmount: null,
          refundAmount: null,
          storeCreditAmount: null,
          provenance: [],
        },
      ],
    };
    await db
      .prepare(
        "INSERT INTO ai_extractions(user_id,run_key,purpose,document_id,content_hash,extraction_version,config_fingerprint,mode,destination_id,model_id,config_version,settings_revision,generation,credential_version,reservation_nonce,result_json,completed_at,created_at) VALUES(?,?,'extraction','d',?,?,?,'hosted','abacus','financial','v1',1,1,0,'synthetic-cache',?,1,0)",
      )
      .bind(
        tenant.userId,
        key,
        document.content_hash,
        config.promptVersion,
        config.fingerprint,
        JSON.stringify(cached),
      )
      .run();
    if (stage === "reconcile")
      await db
        .prepare(
          "UPDATE discovery_source_jobs SET pipeline_stage='reconcile',extraction_fingerprint=? WHERE user_id=? AND job_id IN (SELECT id FROM jobs WHERE user_id=? AND status='ready')",
        )
        .bind(key, tenant.userId, tenant.userId)
        .run();
    expect(await resumeSynthetic(pipeline)).toEqual({ kind: "completed" });
    expect(extract).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM purchases WHERE user_id=?")
        .bind(tenant.userId)
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM ledger_entries WHERE user_id=?")
        .bind(tenant.userId)
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT parse_code FROM documents WHERE user_id=? AND id='d'")
        .bind(tenant.userId)
        .first("parse_code"),
    ).toBe("classification-verification");
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM usage_events WHERE user_id=?")
        .bind(tenant.userId)
        .first("n"),
    ).toBe(1);
  },
);
it.each(["consent", "lease", "settings"])(
  "CLEF-UNCERTAIN %s fencing blocks selected financial request after classification",
  async (fence) => {
    const { pipeline, run, extract } = service(
      0.45,
      policy,
      input,
      undefined,
      "extract",
    );
    expect(await pipeline.run(lease, control)).toEqual({ kind: "completed" });
    if (fence === "consent")
      await db
        .prepare("UPDATE processing_consents SET revoked_at=1 WHERE user_id=?")
        .bind(tenant.userId)
        .run();
    if (fence === "settings")
      await db
        .prepare("UPDATE ai_settings SET status='deleted' WHERE user_id=?")
        .bind(tenant.userId)
        .run();
    if (fence === "lease")
      await db
        .prepare("UPDATE jobs SET fence=9 WHERE user_id=?")
        .bind(tenant.userId)
        .run();
    expect(await resumeSynthetic(pipeline)).toEqual({
      kind: "paused",
      code: "auth",
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(extract).not.toHaveBeenCalled();
  },
);
it("CLEF-UNCERTAIN exhausted shared allowance after classification prevents financial call", async () => {
  const { pipeline, extract } = service(
    0.45,
    policy,
    input,
    undefined,
    "extract",
  );
  expect(await pipeline.run(lease, control)).toEqual({ kind: "completed" });
  await db
    .prepare(
      "UPDATE usage_buckets SET blocked=1 WHERE scope='tenant' AND user_id=?",
    )
    .bind(tenant.userId)
    .run();
  expect(await resumeSynthetic(pipeline)).toEqual({
    kind: "paused",
    code: "budget",
  });
  expect(extract).not.toHaveBeenCalled();
});
