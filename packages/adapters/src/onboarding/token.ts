import { OnboardingError } from "@invoxim/core";
import { z } from "zod";
import { hashOnboardingValue } from "./configuration";

const domain = "invoxim.onboarding.review.v1:";
export const reviewPayloadSchema = z.strictObject({
  userId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  connectionId: z.string().min(1).max(120),
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
function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new OnboardingError("PROCESSING_REVIEW_REQUIRED");
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (char) => char.charCodeAt(0),
  );
}
async function signingKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function signReview(payload: ReviewPayload, secret: string) {
  const checked = reviewPayloadSchema.parse(payload),
    json = JSON.stringify(checked),
    bytes = new TextEncoder().encode(domain + json);
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    bytes,
  );
  return {
    reviewToken: `${encode(new TextEncoder().encode(json))}.${encode(new Uint8Array(signature))}`,
    disclosureVersion: await hashOnboardingValue(checked),
  };
}
export async function verifyReview(
  token: string,
  secret: string,
): Promise<ReviewPayload> {
  try {
    if (token.length > 4096) throw new Error("bounded");
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("shape");
    const json = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(decode(parts[0]));
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret),
      decode(parts[1]),
      new TextEncoder().encode(domain + json),
    );
    if (!valid) throw new Error("signature");
    return reviewPayloadSchema.parse(JSON.parse(json));
  } catch {
    throw new OnboardingError("PROCESSING_REVIEW_REQUIRED");
  }
}
