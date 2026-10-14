import { expect, it } from "vitest";
import {
  issueWorkspaceMutationToken,
  verifyWorkspaceMutationToken,
} from "../../../packages/adapters/src/corrections/workspace-token";
import { createFxPeriodSigning } from "../../../packages/adapters/src/fx/period-signing";
import {
  signReview,
  verifyReview,
} from "../../../packages/adapters/src/onboarding/token";

/**
 * Golden tokens pin each domain's wire format byte-for-byte (SEC-1). The
 * secret, payload and clock are fixed, so every domain's token string is a
 * constant. These pass before and after the shared signToken/verifyToken
 * extraction; a regression in the signed message, the body encoding or the
 * signature encoding shows up as a changed token string.
 */
const secret = "synthetic-golden-token-secret-032";

const reviewPayload = {
  userId: "synthetic-user",
  sessionId: "synthetic-session",
  connectionId: "synthetic-connection",
  provider: "gmail" as const,
  scopeDigest: "a".repeat(64),
  generation: 1,
  credentialVersion: 0,
  profileVersion: 1,
  aiSettingsRevision: 0,
  selectedAiSettingsRevision: 1,
  configurationDigest: "b".repeat(64),
  startDate: "2026-01-01",
  endDate: "2026-01-31",
  startMs: 1767225600000,
  cutoffMs: 1769817600000,
  timezone: "UTC",
  reportingCurrency: "USD",
  expiresAt: 1798761600000,
};
const goldenReviewToken =
  "eyJ1c2VySWQiOiJzeW50aGV0aWMtdXNlciIsInNlc3Npb25JZCI6InN5bnRoZXRpYy1zZXNzaW9uIiwiY29ubmVjdGlvbklkIjoic3ludGhldGljLWNvbm5lY3Rpb24iLCJwcm92aWRlciI6ImdtYWlsIiwic2NvcGVEaWdlc3QiOiJhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhIiwiZ2VuZXJhdGlvbiI6MSwiY3JlZGVudGlhbFZlcnNpb24iOjAsInByb2ZpbGVWZXJzaW9uIjoxLCJhaVNldHRpbmdzUmV2aXNpb24iOjAsInNlbGVjdGVkQWlTZXR0aW5nc1JldmlzaW9uIjoxLCJjb25maWd1cmF0aW9uRGlnZXN0IjoiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiIsInN0YXJ0RGF0ZSI6IjIwMjYtMDEtMDEiLCJlbmREYXRlIjoiMjAyNi0wMS0zMSIsInN0YXJ0TXMiOjE3NjcyMjU2MDAwMDAsImN1dG9mZk1zIjoxNzY5ODE3NjAwMDAwLCJ0aW1lem9uZSI6IlVUQyIsInJlcG9ydGluZ0N1cnJlbmN5IjoiVVNEIiwiZXhwaXJlc0F0IjoxNzk4NzYxNjAwMDAwfQ.sUsBFHndHeD65st64Gjlw6OJFg31Q1pvUdDXxgkowlQ";
const goldenDisclosure =
  "5493dbd384c51be30df20f865bfddfdbe4d718f1c31be32d808292592be8ca72";

const workspaceIdentity = {
  userId: "synthetic-user",
  sessionId: "synthetic-session",
};
const goldenWorkspaceToken =
  "eyJ2ZXJzaW9uIjoxLCJwdXJwb3NlIjoiY29ycmVjdGlvbnMiLCJ1c2VySWQiOiJzeW50aGV0aWMtdXNlciIsInNlc3Npb25JZCI6InN5bnRoZXRpYy1zZXNzaW9uIiwiZXhwaXJlc0F0IjoxNzkxODUwMjAwMDAwfQ.rpikBNa2RljGhg5x-YgQGTu_cnPavxol4gq9RnWxgNE";

const fxPayload = '{"start":"2026-01-01","end":"2026-01-31"}';
const goldenFxToken =
  "eyJzdGFydCI6IjIwMjYtMDEtMDEiLCJlbmQiOiIyMDI2LTAxLTMxIn0.uTBvfVQDMP7sUEniDfjGMFTxdkQQ-pn30dzl-cFNyFU";

it("onboarding review tokens keep their golden wire format", async () => {
  const signed = await signReview(reviewPayload, secret);
  expect(signed.reviewToken).toBe(goldenReviewToken);
  expect(signed.disclosureVersion).toBe(goldenDisclosure);
  expect(await verifyReview(goldenReviewToken, secret)).toMatchObject({
    userId: reviewPayload.userId,
    sessionId: reviewPayload.sessionId,
    connectionId: reviewPayload.connectionId,
  });
});

it("workspace mutation tokens keep their golden wire format", async () => {
  const token = await issueWorkspaceMutationToken(
    workspaceIdentity,
    secret,
    () => 1791849600000,
    "corrections",
  );
  expect(token).toBe(goldenWorkspaceToken);
  expect(
    await verifyWorkspaceMutationToken(
      goldenWorkspaceToken,
      workspaceIdentity,
      secret,
      () => 1791849600000,
      "corrections",
    ),
  ).toBe(true);
});

it("fx period tokens keep their golden wire format", async () => {
  const signing = createFxPeriodSigning(secret);
  expect(await signing.sign(fxPayload)).toBe(goldenFxToken);
  expect(await signing.verify(goldenFxToken)).toBe(fxPayload);
});

it("golden tokens do not verify under another secret", async () => {
  const other = "synthetic-golden-token-secret-999";
  await expect(verifyReview(goldenReviewToken, other)).rejects.toThrow();
  expect(
    await verifyWorkspaceMutationToken(
      goldenWorkspaceToken,
      workspaceIdentity,
      other,
      () => 1791849600000,
      "corrections",
    ),
  ).toBe(false);
  expect(await createFxPeriodSigning(other).verify(goldenFxToken)).toBe(null);
});
