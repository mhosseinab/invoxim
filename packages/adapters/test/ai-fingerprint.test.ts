import { EXTRACTION_PROMPT_VERSION } from "@invoxim/contracts";
import { EMAIL_CLASSIFICATION_VERSION } from "@invoxim/core";
import { expect, it } from "vitest";
import { computeClassificationFingerprint } from "../src/ai/classifier-factory";
import { computeRunFingerprint } from "../src/ai/budget";
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
