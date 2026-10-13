import { env } from "cloudflare:workers";
import { EXTRACTION_PROMPT_VERSION } from "@invoxim/contracts";
import type {
  AiUsageStore,
  ApprovedAiConfig,
  TenantContext,
} from "@invoxim/core";
import { createInferenceEngine } from "@invoxim/core";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { createAiProbeUsageStore } from "../../../packages/adapters/src/ai/budget";
import {
  aiDestinationSchema,
  computeAiFingerprint,
} from "../../../packages/adapters/src/ai/configuration";
import {
  chatReservationUnits,
  createChatCompletionsExtractor,
} from "../../../packages/adapters/src/ai/http";

const destination = aiDestinationSchema.parse({
  id: "synthetic-usage-provider",
  endpoint: "https://model.example.invalid/v1/chat/completions",
  configVersion: "synthetic-v1",
  policyVersion: 1,
  noticeRefs: ["synthetic-policy"],
  timeoutMs: 1000,
  maxInputBytes: 8192,
  maxOutputBytes: 8192,
  maxOutputTokens: 256,
  models: [
    {
      id: "synthetic-model",
      capabilities: {
        jsonSchema: false,
        jsonObject: true,
        outputLimit: "max_tokens",
        usage: true,
        idempotency: false,
      },
      pricing: {
        version: "synthetic-price-v1",
        approved: true,
        currency: "USD",
        source: "https://prices.example.invalid/synthetic",
        checkedAt: "2026-10-13T00:00:00Z",
        inputUsdMicrosPerMillion: "1000000",
        outputUsdMicrosPerMillion: "2000000",
        otherUsdMicrosPerMillion: "2000000",
      },
    },
  ],
});
const model = destination.models[0];
if (!model) throw new Error("Synthetic model fixture missing");
const parts = [
  { id: "synthetic-part", text: "Synthetic non-purchase message" },
];
const output = JSON.stringify({
  schemaVersion: 1,
  documentType: "non-purchase",
  records: [],
  warnings: [],
});
const config: ApprovedAiConfig = {
  destinationId: destination.id,
  modelId: model.id,
  mode: "hosted",
  settingsRevision: 1,
  consentId: "synthetic-consent",
  fingerprint: "synthetic-fingerprint",
  promptVersion: EXTRACTION_PROMPT_VERSION,
  schemaVersion: 1,
  maxInputBytes: 8192,
  maxOutputBytes: 8192,
  maxOutputTokens: 256,
  maxAttempts: 2,
  reservationUnits: chatReservationUnits(parts, model, 256),
};
const extractor = () =>
  createChatCompletionsExtractor(destination, model, "synthetic-private-key");
const choices = [
  {
    index: 0,
    finish_reason: "stop",
    message: { role: "assistant", content: output },
  },
];
const invalidUsage = [
  { label: "omitted", fields: {} },
  { label: "null", fields: { usage: null } },
  { label: "partial", fields: { usage: { prompt_tokens: 10 } } },
  { label: "wrong-type", fields: { usage: "synthetic-private-metadata" } },
  {
    label: "negative",
    fields: {
      usage: { prompt_tokens: -1, completion_tokens: 5, total_tokens: 4 },
    },
  },
  {
    label: "inconsistent",
    fields: {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 99 },
    },
  },
  {
    label: "out-of-bounds",
    fields: {
      usage: {
        prompt_tokens: 1000001,
        completion_tokens: 5,
        total_tokens: 1000006,
      },
    },
  },
];
afterEach(() => vi.restoreAllMocks());
beforeAll(async () => {
  for (const statement of baseline.split(";").filter((value) => value.trim()))
    await env.DB.prepare(statement).run();
});

it.each(invalidUsage)(
  "AI-04/06 valid output survives $label usage and warns with only a fixed safe code",
  async ({ fields }) => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ choices, ...fields }),
    );
    expect(
      await extractor().extract(parts, config, {
        id: "synthetic-attempt",
        repair: false,
      }),
    ).toEqual({ status: "ok", output, finish: "complete", usage: null });
    expect(warning.mock.calls).toEqual([["ai_usage_unavailable"]]);
  },
);

it("AI-04 reported consistent bounded usage remains available without warning", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      choices,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );
  expect(
    await extractor().extract(parts, config, {
      id: "synthetic-known",
      repair: false,
    }),
  ).toMatchObject({
    status: "ok",
    usage: { input: 10, output: 5, other: 0, source: "reported" },
  });
  expect(warning).not.toHaveBeenCalled();
});

it.each([
  {
    label: "tools",
    choice: {
      ...choices[0],
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: output,
        tool_calls: [{ function: { name: "synthetic-tool" } }],
      },
    },
    expected: { status: "failed", reason: "unsupported", usage: null },
  },
  {
    label: "refusal",
    choice: {
      ...choices[0],
      message: {
        role: "assistant",
        refusal: "synthetic-private-refusal",
        content: null,
      },
    },
    expected: { status: "failed", reason: "refusal", usage: null },
  },
  {
    label: "truncation",
    choice: { ...choices[0], finish_reason: "length" },
    expected: { status: "ok", output, finish: "truncated", usage: null },
  },
])(
  "AI-04 missing usage preserves $label handling",
  async ({ choice, expected }) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ choices: [choice] }),
    );
    expect(
      await extractor().extract(parts, config, {
        id: "synthetic-guard",
        repair: false,
      }),
    ).toEqual(expected);
  },
);

it("AI-06 the real inference engine settles valid output with missing usage as uncertain rather than known zero", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ choices, usage: null }),
  );
  const settlement = vi.fn<AiUsageStore["settle"]>().mockResolvedValue();
  const store: AiUsageStore = {
    checkpoint: async () => ({ status: "ready" }),
    reserve: async () => "reserved",
    authorize: async () => true,
    settle: settlement,
    complete: async () => true,
  };
  expect(
    await createInferenceEngine({ extractor: extractor(), store }).extract(
      { userId: "synthetic-engine-owner", authority: "job" } as TenantContext,
      {
        documentId: "synthetic-document",
        contentHash: "a".repeat(64),
        extractionVersion: "v1",
      },
      parts,
      config,
    ),
  ).toMatchObject({ status: "accepted" });
  expect(settlement).toHaveBeenCalledTimes(1);
  expect(settlement.mock.calls[0]?.[1]).toEqual({
    state: "uncertain",
    usage: null,
  });
});

it("AI-06 actual D1 settlement retains the entire hosted reservation when valid output has no usable usage", async () => {
  const db = env.DB;
  const tenant = {
    userId: "synthetic-optional-usage-owner",
    authority: "session",
  } as TenantContext;
  const now = Date.now();
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
    )
    .bind(tenant.userId, "Synthetic", "optional-usage@example.invalid")
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      'INSERT INTO "session"(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)',
    )
    .bind(
      "synthetic-usage-session",
      now + 3600000,
      "synthetic-session-token",
      now,
      now,
      tenant.userId,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO ai_settings(user_id,mode,provider_id,model_id,config_version,revision,consent_version) VALUES(?,'hosted',?,?,?,1,1)",
    )
    .bind(tenant.userId, destination.id, model.id, destination.configVersion)
    .run();
  const configurationDigest = "b".repeat(64);
  const probeConfig = {
    ...config,
    consentId: "synthetic-test",
    fingerprint: await computeAiFingerprint({
      mode: "hosted",
      configurationDigest,
      settingsRevision: 1,
      generation: 1,
      credentialVersion: 0,
      policyVersion: 1,
      consentId: "synthetic-test",
    }),
  };
  const meter = createAiProbeUsageStore(db, {
    session: { tenant, sessionId: "synthetic-usage-session" },
    policy: {
      dailyDocuments: 10,
      monthlyDocuments: 100,
      dailyUnits: 100000,
      monthlyUnits: 1000000,
      globalDailyUsdMicros: "1000000",
      globalMonthlyUsdMicros: "10000000",
    },
    pricing: new Map([
      [
        probeConfig.fingerprint,
        {
          ...model.pricing,
          destinationId: destination.id,
          modelId: model.id,
          configVersion: destination.configVersion,
          policyVersion: 1,
          configurationDigest,
        },
      ],
    ]),
  });
  expect(await meter.reserve({ config: probeConfig })).toBe("reserved");
  expect(await meter.authorize({ config: probeConfig })).toBe(true);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ choices, usage: { prompt_tokens: 10 } }),
  );
  const response = await extractor().extract(parts, probeConfig, {
    id: "synthetic-meter",
    repair: false,
  });
  expect(response).toMatchObject({ status: "ok", usage: null });
  await meter.settle(
    { config: probeConfig },
    { state: "uncertain", usage: response.usage },
  );
  const event = await db
    .prepare(
      "SELECT state,reserved_units,reserved_usd_micros,actual_units,actual_usd_micros FROM usage_events WHERE user_id=?",
    )
    .bind(tenant.userId)
    .first();
  expect(event).toMatchObject({
    state: "uncertain",
    reserved_units: probeConfig.reservationUnits,
    actual_units: null,
    actual_usd_micros: null,
  });
  expect(Number(event?.reserved_usd_micros)).toBeGreaterThan(0);
  expect(
    await db
      .prepare(
        "SELECT reserved_units,spent_units FROM usage_buckets WHERE scope='tenant' AND owner_key=? AND period_kind='day'",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual({ reserved_units: probeConfig.reservationUnits, spent_units: 0 });
  expect(
    await db
      .prepare(
        "SELECT reserved_usd_micros,spent_usd_micros FROM usage_buckets WHERE scope='global' AND period_kind='day'",
      )
      .first(),
  ).toEqual({
    reserved_usd_micros: event?.reserved_usd_micros,
    spent_usd_micros: 0,
  });
});
