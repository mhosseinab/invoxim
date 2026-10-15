import {
  aiModelIdentifierSchema,
  EXTRACTION_PROMPT_VERSION,
  hasControlCharacters,
} from "@invoxim/contracts";
import { EMAIL_CLASSIFICATION_VERSION } from "@invoxim/core";
import { z } from "zod";
import type { AuthBindings } from "../auth/configuration";
import { hashJsonValue } from "../hash";
import { createCredentialCipher } from "../security/cipher";
import type { ClefBinding } from "./clef";
import { receiptClassificationConfigurationSchema } from "./clef";
import { aiPricingSchema } from "./pricing";
import type { AiTracingBindings } from "./tracing";
import { langsmithConfiguration } from "./tracing";

export interface AiBindings extends AuthBindings, AiTracingBindings {
  AI_ENABLED?: string;
  AI_REGISTRY_JSON?: string;
  AI_HOSTED_DESTINATION?: string;
  AI_HOSTED_MODEL?: string;
  AI_HOSTED_KEY?: string;
  CREDENTIAL_KEYRING?: string;
  AI_BUDGET_JSON?: string;
  AI_CLASSIFICATION_JSON?: string;
  AI_CLASSIFICATION_ENABLED?: string;
  AI?: ClefBinding | undefined;
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
export const aiModelSchema = z.strictObject({
  id: aiModelIdentifierSchema,
  capabilities: z.strictObject({
    jsonSchema: z.boolean(),
    jsonObject: z.boolean(),
    outputLimit: z.enum(["max_tokens", "max_completion_tokens"]),
    usage: z.boolean(),
    idempotency: z.boolean(),
  }),
  pricing: aiPricingSchema,
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
const aiRegistrySchema = z
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
    if ((bindings.AI_CLASSIFICATION_JSON?.length ?? 0) > 4096) return null;
    const classification =
      bindings.AI_CLASSIFICATION_ENABLED !== "false" &&
      bindings.AI_CLASSIFICATION_JSON
        ? receiptClassificationConfigurationSchema.parse(
            JSON.parse(bindings.AI_CLASSIFICATION_JSON),
          )
        : undefined;
    if (
      !classification?.enabled ||
      !bindings.AI ||
      typeof bindings.AI.run !== "function"
    )
      return null;
    const tracing = langsmithConfiguration(bindings);
    return {
      ...(tracing ? { tracing } : {}),
      classification,
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
  return hashJsonValue({ destination: selectedDestination, model });
}
/**
 * AI run fingerprint tuple (A1). The single recipe behind extraction,
 * classification, and budget verification — must stay byte-identical.
 */
export function buildFingerprintTuple(input: {
  mode: "hosted" | "byok";
  configurationDigest: string;
  settingsRevision: number;
  generation: number;
  credentialVersion: number;
  policyVersion: number;
  consentId: string;
  promptVersion: string;
  classificationAuthorization: boolean;
}) {
  return [
    input.mode,
    input.configurationDigest,
    input.settingsRevision,
    input.generation,
    input.credentialVersion,
    input.policyVersion,
    input.classificationAuthorization
      ? EMAIL_CLASSIFICATION_VERSION
      : input.consentId,
    input.promptVersion,
    1,
  ];
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
  return hashJsonValue(
    buildFingerprintTuple({
      ...input,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      classificationAuthorization: false,
    }),
  );
}
