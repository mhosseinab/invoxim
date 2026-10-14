import { EXTRACTION_PROMPT_VERSION } from "@invoxim/contracts";
import { EMAIL_CLASSIFICATION_VERSION } from "@invoxim/core";
import { expect, it } from "vitest";
import { computeRunFingerprint } from "../../../packages/adapters/src/ai/budget";
import { computeClassificationFingerprint } from "../../../packages/adapters/src/ai/classifier-factory";
import {
  buildFingerprintTuple,
  computeAiFingerprint,
} from "../../../packages/adapters/src/ai/configuration";
import { hashJsonValue, sourceKey } from "../../../packages/adapters/src/hash";
import { sha256Hex } from "../../../packages/adapters/src/security/helpers";

/**
 * SW-1 / ext#15 / S6 / C13 / G10: stored fingerprints must stay byte-identical.
 * These goldens pin the hex wire format of every recipe that SW-1 collapses onto
 * one `sha256Hex` + one `sourceKey`. A change in encoding, JSON shape or tuple
 * order shows up here before it can corrupt persisted digests.
 */

const goldenEmptySha =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const goldenAbcSha =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const goldenJsonArraySha =
  "4ba661d8316a7121179158fc5b82ea7c757ac16d63cc4fb415a2970f357b9702";
const goldenExtractionFingerprint =
  "7312195c90c33616f52e1709d521134b98fe20607cb1a2f08ac14a750dae9389";
const goldenClassificationFingerprint =
  "5664b5ab32262bc6643a396fff5f2b1390833529edf4baf9d7012f1c5c0c4d7b";
const goldenOnboardingDigest =
  "32176379d151619df768b2087db32e7c1621be5f5d296242dea891b796c719cd";

it("sha256Hex keeps the lowercase hex wire format for text and bytes", async () => {
  expect(await sha256Hex("")).toBe(goldenEmptySha);
  expect(await sha256Hex("abc")).toBe(goldenAbcSha);
  expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(goldenAbcSha);
});

it("JSON-value hashing stays byte-identical (hashJsonValue)", async () => {
  expect(await hashJsonValue({ mode: "hosted", settingsRevision: 1 })).toBe(
    goldenOnboardingDigest,
  );
  expect(
    await hashJsonValue(["user-1", "conn-1", "msg-1"]),
  ).toBe(goldenJsonArraySha);
});

it("extraction fingerprint stays byte-identical across all three recipes", async () => {
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
  expect(buildFingerprintTuple(shared)).toEqual([
    "byok",
    "digest-abc123",
    7,
    3,
    11,
    42,
    "consent-xyz",
    EXTRACTION_PROMPT_VERSION,
    1,
  ]);
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
  expect(fromConfig).toBe(goldenExtractionFingerprint);
  expect(fromBudget).toBe(goldenExtractionFingerprint);
});

it("classification fingerprint stays byte-identical across both recipes", async () => {
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
  expect(fromClassifier).toBe(goldenClassificationFingerprint);
  expect(fromBudget).toBe(goldenClassificationFingerprint);
});

it("sourceKey format stays source:<hex>:<generation>", async () => {
  expect(await sourceKey("user-1", "conn-1", "msg-1", 7)).toBe(
    `source:${goldenJsonArraySha}:7`,
  );
});
