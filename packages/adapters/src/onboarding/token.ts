import { OnboardingError } from "@invoxim/core";
import { z } from "zod";
import { hashOnboardingValue } from "./configuration";
import { signToken, verifyToken, type TokenDomain } from "../security/token";

/** Historical review domain: signs the decoded JSON payload (S2). */
const reviewDomain: TokenDomain = {
  prefix: "invoxim.onboarding.review.v1:",
  signs: "payload",
};
export const reviewPayloadSchema = z.strictObject({
  userId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  connectionId: z.string().min(1).max(120),
  provider: z.enum(["gmail", "outlook"]),
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  credentialVersion: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  profileVersion: z.number().int().positive().max(2147483646),
  aiSettingsRevision: z.number().int().nonnegative().max(2147483646),
  selectedAiSettingsRevision: z.number().int().positive().max(2147483646),
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  startDate: z.string(),
  endDate: z.string(),
  startMs: z.number().int().nonnegative(),
  cutoffMs: z.number().int().nonnegative(),
  timezone: z.string(),
  reportingCurrency: z.string(),
  expiresAt: z.number().int().nonnegative(),
});
export type ReviewPayload = z.infer<typeof reviewPayloadSchema>;
export async function signReview(payload: ReviewPayload, secret: string) {
  const checked = reviewPayloadSchema.parse(payload),
    json = JSON.stringify(checked);
  return {
    reviewToken: await signToken(reviewDomain, json, secret),
    disclosureVersion: await hashOnboardingValue(checked),
  };
}
export async function verifyReview(
  token: string,
  secret: string,
): Promise<ReviewPayload> {
  try {
    if (token.length > 4096) throw new Error("bounded");
    const json = await verifyToken(reviewDomain, token, secret);
    if (json === null) throw new Error("signature");
    return reviewPayloadSchema.parse(JSON.parse(json));
  } catch {
    throw new OnboardingError("PROCESSING_REVIEW_REQUIRED");
  }
}
