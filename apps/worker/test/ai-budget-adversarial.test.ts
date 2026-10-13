import { env } from "cloudflare:workers";
import type {
  AiCheckpoint,
  ApprovedAiConfig,
  JobLease,
  TenantContext,
} from "@invoxim/core";
import {
  aiRunIdentityKey,
  createInferenceEngine,
  createJobEngine,
} from "@invoxim/core";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import type {
  AiBudgetPolicy,
  AiPriceSnapshot,
} from "../../../packages/adapters/src/ai/budget";
import {
  createAiUsageStore,
  readAiAllowance,
} from "../../../packages/adapters/src/ai/budget";
import { aiConfiguration } from "../../../packages/adapters/src/ai/configuration";
import { createAiProviderFactory } from "../../../packages/adapters/src/ai/provider-factory";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { createCredentialCipher } from "../../../packages/adapters/src/security/cipher";
import { createInvocationDatabase } from "../src/invocation-database";

const fixtureDatabase = env.DB;
const db = fixtureDatabase;

afterEach(() => vi.restoreAllMocks());

const at = Date.UTC(2026, 9, 12);
const MAX = 9000000000000;
const price: AiPriceSnapshot = {
  destinationId: "qa-budget-provider",
  modelId: "qa-budget-model",
  configVersion: "qa-budget-config-v1",
  policyVersion: 1,
  configurationDigest: "b".repeat(64),
  version: "qa-price-v1",
  approved: true,
  currency: "USD",
  source: "https://prices.example.invalid/synthetic",
  checkedAt: "2026-10-12T00:00:00Z",
  inputUsdMicrosPerMillion: "1000000",
  outputUsdMicrosPerMillion: "2000000",
  otherUsdMicrosPerMillion: "2000000",
};
const generous: AiBudgetPolicy = {
  dailyDocuments: 10,
  monthlyDocuments: 100,
  dailyUnits: MAX,
  monthlyUnits: MAX,
  globalDailyUsdMicros: String(MAX),
  globalMonthlyUsdMicros: String(MAX),
};
beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((v) => v.trim()))
      await db.prepare(statement).run();
});
// Each case owns a fresh synthetic tenant/global accounting state. Workerd preserves
// this file's D1 database between cases, including deliberately sticky global blocks.
beforeEach(async () => {
  await db.prepare('DELETE FROM "user"').run();
  await db.prepare("DELETE FROM usage_buckets WHERE scope='global'").run();
  await db.prepare("DELETE FROM hosted_ai_cooldowns").run();
});
async function hash(value: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
}
async function owner(name: string, mode: "hosted" | "byok" = "hosted") {
  // Synthetic fixture authority only; native claim cases validate the actual job row separately.
  const tenant = { userId: name, authority: "job" } as TenantContext;
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
    )
    .bind(name, name, `${name}@example.invalid`)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind(name)
    .run();
  await db
    .prepare(
      "INSERT INTO ai_settings(user_id,mode,provider_id,model_id,config_version,revision,consent_version) VALUES(?,?,?,?,?,1,1)",
    )
    .bind(name, mode, price.destinationId, price.modelId, price.configVersion)
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state) VALUES(?,?,'mailbox','gmail',?,?,'active')",
    )
    .bind(
      `conn-${name}`,
      name,
      `subject-${name}`,
      `${name}-mail@example.invalid`,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES(?,?,?,1,?,'qa-local-parser',1,0,1)",
    )
    .bind(`consent-${name}`, name, `conn-${name}`, price.destinationId)
    .run();
  if (mode === "byok") {
    const cipher = createCredentialCipher({
      activeVersion: 1,
      keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    const envelope = await cipher.seal(
      tenant,
      { entityId: "primary", purpose: "byok-key" },
      { key: "synthetic-budget-byok-key" },
    );
    await db
      .prepare(
        "UPDATE ai_settings SET encrypted_key=?,key_version=1,credential_version=1 WHERE user_id=?",
      )
      .bind(envelope, name)
      .run();
  }
  const config: ApprovedAiConfig = {
    destinationId: price.destinationId,
    modelId: price.modelId,
    mode,
    settingsRevision: 1,
    consentId: `consent-${name}`,
    fingerprint: await hash([
      mode,
      price.configurationDigest,
      1,
      1,
      mode === "byok" ? 1 : 0,
      1,
      `consent-${name}`,
      "invoice-extraction-v1",
      1,
    ]),
    promptVersion: "invoice-extraction-v1",
    schemaVersion: 1,
    maxInputBytes: 10000,
    maxOutputBytes: 16000,
    maxOutputTokens: 200,
    maxAttempts: 2,
    reservationUnits: 1000,
  };
  return { tenant, config };
}
async function document(
  user: Awaited<ReturnType<typeof owner>>,
  id: string,
  status: "leased" | "ready" = "leased",
  time = at,
) {
  const { tenant, config } = user;
  const jobId = `job-${tenant.userId}-${id}`;
  const sourceId = `source-${tenant.userId}-${id}`;
  const docId = `doc-${tenant.userId}-${id}`;
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,lease_id,lease_expires_at,fence) VALUES(?,?,?,?,1,'source-extract',?,?,?, ?,?,1)",
    )
    .bind(
      jobId,
      tenant.userId,
      `conn-${tenant.userId}`,
      config.consentId,
      jobId,
      status,
      time,
      status === "leased" ? `lease-${jobId}` : null,
      status === "leased" ? time + 300000 : null,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,?,?,?,1)",
    )
    .bind(sourceId, tenant.userId, `conn-${tenant.userId}`, id, at)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES(?,?,?,'body',?,'text/plain',10)",
    )
    .bind(docId, tenant.userId, sourceId, "a".repeat(64))
    .run();
  await db
    .prepare(
      "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id) VALUES(?,?,?)",
    )
    .bind(tenant.userId, jobId, sourceId)
    .run();
  const lease: JobLease = {
    context: tenant,
    jobId,
    connectionId: `conn-${tenant.userId}`,
    consentId: config.consentId,
    generation: 1,
    syncStateId: null,
    type: "source-extract",
    leaseId: `lease-${jobId}`,
    fence: 1,
    expiresAt: time + 300000,
    attempt: 1,
  };
  const input: AiCheckpoint = {
    tenant,
    config,
    identity: {
      documentId: docId,
      contentHash: "a".repeat(64),
      extractionVersion: "qa-extraction-v1",
    },
  };
  const attempt = {
    ...input,
    attemptNumber: 1,
    attemptId: `${await aiRunIdentityKey(input)}:1`,
  };
  return { lease, input, attempt };
}
function store(
  d: Awaited<ReturnType<typeof document>>,
  policy = generous,
  clock = () => at,
  db = fixtureDatabase,
) {
  return createAiUsageStore(db, {
    lease: d.lease,
    policy,
    pricing: new Map([[d.input.config.fingerprint, price]]),
    clock,
  });
}
it("AI-06 cumulative bounded-counter overflow still records exact overrun, retains reservation and blocks replay", async () => {
  const user = await owner("qa-cumulative-overrun");
  const d = await document(user, "one");
  const meter = store(d);
  for (const kind of ["day", "month"]) {
    const period = kind === "day" ? "2026-10-12" : "2026-10";
    await db
      .prepare(
        "INSERT INTO usage_buckets(scope,owner_key,user_id,period_kind,period_start,spent_units) VALUES('tenant',?,?,?, ?,?)",
      )
      .bind(user.tenant.userId, user.tenant.userId, kind, period, MAX - 2500)
      .run();
    await db
      .prepare(
        "INSERT INTO usage_buckets(scope,owner_key,period_kind,period_start,spent_usd_micros) VALUES('global','operator',?,?,?)",
      )
      .bind(kind, period, MAX - 2500)
      .run();
  }
  expect(await meter.reserve(d.attempt)).toBe("reserved");
  expect(await meter.authorize(d.attempt)).toBe(true);
  await meter.settle(d.attempt, {
    state: "known",
    usage: { input: 3000, output: 0, other: 0, source: "reported" },
  });
  expect(
    await db
      .prepare(
        "SELECT state,actual_units,actual_usd_micros FROM usage_events WHERE user_id=?",
      )
      .bind(user.tenant.userId)
      .first(),
  ).toEqual({
    state: "overrun",
    actual_units: "3000",
    actual_usd_micros: "3000",
  });
  expect(
    await db
      .prepare(
        "SELECT blocked,reserved_units,spent_units FROM usage_buckets WHERE scope='tenant' AND owner_key=? AND period_kind='day'",
      )
      .bind(user.tenant.userId)
      .first(),
  ).toEqual({ blocked: 1, reserved_units: 1000, spent_units: MAX - 2500 });
  expect(
    await db
      .prepare(
        "SELECT blocked,reserved_usd_micros,spent_usd_micros FROM usage_buckets WHERE scope='global' AND period_kind='day'",
      )
      .first(),
  ).toEqual({
    blocked: 1,
    reserved_usd_micros: 2000,
    spent_usd_micros: MAX - 2500,
  });
  const nextPeriod = at + 32 * 86400000;
  const later = await document(user, "later", "leased", nextPeriod);
  const laterMeter = store(later, generous, () => nextPeriod);
  expect(await laterMeter.checkpoint(later.input)).toEqual({ status: "ready" });
  expect(await laterMeter.reserve(later.attempt)).toBe("budget");
  await db
    .prepare("DELETE FROM profiles WHERE user_id=?")
    .bind(user.tenant.userId)
    .run();
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM usage_events WHERE user_id=?")
      .bind(user.tenant.userId)
      .first("count"),
  ).toBe(0);
  const another = await owner("qa-after-deleted-overrun");
  const fresh = await document(another, "new-period", "leased", nextPeriod);
  const freshMeter = store(fresh, generous, () => nextPeriod);
  expect(await freshMeter.checkpoint(fresh.input)).toEqual({ status: "ready" });
  expect(await freshMeter.reserve(fresh.attempt)).toBe("budget");
  expect(
    (
      await readAiAllowance(db, another.tenant, generous, {
        clock: () => nextPeriod,
      })
    ).hostedFundingAvailable,
  ).toBe(false);
});

it("AI-06 BYOK overrun blocks its tenant without consuming or blocking operator hosted funding", async () => {
  const user = await owner("qa-byok-overrun", "byok");
  const d = await document(user, "one");
  const meter = store(d);
  expect(await meter.checkpoint(d.input)).toEqual({ status: "ready" });
  expect(await meter.reserve(d.attempt)).toBe("reserved");
  expect(await meter.authorize(d.attempt)).toBe(true);
  await meter.settle(d.attempt, {
    state: "known",
    usage: { input: 3000, output: 0, other: 0, source: "reported" },
  });
  expect(
    await db
      .prepare(
        "SELECT state,actual_units,actual_usd_micros FROM usage_events WHERE user_id=?",
      )
      .bind(user.tenant.userId)
      .first(),
  ).toEqual({ state: "overrun", actual_units: "3000", actual_usd_micros: "0" });
  expect(
    await db
      .prepare(
        "SELECT MAX(blocked) AS blocked,MAX(reserved_usd_micros) AS reserved,MAX(spent_usd_micros) AS spent FROM usage_buckets WHERE scope='global'",
      )
      .first(),
  ).toEqual({ blocked: 0, reserved: 0, spent: 0 });
  const nextPeriod = at + 32 * 86400000;
  const next = await document(user, "blocked-next", "leased", nextPeriod);
  expect(
    await store(next, generous, () => nextPeriod).checkpoint(next.input),
  ).toEqual({ status: "ready" });
  expect(
    await store(next, generous, () => nextPeriod).reserve(next.attempt),
  ).toBe("budget");
  const hosted = await owner("qa-hosted-after-byok");
  const hd = await document(hosted, "allowed");
  expect(await store(hd).reserve(hd.attempt)).toBe("reserved");
});
it("AI-05 concurrent tenant documents and global monetary reservations never oversubscribe", async () => {
  const user = await owner("qa-race-docs");
  const docs = await Promise.all([
    document(user, "race-a"),
    document(user, "race-b"),
  ]);
  const policy = { ...generous, dailyDocuments: 1 };
  const results = await Promise.all(
    docs.map((d) => store(d, policy).reserve(d.attempt)),
  );
  expect(results.sort()).toEqual(["budget", "reserved"]);
  const bucket = await db
    .prepare(
      "SELECT documents,reserved_units FROM usage_buckets WHERE scope='tenant' AND owner_key=? AND period_kind='day'",
    )
    .bind(user.tenant.userId)
    .first();
  expect(bucket).toMatchObject({ documents: 1, reserved_units: 1000 });
  // Locate the durable winner rather than depending on race completion order.
  const event = await db
    .prepare("SELECT attempt_id FROM usage_events WHERE user_id=?")
    .bind(user.tenant.userId)
    .first<string>("attempt_id");
  const winner = docs.find((d) => d.attempt.attemptId === event);
  if (!winner) throw new Error("Missing durable synthetic reservation winner");
  expect(await store(winner, policy).reserve(winner.attempt)).toBe("existing");
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM usage_events WHERE user_id=?")
      .bind(user.tenant.userId)
      .first("n"),
  ).toBe(1);
});
it("AI-05 concurrent hosted users share atomic exact global funding", async () => {
  const users = await Promise.all([
    owner("qa-global-race-a"),
    owner("qa-global-race-b"),
  ]);
  const docs = await Promise.all(
    users.map((u, i) => document(u, `global-${i}`)),
  );
  const policy = { ...generous, globalDailyUsdMicros: "2000" };
  expect(
    (
      await Promise.all(docs.map((d) => store(d, policy).reserve(d.attempt)))
    ).sort(),
  ).toEqual(["budget", "reserved"]);
  expect(
    await db
      .prepare(
        "SELECT reserved_usd_micros FROM usage_buckets WHERE scope='global' AND period_kind='day'",
      )
      .first("reserved_usd_micros"),
  ).toBe(2000);
});
it.each(["generation", "consent", "lease"])(
  "AI-03 %s invalidation after reservation denies authorization",
  async (change) => {
    const user = await owner(`qa-fence-${change}`);
    const d = await document(user, "fence");
    const usage = store(d);
    expect(await usage.reserve(d.attempt)).toBe("reserved");
    if (change === "generation")
      await db
        .prepare(
          "UPDATE connections SET generation=generation+1 WHERE user_id=?",
        )
        .bind(user.tenant.userId)
        .run();
    else if (change === "consent")
      await db
        .prepare("UPDATE processing_consents SET revoked_at=? WHERE user_id=?")
        .bind(at, user.tenant.userId)
        .run();
    else
      await db
        .prepare(
          "UPDATE jobs SET lease_id='replacement',fence=fence+1 WHERE user_id=?",
        )
        .bind(user.tenant.userId)
        .run();
    expect(await usage.authorize(d.attempt)).toBe(false);
  },
);

it("AI-05 native job claim, inference reservation/settlement/cache and ACK share actual40", async () => {
  const user = await owner("qa-native-ai-job");
  const d = await document(user, "native", "ready");
  const guarded = createInvocationDatabase(env.DB, 40);
  const jobsStore = createJobStore(guarded.db, {
    clock: () => at,
    policy: {
      dispatchLimit: 2,
      scheduleLimit: 2,
      tenantConcurrency: 1,
      globalConcurrency: 2,
      maxAttempts: 3,
      leaseMs: 300000,
      redeliveryMs: 2000,
    },
  });
  let calls = 0;
  const engine = createJobEngine({
    store: jobsStore,
    queue: { send: async () => {} },
    clock: () => at,
    handler: {
      run: async (lease) => {
        const usage = store({ ...d, lease }, generous, () => at, guarded.db);
        const inference = createInferenceEngine({
          store: usage,
          extractor: {
            extract: async () => {
              calls++;
              return {
                status: "ok" as const,
                output: "{}",
                finish: "complete" as const,
                usage: {
                  input: 5,
                  output: 5,
                  other: 0,
                  source: "reported" as const,
                },
              };
            },
          },
        });
        expect(
          await inference.extract(
            lease.context,
            d.input.identity,
            [{ id: "body", text: "Synthetic non-purchase text" }],
            { ...d.input.config, maxAttempts: 1 },
          ),
        ).toEqual({ status: "needs-review", reason: "schema" });
        return { kind: "completed" };
      },
    },
  });
  expect(await engine.consume({ schemaVersion: 1, jobId: d.lease.jobId })).toBe(
    "ack",
  );
  expect(calls).toBe(1);
  expect(guarded.executedStatements()).toBeLessThanOrEqual(40);
  expect(
    await db
      .prepare("SELECT status FROM jobs WHERE id=?")
      .bind(d.lease.jobId)
      .first("status"),
  ).toBe("completed");
  const cached = await db
    .prepare("SELECT result_json FROM ai_extractions WHERE user_id=?")
    .bind(user.tenant.userId)
    .first<string>("result_json");
  expect(JSON.parse(cached ?? "null")).toEqual({
    status: "needs-review",
    reason: "schema",
  });
  console.log(
    JSON.stringify({
      case: "native-job-ai",
      executed: guarded.executedStatements(),
    }),
  );
});

it.each([
  { repair: false, mode: "hosted" as const },
  { repair: true, mode: "hosted" as const },
  { repair: false, mode: "byok" as const },
  { repair: true, mode: "byok" as const },
])(
  "AI-05 real factory normal extraction $mode repair=$repair shares40 through native ACK",
  async ({ repair, mode }) => {
    const user = await owner(`qa-factory-native-${mode}-${repair}`, mode);
    const d = await document(user, "real", "ready");
    const publicPrice = {
      version: price.version,
      approved: price.approved,
      currency: price.currency,
      source: price.source,
      checkedAt: price.checkedAt,
      inputUsdMicrosPerMillion: price.inputUsdMicrosPerMillion,
      outputUsdMicrosPerMillion: price.outputUsdMicrosPerMillion,
      otherUsdMicrosPerMillion: price.otherUsdMicrosPerMillion,
    };
    const registry = {
      id: price.destinationId,
      endpoint: "https://qa-inference.example.invalid/v1/chat/completions",
      configVersion: price.configVersion,
      policyVersion: 1,
      noticeRefs: ["synthetic"],
      timeoutMs: 1000,
      maxInputBytes: 10000,
      maxOutputBytes: 16000,
      maxOutputTokens: 200,
      models: [
        {
          id: price.modelId,
          capabilities: {
            jsonSchema: false,
            jsonObject: false,
            outputLimit: "max_tokens",
            usage: true,
            idempotency: true,
          },
          pricing: publicPrice,
        },
      ],
    };
    const configuration = aiConfiguration({
      AI_ENABLED: "true",
      AI_REGISTRY_JSON: JSON.stringify([registry]),
      AI_HOSTED_DESTINATION: price.destinationId,
      AI_HOSTED_MODEL: price.modelId,
      AI_HOSTED_KEY: "synthetic-normal-key",
      CREDENTIAL_KEYRING: JSON.stringify({
        activeVersion: 1,
        keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      }),
      AI_BUDGET_JSON: JSON.stringify(generous),
    });
    if (!configuration) throw new Error("Invalid normal synthetic registry");
    const text =
      "QA Store\n2026-10-01\nTotal EUR 10.00\nPaid EUR 10.00 by card";
    const evidence = (field: string, quote: string) => ({
      field,
      inputPartId: "body",
      quote,
    });
    const record = {
      merchant: "QA Store",
      documentDate: "2026-10-01",
      eventDate: "2026-10-01",
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
        evidence("merchant", "QA Store"),
        evidence("documentDate", "2026-10-01"),
        evidence("eventDate", "2026-10-01"),
        evidence("currency", "EUR"),
        evidence("total", "Total EUR 10.00"),
        evidence("payment", "Paid EUR 10.00 by card"),
        evidence("paymentAmount", "Paid EUR 10.00 by card"),
      ],
    };
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(registry.endpoint);
      expect(request.headers.get("Authorization")).toBe(
        mode === "byok"
          ? "Bearer synthetic-budget-byok-key"
          : "Bearer synthetic-normal-key",
      );
      calls++;
      return Response.json({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                repair && calls === 1
                  ? "{}"
                  : JSON.stringify({
                      schemaVersion: 1,
                      documentType: "receipt",
                      records: [record],
                      warnings: [],
                    }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      });
    });
    const guarded = createInvocationDatabase(env.DB, 40);
    const jobStore = createJobStore(guarded.db, {
      clock: () => at,
      policy: {
        dispatchLimit: 2,
        scheduleLimit: 2,
        tenantConcurrency: 1,
        globalConcurrency: 2,
        maxAttempts: 3,
        leaseMs: 300000,
        redeliveryMs: 2000,
      },
    });
    const engine = createJobEngine({
      store: jobStore,
      queue: { send: async () => {} },
      clock: () => at,
      handler: {
        run: async (lease) => {
          const selected = await createAiProviderFactory(
            guarded.db,
            configuration,
          ).open(lease.context, {
            settingsRevision: 1,
            consentId: lease.consentId,
            parts: [{ id: "body", text }],
          });
          const usage = createAiUsageStore(guarded.db, {
            lease,
            policy: generous,
            pricing: selected.pricing,
            clock: () => at,
          });
          const result = await createInferenceEngine({
            store: usage,
            extractor: selected.extractor,
          }).extract(
            lease.context,
            d.input.identity,
            [{ id: "body", text }],
            selected.config,
          );
          expect(result.status).toBe("accepted");
          return { kind: "completed" };
        },
      },
    });
    expect(
      await engine.consume({ schemaVersion: 1, jobId: d.lease.jobId }),
    ).toBe("ack");
    expect(calls).toBe(repair ? 2 : 1);
    expect(guarded.executedStatements()).toBeLessThanOrEqual(40);
    expect(
      await db
        .prepare("SELECT status FROM jobs WHERE id=?")
        .bind(d.lease.jobId)
        .first("status"),
    ).toBe("completed");
  },
);
