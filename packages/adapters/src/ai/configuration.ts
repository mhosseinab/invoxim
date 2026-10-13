import {
  EXTRACTION_PROMPT_VERSION,
  hasControlCharacters,
} from "@invoxim/contracts";
import { z } from "zod";
import type { AuthBindings } from "../auth/configuration";
import { createCredentialCipher } from "../security/cipher";

export interface AiBindings extends AuthBindings {
  AI_ENABLED?: string;
  AI_REGISTRY_JSON?: string;
  AI_HOSTED_DESTINATION?: string;
  AI_HOSTED_MODEL?: string;
  AI_HOSTED_KEY?: string;
  CREDENTIAL_KEYRING?: string;
  AI_BUDGET_JSON?: string;
}
const resourceLimit = z.number().int().min(1).max(9000000000000);
const monetaryLimit = z
  .string()
  .regex(/^[0-9]{1,13}$/)
  .refine((value) => BigInt(value) <= 9000000000000n);
const aiBudgetSchema = z.strictObject({
  dailyDocuments: resourceLimit,
  monthlyDocuments: resourceLimit,
  dailyUnits: resourceLimit,
  monthlyUnits: resourceLimit,
  globalDailyUsdMicros: monetaryLimit,
  globalMonthlyUsdMicros: monetaryLimit,
});
const identifier = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const approvedEndpointSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return (
        !hasControlCharacters(value) &&
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "" &&
        (url.port === "" || url.port === "443") &&
        /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) &&
        host.includes(".") &&
        !/^[0-9.]+$/.test(host) &&
        !host.endsWith(".localhost") &&
        !host.endsWith(".local") &&
        !host.endsWith(".internal") &&
        host !== "localhost"
      );
    } catch {
      return false;
    }
  });
const pricingSchema = z.strictObject({
  version: identifier,
  approved: z.literal(true),
  currency: z.literal("USD"),
  source: z
    .string()
    .url()
    .max(2048)
    .refine((value) => value.startsWith("https://")),
  checkedAt: z.iso.datetime(),
  inputUsdMicrosPerMillion: z.string().regex(/^[0-9]{1,15}$/),
  outputUsdMicrosPerMillion: z.string().regex(/^[0-9]{1,15}$/),
  otherUsdMicrosPerMillion: z.string().regex(/^[0-9]{1,15}$/),
});
export const aiModelSchema = z.strictObject({
  id: identifier,
  capabilities: z.strictObject({
    jsonSchema: z.boolean(),
    jsonObject: z.boolean(),
    outputLimit: z.enum(["max_tokens", "max_completion_tokens"]),
    usage: z.boolean(),
    idempotency: z.boolean(),
  }),
  pricing: pricingSchema,
});
const noticeText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0 && !hasControlCharacters(value));
export const aiNoticeSchema = z.strictObject({
  id: identifier,
  displayName: noticeText(120),
  dataUseSummary: noticeText(400),
  retentionSummary: noticeText(400),
  privacyUrl: approvedEndpointSchema,
});
export const aiDestinationSchema = z.strictObject({
  id: identifier,
  endpoint: approvedEndpointSchema,
  configVersion: identifier,
  policyVersion: z.number().int().min(1).max(2147483646),
  noticeRefs: z.array(identifier).min(1).max(10),
  notices: z
    .array(aiNoticeSchema)
    .max(10)
    .refine(
      (entries) =>
        new Set(entries.map((entry) => entry.id)).size === entries.length,
    )
    .optional(),
  models: z.array(aiModelSchema).min(1).max(10),
  timeoutMs: z.number().int().min(100).max(30000),
  maxInputBytes: z.number().int().min(1).max(96000),
  maxOutputBytes: z.number().int().min(1).max(65536),
  maxOutputTokens: z.number().int().min(1).max(16000),
});
export const aiRegistrySchema = z
  .array(aiDestinationSchema)
  .max(10)
  .superRefine((entries, ctx) => {
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
      ctx.addIssue({ code: "custom", message: "Duplicate destination" });
    for (const entry of entries)
      if (
        new Set(entry.models.map((model) => model.id)).size !==
        entry.models.length
      )
        ctx.addIssue({ code: "custom", message: "Duplicate model" });
  });
export type AiDestination = z.infer<typeof aiDestinationSchema>;
export type AiModel = z.infer<typeof aiModelSchema>;
const keyringSchema = z.strictObject({
  activeVersion: z.number().int().positive().max(2147483647),
  keys: z.record(z.string().regex(/^[1-9][0-9]*$/), z.string().min(1).max(100)),
});
export function aiConfiguration(bindings: AiBindings) {
  if (bindings.AI_ENABLED !== "true") return null;
  try {
    if ((bindings.AI_REGISTRY_JSON?.length ?? 0) > 32768) return null;
    const destinations = aiRegistrySchema.parse(
      JSON.parse(bindings.AI_REGISTRY_JSON ?? "null"),
    );
    const hosted = destinations.find(
      (entry) => entry.id === bindings.AI_HOSTED_DESTINATION,
    );
    const hostedModel = hosted?.models.find(
      (model) => model.id === bindings.AI_HOSTED_MODEL,
    );
    const key = bindings.AI_HOSTED_KEY;
    if (
      (key !== undefined &&
        (key.length === 0 || key.length > 4096 || hasControlCharacters(key))) ||
      ((bindings.AI_HOSTED_DESTINATION !== undefined ||
        bindings.AI_HOSTED_MODEL !== undefined ||
        key !== undefined) &&
        (!hosted || !hostedModel || !key))
    )
      return null;
    const keyring = keyringSchema.parse(
      JSON.parse(bindings.CREDENTIAL_KEYRING ?? "null"),
    );
    const cipher = createCredentialCipher(keyring);
    if ((bindings.AI_BUDGET_JSON?.length ?? 0) > 4096) return null;
    const budget = aiBudgetSchema.parse(
      JSON.parse(bindings.AI_BUDGET_JSON ?? "null"),
    );
    return {
      destinations,
      cipher,
      keyVersions: Object.keys(keyring.keys).map(Number),
      budget,
      hosted:
        hosted && hostedModel && key
          ? { destinationId: hosted.id, modelId: hostedModel.id, key }
          : null,
    };
  } catch {
    return null;
  }
}
export type AiConfiguration = NonNullable<ReturnType<typeof aiConfiguration>>;
export async function selectedAiConfigurationDigest(
  destination: AiDestination,
  model: AiModel,
) {
  const selectedDestination = {
    id: destination.id,
    endpoint: destination.endpoint,
    configVersion: destination.configVersion,
    policyVersion: destination.policyVersion,
    noticeRefs: destination.noticeRefs,
    ...(destination.notices ? { notices: destination.notices } : {}),
    timeoutMs: destination.timeoutMs,
    maxInputBytes: destination.maxInputBytes,
    maxOutputBytes: destination.maxOutputBytes,
    maxOutputTokens: destination.maxOutputTokens,
  };
  return hashAiValue({ destination: selectedDestination, model });
}
async function hashAiValue(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export async function computeAiFingerprint(input: {
  mode: "hosted" | "byok";
  configurationDigest: string;
  settingsRevision: number;
  generation: number;
  credentialVersion: number;
  policyVersion: number;
  consentId: string;
}) {
  return hashAiValue([
    input.mode,
    input.configurationDigest,
    input.settingsRevision,
    input.generation,
    input.credentialVersion,
    input.policyVersion,
    input.consentId,
    EXTRACTION_PROMPT_VERSION,
    1,
  ]);
}
