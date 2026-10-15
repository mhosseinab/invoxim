import { expect, it } from "vitest";
import preset from "../../../config/ai.abacus.production.json";
import production from "../../../config/ai.classification.production.json";
import { receiptClassificationConfigurationSchema } from "../../../packages/adapters/src/ai/classification-config";
import {
  aiConfiguration,
  aiDestinationSchema,
} from "../../../packages/adapters/src/ai/configuration";
import {
  RECEIPT_CLASSIFIER_NOTICE,
  receiptClassifierNotice,
  selectedOnboardingConfigurationDigest,
} from "../../../packages/adapters/src/onboarding/configuration";
import { mailboxProcessingConfiguration } from "../src/mailbox-runtime";

/** AI-CLASSIFIER-PROVIDER: the Clef production file as shipped before provider selection. */
const legacyClef = {
  enabled: true,
  model: "@cf/cloudflare/clef",
  version: "document-classification-v4",
  maxInputBytes: 24000,
  timeoutMs: 30000,
  negativeThreshold: 0.1,
  positiveThreshold: 0.9,
  categoryThreshold: 0.5,
  pricing: {
    version: "cloudflare-clef-20261013",
    approved: true,
    currency: "USD",
    source: "https://developers.cloudflare.com/workers-ai/models/clef/",
    checkedAt: "2026-10-13T19:50:00Z",
    inputUsdMicrosPerMillion: "240000",
    outputUsdMicrosPerMillion: "0",
    otherUsdMicrosPerMillion: "0",
  },
  uncertainAction: "extract",
} as const;
const perplexity = {
  ...legacyClef,
  provider: "perplexity-decider",
  model: "pplx-decider-v1.1-27b",
  version: "synthetic-perplexity-v1",
  pricing: {
    ...legacyClef.pricing,
    version: "synthetic-perplexity-20261015",
    source: "https://docs.perplexity.ai/docs/decisions/quickstart",
    inputUsdMicrosPerMillion: "20000",
  },
} as const;
const destination = aiDestinationSchema.parse(preset.registry[0]);
const model = destination.models[0];
if (!model) throw new Error("INVALID_SYNTHETIC_MODEL");
const selection = {
  mode: "hosted" as const,
  settingsRevision: 1,
  destination,
  model,
};
const base = {
  AI_ENABLED: "true",
  AI_REGISTRY_JSON: JSON.stringify(preset.registry),
  AI_BUDGET_JSON: JSON.stringify(preset.budget),
  CREDENTIAL_KEYRING: JSON.stringify({
    activeVersion: 1,
    keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  }),
};
const clefBinding = {
  async run(): Promise<unknown> {
    throw new Error("NO_NETWORK_ALLOWED");
  },
};
const ready = {
  EXTRACTION_ENABLED: "true",
  JOBS_ENABLED: "true",
  JOBS_QUERY_LIMIT: "40",
  JOBS_DISPATCH_LIMIT: "5",
  JOBS_SCHEDULE_LIMIT: "5",
  JOBS_TENANT_CONCURRENCY: "2",
  JOBS_GLOBAL_CONCURRENCY: "2",
  JOBS_MAX_ATTEMPTS: "3",
  JOBS_LEASE_MS: "300000",
  JOBS_REDELIVERY_MS: "300000",
};

it("AI-CLASSIFIER-PROVIDER config without provider parses as Clef and keeps its consent digest byte-identical", async () => {
  const parsed = receiptClassificationConfigurationSchema.parse(legacyClef);
  expect(parsed).toEqual(legacyClef);
  expect(parsed).not.toHaveProperty("provider");
  // Golden value computed from the pre-provider code at a56c7a1.
  expect(
    await selectedOnboardingConfigurationDigest({
      ...selection,
      classification: parsed,
    }),
  ).toBe("9b014bb853265ba4fa50bed98d9733d2d699d3ea811b86408b05f8cc90480404");
  expect(
    receiptClassificationConfigurationSchema.parse({
      ...legacyClef,
      provider: "cloudflare-clef",
    }),
  ).toMatchObject({ provider: "cloudflare-clef" });
});

it("AI-CLASSIFIER-PROVIDER provider union pins model ids, pricing and unknown providers", () => {
  expect(receiptClassificationConfigurationSchema.parse(perplexity)).toEqual(
    perplexity,
  );
  expect(
    receiptClassificationConfigurationSchema.parse({
      ...perplexity,
      model: "pplx-decider-v1-27b",
    }).model,
  ).toBe("pplx-decider-v1-27b");
  for (const invalid of [
    { ...perplexity, model: "@cf/cloudflare/clef" },
    { ...perplexity, model: "pplx-decider-v2-27b" },
    { ...legacyClef, model: "pplx-decider-v1.1-27b" },
    { ...legacyClef, provider: "cloudflare-clef", model: perplexity.model },
    { ...perplexity, provider: "openai" },
    { ...perplexity, endpoint: "https://attacker.example/v1/decisions" },
    {
      ...perplexity,
      pricing: { ...perplexity.pricing, outputUsdMicrosPerMillion: "1" },
    },
    {
      ...perplexity,
      pricing: { ...perplexity.pricing, otherUsdMicrosPerMillion: "1" },
    },
    { ...perplexity, negativeThreshold: 0.2 },
  ])
    expect(
      receiptClassificationConfigurationSchema.safeParse(invalid).success,
    ).toBe(false);
});

it("AI-CLASSIFIER-PROVIDER checked-in production config selects enabled Perplexity pplx-decider with the published tariff", () => {
  const parsed = receiptClassificationConfigurationSchema.parse(production);
  expect(parsed).toMatchObject({
    enabled: true,
    provider: "perplexity-decider",
    model: "pplx-decider-v1.1-27b",
    negativeThreshold: 0.1,
    positiveThreshold: 0.9,
    categoryThreshold: 0.5,
    uncertainAction: "extract",
    pricing: {
      approved: true,
      currency: "USD",
      source: "https://docs.perplexity.ai/docs/decisions/quickstart",
      inputUsdMicrosPerMillion: "20000",
      outputUsdMicrosPerMillion: "0",
      otherUsdMicrosPerMillion: "0",
    },
  });
  expect(JSON.stringify(production)).not.toMatch(/key|secret|token/i);
});

it("AI-CLASSIFIER-PROVIDER Perplexity requires PERPLEXITY_API_KEY and never falls back to the Clef binding", () => {
  const configured = {
    ...base,
    AI_CLASSIFICATION_JSON: JSON.stringify(perplexity),
  };
  expect(
    aiConfiguration({ ...configured, PERPLEXITY_API_KEY: "synthetic-key" }),
  ).toMatchObject({ classification: perplexity });
  for (const key of [undefined, "", "   ", "bad\nkey", "x".repeat(4097)]) {
    expect(
      aiConfiguration({
        ...configured,
        AI: clefBinding,
        ...(key === undefined ? {} : { PERPLEXITY_API_KEY: key }),
      }),
    ).toBeNull();
  }
  // Clef still requires its own binding; a Perplexity key does not satisfy it.
  expect(
    aiConfiguration({
      ...base,
      AI_CLASSIFICATION_JSON: JSON.stringify(legacyClef),
      PERPLEXITY_API_KEY: "synthetic-key",
    }),
  ).toBeNull();
  expect(
    aiConfiguration({
      ...base,
      AI_CLASSIFICATION_JSON: JSON.stringify(legacyClef),
      AI: clefBinding,
    }),
  ).toMatchObject({ classification: legacyClef });
});

it("AI-CLASSIFIER-PROVIDER missing Perplexity key keeps mailbox processing not ready; a key alone makes it ready", () => {
  const bindings = {
    ...base,
    ...ready,
    AI_CLASSIFICATION_JSON: JSON.stringify(perplexity),
    AI: clefBinding,
    GMAIL_DISCOVERY_ENABLED: "true",
  };
  const missing = mailboxProcessingConfiguration(
    bindings as Parameters<typeof mailboxProcessingConfiguration>[0],
  );
  expect(missing.ai).toBeNull();
  expect(missing.providers).toEqual([]);
  const { AI: _unused, ...withoutBinding } = bindings;
  const configured = mailboxProcessingConfiguration({
    ...withoutBinding,
    PERPLEXITY_API_KEY: "synthetic-key",
  } as Parameters<typeof mailboxProcessingConfiguration>[0]);
  expect(configured.ai?.classification).toEqual(perplexity);
});

it("AI-CLASSIFIER-PROVIDER switching provider changes the reviewed processing digest", async () => {
  const clefDigest = await selectedOnboardingConfigurationDigest({
    ...selection,
    classification: receiptClassificationConfigurationSchema.parse(legacyClef),
  });
  const perplexityDigest = await selectedOnboardingConfigurationDigest({
    ...selection,
    classification: receiptClassificationConfigurationSchema.parse(perplexity),
  });
  expect(perplexityDigest).not.toBe(clefDigest);
  const otherModel = await selectedOnboardingConfigurationDigest({
    ...selection,
    classification: receiptClassificationConfigurationSchema.parse({
      ...perplexity,
      model: "pplx-decider-v1-27b",
    }),
  });
  expect(otherModel).not.toBe(perplexityDigest);
});

it("AI-CLASSIFIER-PROVIDER disclosure names the actual processor without inventing retention terms", () => {
  const clef = receiptClassificationConfigurationSchema.parse(legacyClef);
  const pplx = receiptClassificationConfigurationSchema.parse(perplexity);
  expect(receiptClassifierNotice(clef)).toEqual(RECEIPT_CLASSIFIER_NOTICE);
  const notice = receiptClassifierNotice(pplx);
  expect(notice.id).not.toBe(RECEIPT_CLASSIFIER_NOTICE.id);
  expect(notice.displayName).toContain("Perplexity");
  expect(notice.displayName).toContain("Decisions API");
  expect(notice.dataUseSummary).toContain(
    "Each readable document, including locally converted PDF text, is sent to Perplexity",
  );
  expect(notice.dataUseSummary).not.toMatch(/Cloudflare|Clef/);
  expect(notice.retentionSummary).toContain("does not publish");
  expect(`${notice.dataUseSummary} ${notice.retentionSummary}`).not.toMatch(
    /does not train|not train|deleted after|retain(?:s|ed)? for|zero retention/i,
  );
  expect(notice.privacyUrl).toBe(
    "https://docs.perplexity.ai/docs/decisions/quickstart",
  );
});
