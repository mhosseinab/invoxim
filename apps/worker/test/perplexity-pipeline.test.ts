import { env } from "cloudflare:workers";
import { EXTRACTION_PROMPT_VERSION } from "@invoxim/contracts";
import {
  type ApprovedAiConfig,
  createDocumentTextExtractor,
  type JobLease,
  type TenantContext,
} from "@invoxim/core";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import initial from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import type { AiPriceSnapshot } from "../../../packages/adapters/src/ai/budget";
import type { ReceiptClassificationConfiguration } from "../../../packages/adapters/src/ai/classification-config";
import { createReceiptClassifierFactory } from "../../../packages/adapters/src/ai/classifier-factory";
import { computeAiFingerprint } from "../../../packages/adapters/src/ai/configuration";
import { PERPLEXITY_DECISIONS_ENDPOINT } from "../../../packages/adapters/src/ai/perplexity-decider";
import { createPipelineRepository } from "../../../packages/adapters/src/pipeline/repository";
import { createPipelineService } from "../../../packages/adapters/src/pipeline/service";
import { createInvocationDatabase } from "../src/invocation-database";
import { createPipelineRuntime } from "../src/pipeline-runtime";

/** AI-CLASSIFIER-PROVIDER: Perplexity classification through the real pipeline; fetch is mocked. */

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
  provider: "perplexity-decider",
  model: "pplx-decider-v1.1-27b",
  version: "synthetic-perplexity-v1",
  maxInputBytes: 24000,
  timeoutMs: 1000,
  negativeThreshold: 0.1,
  categoryThreshold: 0.5,
  pricing: {
    version: "synthetic-perplexity-tariff-v1",
    approved: true,
    currency: "USD",
    source: "https://docs.perplexity.ai/docs/decisions/quickstart",
    checkedAt: "2026-10-15T00:00:00Z",
    inputUsdMicrosPerMillion: "20000",
    outputUsdMicrosPerMillion: "0",
    otherUsdMicrosPerMillion: "0",
  },
};
const tenant = {
  userId: "perplexity-owner",
  authority: "job",
} as TenantContext;
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
let expectedDigest = "f".repeat(64);
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
      "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Synthetic','perplexity@example.invalid',1,0,0)",
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
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state,credential_ciphertext,credential_key_version,credential_version) VALUES('c',?,'mailbox','gmail','subject','perplexity@example.invalid','active','synthetic',1,1)",
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
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,lease_id,lease_expires_at,fence) VALUES('job',?,'c','consent',1,'source-extract','perplexity-fixture','leased',?,'lease',?,1)",
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
const KEY = "synthetic-perplexity-key-not-real";
const clefClassification: ReceiptClassificationConfiguration = {
  enabled: true,
  model: "@cf/cloudflare/clef",
  version: "synthetic-perplexity-v1",
  maxInputBytes: 24000,
  timeoutMs: 1000,
  negativeThreshold: 0.1,
  categoryThreshold: 0.5,
  pricing: {
    ...classification.pricing,
    source: "https://developers.cloudflare.com/workers-ai/models/clef/",
    inputUsdMicrosPerMillion: "240000",
  },
};
const decision = (noul: number) => ({
  model: "pplx-decider-v1.1-27b",
  answers: {
    receipt: { type: "noul", noul },
    documentType: {
      type: "choice",
      choice: noul <= 0.1 ? "delivery" : "invoice",
      probabilities: { [noul <= 0.1 ? "delivery" : "invoice"]: 1 },
      confidence: 1,
    },
    category: {
      type: "choice",
      choice: "software",
      probabilities: { software: 0.9, uncategorized: 0.1 },
      confidence: 0.9,
    },
  },
  usage: { input_tokens: 1000, output_tokens: 0 },
});
function perplexityFetch(handler: () => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
    if (String(request) === PERPLEXITY_DECISIONS_ENDPOINT) return handler();
    throw new Error("unexpected synthetic destination");
  });
}
const control = {
  signal: new AbortController().signal,
  checkpoint: async () => true,
};
function service(
  sources: Parameters<typeof createReceiptClassifierFactory>[2],
  maxJobAttempts?: number,
) {
  const extract = vi.fn(async () => ({
    status: "ok" as const,
    output: "{}",
    finish: "complete" as const,
    usage: { input: 20, output: 1, other: 0, source: "reported" as const },
  }));
  const counts: number[] = [];
  const pipeline = {
    async run(current: JobLease) {
      const meter = createInvocationDatabase(db, 40);
      const handler = createPipelineService(meter.db, {
        repository: createPipelineRepository(meter.db, {
          processingDigest: async () => expectedDigest,
        }),
        documents,
        content: {
          open: async () => ({
            load: async () => ({ status: "ready", input }),
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
          classification,
          sources,
        ),
        ...(maxJobAttempts === undefined ? {} : { maxJobAttempts }),
        budget: policy,
        remainingStatements: () => 40 - meter.executedStatements(),
      });
      const result = await handler.run(current, control);
      counts.push(meter.executedStatements());
      return result;
    },
  };
  return { pipeline, extract, counts };
}
afterEach(() => {
  vi.restoreAllMocks();
});

it("AI-CLASSIFIER-PROVIDER Perplexity negative decision is metered under its own destination within forty statements", async () => {
  const fetch = perplexityFetch(() => Response.json(decision(0.02)));
  const clef = vi.fn();
  const { pipeline, extract, counts } = service({
    perplexityApiKey: KEY,
    binding: { run: clef },
  });
  expect(await pipeline.run(lease)).toEqual({ kind: "completed" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization"),
  ).toBe(`Bearer ${KEY}`);
  expect(clef).not.toHaveBeenCalled();
  expect(extract).not.toHaveBeenCalled();
  expect(Math.max(...counts)).toBeLessThanOrEqual(40);
  const events = await db
    .prepare(
      "SELECT destination_id,model_id,mode,state,actual_usd_micros FROM usage_events WHERE user_id=?",
    )
    .bind(tenant.userId)
    .all();
  // 1000 input tokens at 20000 USD micros per million = 20 micros; output is free.
  expect(events.results).toEqual([
    {
      destination_id: "perplexity-decider",
      model_id: "pplx-decider-v1.1-27b",
      mode: "hosted",
      state: "known",
      actual_usd_micros: "20",
    },
  ]);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM purchases WHERE user_id=?")
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT processing_status FROM source_messages WHERE user_id=? AND id='s'",
      )
      .bind(tenant.userId)
      .first("processing_status"),
  ).toBe("processed");
});

it("AI-CLASSIFIER-PROVIDER Perplexity positive decision continues to the selected financial extraction", async () => {
  perplexityFetch(() => Response.json(decision(0.97)));
  const { pipeline, extract, counts } = service({ perplexityApiKey: KEY });
  expect(await pipeline.run(lease)).toEqual({ kind: "completed" });
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
    await pipeline.run({ ...lease, jobId: next, leaseId: "next-lease" }),
  ).toEqual({ kind: "completed" });
  expect(extract).toHaveBeenCalledTimes(1);
  expect(Math.max(...counts)).toBeLessThanOrEqual(40);
});

it("AI-CLASSIFIER-PROVIDER Perplexity 429 reschedules the job after Retry-After without financial extraction", async () => {
  const fetch = perplexityFetch(
    () => new Response("", { status: 429, headers: { "Retry-After": "5" } }),
  );
  const { pipeline, extract } = service({ perplexityApiKey: KEY });
  expect(await pipeline.run(lease)).toEqual({
    kind: "retry",
    code: "transient",
    retryAfterMs: 5000,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(extract).not.toHaveBeenCalled();
});

it("AI-CLASSIFIER-PROVIDER missing key pauses before content and never uses the Clef binding", async () => {
  const { aiConfiguration } =
    await import("../../../packages/adapters/src/ai/configuration");
  const preset = (await import("../../../config/ai.abacus.production.json"))
    .default;
  const ai = aiConfiguration({
    AI_ENABLED: "true",
    AI_REGISTRY_JSON: JSON.stringify(preset.registry),
    AI_BUDGET_JSON: JSON.stringify(preset.budget),
    CREDENTIAL_KEYRING: JSON.stringify({
      activeVersion: 1,
      keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    }),
    AI_CLASSIFICATION_JSON: JSON.stringify(classification),
    PERPLEXITY_API_KEY: KEY,
  });
  if (!ai) throw new Error("synthetic configuration missing");
  const fetch = vi.spyOn(globalThis, "fetch");
  const run = vi.fn();
  const open = vi.fn(async () => {
    throw new Error("NO_CONTENT_ALLOWED");
  });
  for (const perplexityApiKey of [undefined, "", "  "]) {
    const runtime = createPipelineRuntime({
      db,
      content: { open },
      ai,
      classificationBinding: { run },
      perplexityApiKey,
      remainingStatements: () => 40,
    });
    expect(await runtime.run(lease, control)).toEqual({
      kind: "paused",
      code: "handler-unavailable",
    });
  }
  expect(open).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  // The factory itself also refuses to open without its own credential.
  const repository = createPipelineRepository(db, {
    processingDigest: async () => "f".repeat(64),
  });
  const work = await repository.load(lease);
  if (!work) throw new Error("fixture work missing");
  await expect(
    createReceiptClassifierFactory(db, classification, {
      binding: { run },
    }).open(lease, work, [], {
      config,
      extractor: { extract: vi.fn() },
      pricing: new Map([[config.fingerprint, price]]),
    }),
  ).rejects.toThrow();
});

it("AI-CLASSIFIER-PROVIDER switching provider changes destination identity, price snapshot digest and fingerprint", async () => {
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
  const pplx = await createReceiptClassifierFactory(db, classification, {
    perplexityApiKey: KEY,
  }).open(lease, work, [], selected);
  const clef = await createReceiptClassifierFactory(db, clefClassification, {
    binding: { run: vi.fn() },
  }).open(lease, work, [], selected);
  expect(pplx.config).toMatchObject({
    destinationId: "perplexity-decider",
    modelId: "pplx-decider-v1.1-27b",
    mode: "hosted",
  });
  expect(clef.config).toMatchObject({
    destinationId: "cloudflare-clef",
    modelId: "@cf/cloudflare/clef",
  });
  expect(pplx.config.fingerprint).not.toBe(clef.config.fingerprint);
  const pplxPrice = pplx.pricing.get(pplx.config.fingerprint);
  const clefPrice = clef.pricing.get(clef.config.fingerprint);
  expect(pplxPrice).toMatchObject({
    destinationId: "perplexity-decider",
    modelId: "pplx-decider-v1.1-27b",
    inputUsdMicrosPerMillion: "20000",
    outputUsdMicrosPerMillion: "0",
  });
  expect(pplxPrice?.configurationDigest).not.toBe(
    clefPrice?.configurationDigest,
  );
  const other = await createReceiptClassifierFactory(
    db,
    { ...classification, model: "pplx-decider-v1-27b" },
    { perplexityApiKey: KEY },
  ).open(lease, work, [], selected);
  expect(other.config.fingerprint).not.toBe(pplx.config.fingerprint);
});

async function classificationState() {
  const extraction = await db
    .prepare(
      "SELECT result_json FROM ai_extractions WHERE user_id=? AND purpose='extraction' AND extraction_version='email-classification-v1'",
    )
    .bind(tenant.userId)
    .all<{ result_json: string | null }>();
  const events = await db
    .prepare(
      "SELECT attempt_number,state,actual_usd_micros FROM usage_events WHERE user_id=? ORDER BY attempt_number",
    )
    .bind(tenant.userId)
    .all();
  const reserved = await db
    .prepare(
      "SELECT COALESCE(SUM(reserved_units),0) AS units,COALESCE(SUM(reserved_usd_micros),0) AS micros FROM usage_buckets WHERE user_id=? OR scope='global'",
    )
    .bind(tenant.userId)
    .first<{ units: number; micros: number }>();
  return { extraction: extraction.results, events: events.results, reserved };
}

it("AI-CLASSIFIER-PROVIDER 429 is not persisted, releases its reservation and retries after Retry-After", async () => {
  await db.prepare("DELETE FROM hosted_ai_cooldowns").run();
  let calls = 0;
  const fetch = perplexityFetch(() =>
    ++calls === 1
      ? new Response("", { status: 429, headers: { "Retry-After": "2" } })
      : Response.json(decision(0.02)),
  );
  const { pipeline, extract, counts } = service({ perplexityApiKey: KEY });
  expect(await pipeline.run(lease)).toEqual({
    kind: "retry",
    code: "transient",
    retryAfterMs: 2000,
  });
  const paused = await classificationState();
  expect(paused.extraction).toEqual([{ result_json: null }]);
  expect(paused.events).toEqual([
    { attempt_number: 1, state: "known", actual_usd_micros: "0" },
  ]);
  expect(paused.reserved).toEqual({ units: 0, micros: 0 });
  // Inside the Retry-After window nothing is sent; the job is rescheduled
  // for the remaining cooldown.
  const early = await pipeline.run(lease);
  expect(early).toMatchObject({ kind: "retry", code: "transient" });
  expect(fetch).toHaveBeenCalledTimes(1);
  const now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now + 5000);
  expect(await pipeline.run(lease)).toEqual({ kind: "completed" });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(extract).not.toHaveBeenCalled();
  expect(Math.max(...counts)).toBeLessThanOrEqual(40);
  const done = await classificationState();
  expect(done.extraction).toHaveLength(1);
  expect(JSON.parse(done.extraction[0]?.result_json ?? "null")).toEqual({
    status: "classified",
    isReceipt: false,
    category: "software",
  });
  // The zero-cost 429 slot was re-armed after Retry-After.
  expect(done.events).toEqual([
    { attempt_number: 1, state: "known", actual_usd_micros: "20" },
  ]);
  await db.prepare("DELETE FROM hosted_ai_cooldowns").run();
});

async function documentCode() {
  return db
    .prepare(
      "SELECT parse_state,parse_code FROM documents WHERE user_id=? AND id='d'",
    )
    .bind(tenant.userId)
    .first<{ parse_state: string; parse_code: string | null }>();
}
/** Runs one lease with Date.now() moved `offset` ms past the real clock. */
async function runAt(
  pipeline: ReturnType<typeof service>["pipeline"],
  offset: number,
  attempt = 1,
) {
  const real = Date.now;
  const base = real.call(Date);
  const expiresAt = base + offset + 300000;
  await db
    .prepare("UPDATE jobs SET lease_expires_at=? WHERE user_id=? AND id=?")
    .bind(expiresAt, tenant.userId, lease.jobId)
    .run();
  const spy = vi.spyOn(Date, "now").mockImplementation(() => base + offset);
  try {
    return await pipeline.run({ ...lease, expiresAt, attempt });
  } finally {
    spy.mockRestore();
  }
}

it("AI-CLASSIFIER-PROVIDER zero-cost rejections do not strand a document: 401, 401 after cooldown, then a fixed key classifies it", async () => {
  await db.prepare("DELETE FROM hosted_ai_cooldowns").run();
  const statuses = [401, 401, 200];
  let call = 0;
  const fetch = perplexityFetch(() => {
    const status = statuses[call++] ?? 200;
    return status === 200
      ? Response.json(decision(0.02))
      : new Response("", { status });
  });
  const { pipeline, counts } = service({ perplexityApiKey: KEY });
  const outcomes = [];
  // Each lease starts after the previous 15-minute operator-key cooldown.
  for (let round = 0; round < 3; round++)
    outcomes.push(await runAt(pipeline, round * 16 * 60 * 1000));
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(outcomes[2]).toEqual({ kind: "completed" });
  for (const outcome of outcomes)
    expect(outcome).not.toEqual({ kind: "paused", code: "budget" });
  const state = await classificationState();
  expect(JSON.parse(state.extraction[0]?.result_json ?? "null")).toEqual({
    status: "classified",
    isReceipt: false,
    category: "software",
  });
  // Each zero-cost rejection's slot was re-armed after its cooldown; only
  // the billed decision remains.
  expect(state.events).toEqual([
    { attempt_number: 1, state: "known", actual_usd_micros: "20" },
  ]);
  expect(Math.max(...counts)).toBeLessThanOrEqual(40);
  await db.prepare("DELETE FROM hosted_ai_cooldowns").run();
});

it("AI-CLASSIFIER-PROVIDER a 429 followed by a 401 still leaves room for the corrected call", async () => {
  await db.prepare("DELETE FROM hosted_ai_cooldowns").run();
  const responses = [
    () => new Response("", { status: 429, headers: { "Retry-After": "2" } }),
    () => new Response("", { status: 401 }),
    () => Response.json(decision(0.02)),
  ];
  let call = 0;
  const fetch = perplexityFetch(() =>
    (responses[call++] ?? (() => Response.json(decision(0.02))))(),
  );
  const { pipeline } = service({ perplexityApiKey: KEY });
  expect((await runAt(pipeline, 0)).kind).not.toBe("completed");
  expect((await runAt(pipeline, 5000)).kind).not.toBe("completed");
  expect(await runAt(pipeline, 20 * 60 * 1000)).toEqual({ kind: "completed" });
  expect(fetch).toHaveBeenCalledTimes(3);
  await db.prepare("DELETE FROM hosted_ai_cooldowns").run();
});

it.each([
  [401, "classification-invalid-key"],
  [429, "classification-rate-limit"],
] as const)(
  "AI-CLASSIFIER-PROVIDER rejections are bounded by the job policy: the final %i is a reviewable %s, never a budget pause",
  async (status, code) => {
    await db.prepare("DELETE FROM hosted_ai_cooldowns").run();
    const fetch = perplexityFetch(
      () => new Response("", { status, headers: { "Retry-After": "1" } }),
    );
    // Job policy of three leases: the third rejection is final.
    const { pipeline } = service({ perplexityApiKey: KEY }, 3);
    const outcomes = [];
    for (let round = 0; round < 3; round++)
      outcomes.push(await runAt(pipeline, round * 16 * 60 * 1000, round + 1));
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const outcome of outcomes)
      expect(outcome).not.toEqual({ kind: "paused", code: "budget" });
    expect(await documentCode()).toEqual({
      parse_state: "needs_review",
      parse_code: code,
    });
    // Billed bound: every rejection settled at zero cost.
    const state = await classificationState();
    expect(state.reserved).toEqual({ units: 0, micros: 0 });
    for (const event of state.events)
      expect(event).toMatchObject({ state: "known", actual_usd_micros: "0" });
    await db.prepare("DELETE FROM hosted_ai_cooldowns").run();
  },
);

it("AI-CLASSIFIER-PROVIDER rejected operator key reschedules without a per-document outcome or further calls", async () => {
  await db.prepare("DELETE FROM hosted_ai_cooldowns").run();
  const fetch = perplexityFetch(() => new Response("", { status: 401 }));
  const { pipeline, extract } = service({ perplexityApiKey: KEY });
  const before = await db
    .prepare(
      "SELECT processing_status FROM source_messages WHERE user_id=? AND id='s'",
    )
    .bind(tenant.userId)
    .first("processing_status");
  expect(await pipeline.run(lease)).toEqual({
    kind: "retry",
    code: "transient",
    retryAfterMs: 15 * 60 * 1000,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(extract).not.toHaveBeenCalled();
  const state = await classificationState();
  expect(state.extraction).toEqual([{ result_json: null }]);
  expect(state.reserved).toEqual({ units: 0, micros: 0 });
  expect(
    await db
      .prepare(
        "SELECT processing_status FROM source_messages WHERE user_id=? AND id='s'",
      )
      .bind(tenant.userId)
      .first("processing_status"),
  ).toBe(before);
  // The next document or lease does not call Perplexity with the rejected key.
  const again = await pipeline.run(lease);
  expect(again).toMatchObject({ kind: "retry", code: "transient" });
  expect(fetch).toHaveBeenCalledTimes(1);
  await db.prepare("DELETE FROM hosted_ai_cooldowns").run();
});

it("AI-CLASSIFIER-PROVIDER consent accepted under Clef is refused after switching to Perplexity, before any call", async () => {
  const { aiConfiguration } =
    await import("../../../packages/adapters/src/ai/configuration");
  const { createProcessingReviewResolver, createProcessingDiscoveryReadiness } =
    await import("../../../packages/adapters/src/onboarding/processing-readiness");
  const { selectedOnboardingConfigurationDigest } =
    await import("../../../packages/adapters/src/onboarding/configuration");
  const { createAiProviderFactory } =
    await import("../../../packages/adapters/src/ai/provider-factory");
  const registry = [
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
  ];
  const common = {
    AI_ENABLED: "true",
    AI_HOSTED_DESTINATION: "abacus",
    AI_HOSTED_MODEL: "financial",
    AI_HOSTED_KEY: "synthetic-hosted-key",
    AI_BUDGET_JSON: JSON.stringify(policy),
    AI_REGISTRY_JSON: JSON.stringify(registry),
    CREDENTIAL_KEYRING: JSON.stringify({
      activeVersion: 1,
      keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    }),
  };
  const run = vi.fn();
  const clefAi = aiConfiguration({
    ...common,
    AI_CLASSIFICATION_JSON: JSON.stringify(clefClassification),
    AI: { run },
  });
  const pplxAi = aiConfiguration({
    ...common,
    AI_CLASSIFICATION_JSON: JSON.stringify(classification),
    AI: { run },
    PERPLEXITY_API_KEY: KEY,
  });
  if (!clefAi || !pplxAi) throw new Error("synthetic configuration missing");
  const destination = clefAi.destinations[0],
    model = destination?.models[0];
  if (!destination || !model) throw new Error("fixture model missing");
  const clefDigest = await selectedOnboardingConfigurationDigest({
    mode: "hosted",
    settingsRevision: 1,
    destination,
    model,
    classification: clefAi.classification,
  });
  await db
    .prepare(
      "UPDATE processing_consents SET accepted_configuration_digest=? WHERE user_id=?",
    )
    .bind(clefDigest, tenant.userId)
    .run();
  const selection = {
    mode: "hosted" as const,
    settingsRevision: 1,
    providerId: "abacus",
    modelId: "financial",
    configVersion: "v1",
    policyVersion: 1,
    acceptedDigest: clefDigest,
  };
  // Positive control: the accepted Clef review is valid under Clef.
  expect(await createProcessingReviewResolver(clefAi)(selection)).toBe(
    clefDigest,
  );
  expect(await createProcessingReviewResolver(pplxAi)(selection)).toBeNull();
  const discovery = {
    connectionId: "c",
    generation: 1,
    consentId: "consent",
    disclosureVersion: 1,
    settingsRevision: 1,
    queryMode: "archive" as never,
    processingSelection: selection,
  };
  expect(
    await createProcessingDiscoveryReadiness(clefAi).allow(tenant, discovery),
  ).toBe(true);
  expect(
    await createProcessingDiscoveryReadiness(pplxAi).allow(tenant, discovery),
  ).toBe(false);
  // Lease/load: the source-extract work is not loadable under the new digest.
  expect(
    await createPipelineRepository(db, {
      processingDigest: createProcessingReviewResolver(pplxAi),
    }).load(lease),
  ).toBeNull();
  const fetch = vi.spyOn(globalThis, "fetch");
  const open = vi.fn(async () => {
    throw new Error("NO_CONTENT_ALLOWED");
  });
  const outcome = await createPipelineRuntime({
    db,
    content: { open },
    ai: pplxAi,
    classificationBinding: { run },
    perplexityApiKey: KEY,
    remainingStatements: () => 40,
  }).run(lease, control);
  expect(outcome.kind).toBe("paused");
  // The financial factory also refuses the stale review, so the classifier
  // factory never receives an authorized selection.
  await expect(
    createAiProviderFactory(db, pplxAi, {
      requireReviewedConfiguration: true,
    }).open(tenant, {
      settingsRevision: 1,
      consentId: "consent",
      parts: [{ id: "body", text: "Synthetic invoice" }],
      maxAttempts: 1,
    }),
  ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("AI-CLASSIFIER-PROVIDER classification meter pins the configured provider, not just any allowlisted one", async () => {
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
  const clef = await createReceiptClassifierFactory(db, clefClassification, {
    binding: { run: vi.fn() },
  }).open(lease, work, [], selected);
  const identity = {
    documentId: "d",
    contentHash: work.documents[0]?.contentHash ?? "",
    extractionVersion: "email-classification-v1",
  };
  const store = (destination: { destinationId: string; modelId: string }) =>
    createClassificationUsageStore(db, {
      lease,
      policy,
      pricing: clef.pricing,
      authorization: clef.authorization,
      destination,
    });
  // Positive control: the configured Clef destination admits its own attempt.
  expect(
    await store({
      destinationId: "cloudflare-clef",
      modelId: "@cf/cloudflare/clef",
    }).checkpoint({ tenant, identity, config: clef.config }),
  ).toEqual({ status: "ready" });
  // An allowlisted but unconfigured destination/model is refused.
  for (const destination of [
    { destinationId: "perplexity-decider", modelId: "pplx-decider-v1.1-27b" },
    { destinationId: "cloudflare-clef", modelId: "pplx-decider-v1.1-27b" },
  ])
    expect(
      await store(destination).checkpoint({
        tenant,
        identity,
        config: clef.config,
      }),
    ).toEqual({ status: "stale" });
});

it("AI-CLASSIFIER-PROVIDER a 429 reschedules the job itself: re-dispatched after Retry-After with no user action, never paused", async () => {
  const { createJobStore } =
    await import("../../../packages/adapters/src/jobs/store");
  const { createJobEngine } = await import("@invoxim/core");
  await db.prepare("DELETE FROM hosted_ai_cooldowns").run();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await db
    .prepare(
      "UPDATE jobs SET status='ready',lease_id=NULL,lease_expires_at=NULL,fence=0,retry_count=0,dispatch_at=? WHERE user_id=? AND id=?",
    )
    .bind(now, tenant.userId, lease.jobId)
    .run();
  let call = 0;
  const fetch = perplexityFetch(() =>
    ++call === 1
      ? new Response("", { status: 429, headers: { "Retry-After": "20" } })
      : Response.json(decision(0.02)),
  );
  const { pipeline } = service({ perplexityApiKey: KEY }, 3);
  const sent: string[] = [];
  // One fresh store and engine per invocation, as in the Worker.
  const invocation = () =>
    createJobEngine({
      store: createJobStore(db, {
        policy: {
          dispatchLimit: 5,
          scheduleLimit: 5,
          tenantConcurrency: 2,
          globalConcurrency: 2,
          maxAttempts: 3,
          leaseMs: 300000,
          redeliveryMs: 300000,
          queryLimit: 40,
        },
        clock: () => now,
        processingReview: async (selection) => selection.acceptedDigest,
      }),
      queue: {
        async send(body) {
          sent.push(body.jobId);
        },
      },
      handler: { run: (current) => pipeline.run(current) },
      clock: () => now,
    });
  const engine = {
    consume: (body: { schemaVersion: 1; jobId: string }) =>
      invocation().consume(body),
    dispatch: () => invocation().dispatch(),
  };
  const job = () =>
    db
      .prepare(
        "SELECT status,outcome_code,dispatch_at FROM jobs WHERE user_id=? AND id=?",
      )
      .bind(tenant.userId, lease.jobId)
      .first<{
        status: string;
        outcome_code: string | null;
        dispatch_at: number;
      }>();
  // The existing transient-retry contract: the message is not acked, the
  // durable job waits in retry_wait until the provider's Retry-After.
  expect(await engine.consume({ schemaVersion: 1, jobId: lease.jobId })).toBe(
    "retry",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  const waiting = await job();
  expect(waiting?.status).toBe("retry_wait");
  expect(waiting?.outcome_code).not.toBe("budget");
  expect(waiting?.dispatch_at).toBeGreaterThanOrEqual(now + 20000);
  // Before Retry-After nothing is dispatched and a redelivery cannot claim it.
  now += 10000;
  await engine.dispatch();
  // (Other scheduled work, e.g. an hourly sync, may also be dispatched.)
  expect(sent.filter((id) => id === lease.jobId)).toEqual([]);
  expect(await engine.consume({ schemaVersion: 1, jobId: lease.jobId })).toBe(
    "retry",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  // After Retry-After the scheduler re-dispatches it on its own.
  now += 15000;
  await engine.dispatch();
  expect(sent.filter((id) => id === lease.jobId)).toEqual([lease.jobId]);
  expect(await engine.consume({ schemaVersion: 1, jobId: lease.jobId })).toBe(
    "ack",
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  expect((await job())?.status).toBe("completed");
  const state = await classificationState();
  expect(JSON.parse(state.extraction[0]?.result_json ?? "null")).toMatchObject({
    status: "classified",
  });
  await db.prepare("DELETE FROM hosted_ai_cooldowns").run();
});

it("AI-CLASSIFIER-PROVIDER a 403 is a per-document unsupported outcome without a shared operator cooldown", async () => {
  await db.prepare("DELETE FROM hosted_ai_cooldowns").run();
  const fetch = perplexityFetch(() => new Response("", { status: 403 }));
  const { pipeline } = service({ perplexityApiKey: KEY });
  const outcome = await pipeline.run(lease);
  expect(outcome).not.toMatchObject({ kind: "retry" });
  expect(outcome).not.toMatchObject({ kind: "paused" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await documentCode()).toEqual({
    parse_state: "needs_review",
    parse_code: "classification-unsupported",
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM hosted_ai_cooldowns")
      .first("n"),
  ).toBe(0);
  const state = await classificationState();
  expect(state.reserved).toEqual({ units: 0, micros: 0 });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM usage_events WHERE user_id=? AND cooldown_until>0",
      )
      .bind(tenant.userId)
      .first("n"),
  ).toBe(0);
});
