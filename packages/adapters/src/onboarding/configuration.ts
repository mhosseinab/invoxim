import { DOCUMENT_LIMITS } from "@invoxim/core";
import { z } from "zod";
import type { AiDestination, AiModel } from "../ai/configuration";
import { selectedAiConfigurationDigest } from "../ai/configuration";

/** Code-owned local parser policy: transient in-Worker processing, no remote converter. */
export const LOCAL_PARSER_POLICY = Object.freeze({
  providerId: "local-unpdf",
  version: "unpdf-1.8.1/uncompressed-v1",
  policyVersion: "local-parser-transient-v1",
  noticeRefs: ["local-parser-transient-v1"],
  limits: DOCUMENT_LIMITS,
});
const id = z.string().min(1).max(120);
export const configDigestInputsSchema = z.strictObject({
  mode: z.enum(["hosted", "byok"]),
  settingsRevision: z.number().int().min(1).max(2147483646),
  aiConfigurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  parser: z.strictObject({
    providerId: id,
    version: id,
    policyVersion: id,
    noticeRefs: z.array(id).min(1).max(10),
    limits: z.strictObject({
      bytes: z.number().int().positive(),
      parts: z.number().int().positive(),
      depth: z.number().int().positive(),
      pages: z.number().int().positive(),
      textCharacters: z.number().int().positive(),
    }),
  }),
});
export type ConfigDigestInputs = z.infer<typeof configDigestInputsSchema>;
export async function onboardingConfigurationDigest(
  input: ConfigDigestInputs,
): Promise<string> {
  return hashOnboardingValue(configDigestInputsSchema.parse(input));
}
export async function selectedOnboardingConfigurationDigest(input: {
  mode: "hosted" | "byok";
  settingsRevision: number;
  destination: AiDestination;
  model: AiModel;
}): Promise<string> {
  return onboardingConfigurationDigest({
    mode: input.mode,
    settingsRevision: input.settingsRevision,
    aiConfigurationDigest: await selectedAiConfigurationDigest(
      input.destination,
      input.model,
    ),
    parser: LOCAL_PARSER_POLICY,
  });
}
export async function hashOnboardingValue(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
