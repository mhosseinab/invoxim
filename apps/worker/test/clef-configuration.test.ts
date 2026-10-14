import { expect, it } from "vitest";
import preset from "../../../config/ai.abacus.production.json";
import { receiptClassificationConfigurationSchema } from "../../../packages/adapters/src/ai/clef";
import {
  aiConfiguration,
  aiDestinationSchema,
  selectedAiConfigurationDigest,
} from "../../../packages/adapters/src/ai/configuration";
import {
  LOCAL_PARSER_POLICY,
  onboardingConfigurationDigest,
  RECEIPT_CLASSIFIER_NOTICE,
  selectedOnboardingConfigurationDigest,
} from "../../../packages/adapters/src/onboarding/configuration";

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
it("CLEF-02 disabling mandatory classification makes processing unavailable", () => {
  expect(
    aiConfiguration({
      ...bindings,
      AI: undefined,
      AI_CLASSIFICATION_ENABLED: "false",
    }),
  ).toBeNull();
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

it("AI-CLEF-PRECISION-01 positive policy rejects invalid or overlapping thresholds", () => {
  for (const positiveThreshold of [0.05, 0.1, 0.49, 1.01]) {
    expect(
      receiptClassificationConfigurationSchema.safeParse({
        ...classification,
        positiveThreshold,
      }).success,
    ).toBe(false);
  }
  expect(
    receiptClassificationConfigurationSchema.safeParse({
      ...classification,
      positiveThreshold: 0.9,
    }).success,
  ).toBe(true);
  expect(
    receiptClassificationConfigurationSchema.safeParse(classification).success,
  ).toBe(true);
});
it("AI-CLEF-PRECISION-01 changing the positive threshold invalidates consent", async () => {
  const destination = aiDestinationSchema.parse(preset.registry[0]);
  const model = destination.models[0];
  if (!model) throw new Error("INVALID_SYNTHETIC_MODEL");
  const selection = {
    mode: "hosted" as const,
    settingsRevision: 1,
    destination,
    model,
  };
  const before = await selectedOnboardingConfigurationDigest({
    ...selection,
    classification,
  });
  const after = await selectedOnboardingConfigurationDigest({
    ...selection,
    classification: { ...classification, positiveThreshold: 0.95 },
  });
  expect(after).not.toBe(before);
});

it("AI-CLEF-PRECISION-01 policy notice invalidates old custom-config consent even without a config version change", async () => {
  const destination = aiDestinationSchema.parse(preset.registry[0]);
  const model = destination.models[0];
  if (!model) throw new Error("INVALID_SYNTHETIC_MODEL");
  const selection = {
    mode: "hosted" as const,
    settingsRevision: 1,
    destination,
    model,
    classification,
  };
  const oldPolicyDigest = await onboardingConfigurationDigest({
    mode: selection.mode,
    settingsRevision: selection.settingsRevision,
    aiConfigurationDigest: await selectedAiConfigurationDigest(
      destination,
      model,
    ),
    classification,
    classificationNotice: {
      ...RECEIPT_CLASSIFIER_NOTICE,
      id: "cloudflare-clef-v1",
    },
    parser: LOCAL_PARSER_POLICY,
  });
  expect(await selectedOnboardingConfigurationDigest(selection)).not.toBe(
    oldPolicyDigest,
  );
});
