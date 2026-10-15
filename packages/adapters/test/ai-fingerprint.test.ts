import { EXTRACTION_PROMPT_VERSION } from "@invoxim/contracts";
import { EMAIL_CLASSIFICATION_VERSION } from "@invoxim/core";
import { expect, it } from "vitest";
import { computeRunFingerprint } from "../src/ai/budget";
import { computeClassificationFingerprint } from "../src/ai/classifier-factory";
import { computeAiFingerprint } from "../src/ai/configuration";

/**
 * AI-2 / P0.7 / A1: the fingerprint recipe exists in three places
 * (configuration.ts, classifier-factory.ts, budget.ts). All three must
 * produce byte-identical output for equivalent inputs or stored
 * fingerprints will fail verification.
 */
it("AI-2 A1 extraction fingerprint: configuration and budget agree byte-identically", async () => {
  const shared = {
    mode: "byok" as const,
    configurationDigest: "digest-abc123",
    settingsRevision: 7,
    generation: 3,
    credentialVersion: 11,
    policyVersion: 42,
    consentId: "consent-xyz",
    promptVersion: EXTRACTION_PROMPT_VERSION,
    classificationAuthorization: false,
  };
  const fromConfig = await computeAiFingerprint({
    mode: shared.mode,
    configurationDigest: shared.configurationDigest,
    settingsRevision: shared.settingsRevision,
    generation: shared.generation,
    credentialVersion: shared.credentialVersion,
    policyVersion: shared.policyVersion,
    consentId: shared.consentId,
  });
  const fromBudget = await computeRunFingerprint(shared);
  expect(fromBudget).toBe(fromConfig);
});

it("AI-2 A1 classification fingerprint: classifier-factory and budget agree byte-identically", async () => {
  const shared = {
    configurationDigest: "digest-classify-1",
    settingsRevision: 5,
    generation: 2,
    credentialVersion: 9,
    policyVersion: 17,
  };
  const fromClassifier = await computeClassificationFingerprint(shared);
  const fromBudget = await computeRunFingerprint({
    mode: "hosted",
    configurationDigest: shared.configurationDigest,
    settingsRevision: shared.settingsRevision,
    generation: shared.generation,
    credentialVersion: shared.credentialVersion,
    policyVersion: shared.policyVersion,
    consentId: "ignored-when-classification",
    promptVersion: EMAIL_CLASSIFICATION_VERSION,
    classificationAuthorization: true,
  });
  expect(fromBudget).toBe(fromClassifier);
});

it("AI-2 A1 all three recipes produce the same digest for identical tuples", async () => {
  const shared = {
    mode: "hosted" as const,
    configurationDigest: "digest-unified",
    settingsRevision: 1,
    generation: 0,
    credentialVersion: 1,
    policyVersion: 1,
    consentId: "consent-1",
    promptVersion: EXTRACTION_PROMPT_VERSION,
    classificationAuthorization: false,
  };
  const fromConfig = await computeAiFingerprint({
    mode: shared.mode,
    configurationDigest: shared.configurationDigest,
    settingsRevision: shared.settingsRevision,
    generation: shared.generation,
    credentialVersion: shared.credentialVersion,
    policyVersion: shared.policyVersion,
    consentId: shared.consentId,
  });
  const fromBudget = await computeRunFingerprint(shared);
  expect(fromConfig).toBe(fromBudget);
  expect(fromConfig).toMatch(/^[0-9a-f]{64}$/);
});

/**
 * Golden vectors: literal digests computed from the three independent
 * pre-AI-4 recipes at commit bd44e09 (parent of b6bdaba "AI-4"). Wrapper
 * parity alone cannot detect a change made inside the shared tuple builder;
 * these pin the stored-fingerprint bytes so persisted extractions,
 * classifications and BYOK runs keep verifying.
 */
const PRE_AI4_GOLDEN = {
  extraction:
    "7ba664031199553b24b265c5c0beba154fd281a2885d797e3095a7415a9ebd51",
  byok: "7312195c90c33616f52e1709d521134b98fe20607cb1a2f08ac14a750dae9389",
  classification:
    "5664b5ab32262bc6643a396fff5f2b1390833529edf4baf9d7012f1c5c0c4d7b",
} as const;

it("AI-4 golden: hosted extraction fingerprint equals the pre-AI-4 literal digest", async () => {
  expect(EXTRACTION_PROMPT_VERSION).toBe("invoice-extraction-v6");
  const tuple = {
    mode: "hosted" as const,
    configurationDigest: "digest-unified",
    settingsRevision: 1,
    generation: 0,
    credentialVersion: 1,
    policyVersion: 1,
    consentId: "consent-1",
  };
  expect(await computeAiFingerprint(tuple)).toBe(PRE_AI4_GOLDEN.extraction);
  expect(
    await computeRunFingerprint({
      ...tuple,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      classificationAuthorization: false,
    }),
  ).toBe(PRE_AI4_GOLDEN.extraction);
});

it("AI-4 golden: BYOK extraction fingerprint equals the pre-AI-4 literal digest", async () => {
  const tuple = {
    mode: "byok" as const,
    configurationDigest: "digest-abc123",
    settingsRevision: 7,
    generation: 3,
    credentialVersion: 11,
    policyVersion: 42,
    consentId: "consent-xyz",
  };
  expect(await computeAiFingerprint(tuple)).toBe(PRE_AI4_GOLDEN.byok);
  expect(
    await computeRunFingerprint({
      ...tuple,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      classificationAuthorization: false,
    }),
  ).toBe(PRE_AI4_GOLDEN.byok);
  expect(PRE_AI4_GOLDEN.byok).not.toBe(PRE_AI4_GOLDEN.extraction);
});

it("AI-4 golden: classification fingerprint equals the pre-AI-4 literal digest", async () => {
  expect(EMAIL_CLASSIFICATION_VERSION).toBe("email-classification-v1");
  const tuple = {
    configurationDigest: "digest-classify-1",
    settingsRevision: 5,
    generation: 2,
    credentialVersion: 9,
    policyVersion: 17,
  };
  expect(await computeClassificationFingerprint(tuple)).toBe(
    PRE_AI4_GOLDEN.classification,
  );
  expect(
    await computeRunFingerprint({
      ...tuple,
      mode: "hosted",
      consentId: "ignored-when-classification",
      promptVersion: EMAIL_CLASSIFICATION_VERSION,
      classificationAuthorization: true,
    }),
  ).toBe(PRE_AI4_GOLDEN.classification);
});
