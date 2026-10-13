import { expect, it } from "vitest";
import preset from "../../../config/ai.abacus.production.json";
import {
  aiConfiguration,
  aiDestinationSchema,
} from "../../../packages/adapters/src/ai/configuration";
import { selectedOnboardingConfigurationDigest } from "../../../packages/adapters/src/onboarding/configuration";

const classification = {
  enabled: true,
  model: "@cf/cloudflare/clef",
  version: "receipt-classification-v1",
  maxInputBytes: 24000,
  timeoutMs: 1000,
  negativeThreshold: 0.1,
  categoryThreshold: 0.5,
  pricing: {
    version: "synthetic-clef-v1",
    approved: true,
    currency: "USD",
    source: "https://prices.example.invalid/clef",
    checkedAt: "2026-10-13T00:00:00Z",
    inputUsdMicrosPerMillion: "240000",
    outputUsdMicrosPerMillion: "0",
    otherUsdMicrosPerMillion: "0",
  },
} as const;
const bindings = {
  AI_ENABLED: "true",
  AI_REGISTRY_JSON: JSON.stringify(preset.registry),
  AI_BUDGET_JSON: JSON.stringify(preset.budget),
  CREDENTIAL_KEYRING: JSON.stringify({
    activeVersion: 1,
    keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  }),
  AI_CLASSIFICATION_JSON: JSON.stringify(classification),
  AI: {
    async run() {
      throw new Error("NO_NETWORK_ALLOWED");
    },
  },
};
it("CLEF-02 parses configured classification and rejects a missing binding", () => {
  expect(aiConfiguration(bindings)).toMatchObject({ classification });
  expect(aiConfiguration({ ...bindings, AI: undefined })).toBeNull();
});
it("CLEF-02 disabling classification preserves the existing inference configuration", () => {
  expect(
    aiConfiguration({
      ...bindings,
      AI: undefined,
      AI_CLASSIFICATION_ENABLED: "false",
    }),
  ).not.toBeNull();
});
it("CLEF-02 adding or changing a classifier invalidates previous processing consent", async () => {
  const destination = aiDestinationSchema.parse(preset.registry[0]);
  const model = destination.models[0];
  if (!model) throw new Error("INVALID_SYNTHETIC_MODEL");
  const selection = {
    mode: "hosted" as const,
    settingsRevision: 1,
    destination,
    model,
  };
  const previous = await selectedOnboardingConfigurationDigest(selection);
  const selected = await selectedOnboardingConfigurationDigest({
    ...selection,
    classification,
  } as Parameters<typeof selectedOnboardingConfigurationDigest>[0]);
  expect(selected).not.toBe(previous);
  const changed = await selectedOnboardingConfigurationDigest({
    ...selection,
    classification: { ...classification, negativeThreshold: 0.05 },
  } as Parameters<typeof selectedOnboardingConfigurationDigest>[0]);
  expect(changed).not.toBe(selected);
});
