import { z } from "zod";
import { MINOR_BOUND, hasControlCharacters } from "./primitives";

const version = z.number().int().min(0).max(2147483646);
const identifier = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const aiModelIdentifierSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(
    /^(?:[A-Za-z0-9._:-]+|@[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*)$/,
  )
  .refine((value) => !hasControlCharacters(value));

export const aiSettingsRequestSchema = z.strictObject({
  version,
  mode: z.enum(["hosted", "byok"]),
  providerId: identifier,
  modelId: aiModelIdentifierSchema,
  acceptedPolicyVersion: z.number().int().min(1).max(2147483646),
  apiKey: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !hasControlCharacters(value))
    .optional(),
});
export const aiKeyDeleteRequestSchema = z.strictObject({ version });
export const aiTestRequestSchema = z.strictObject({ version });
export type AiSettingsRequest = z.infer<typeof aiSettingsRequestSchema>;
export type AiKeyDeleteRequest = z.infer<typeof aiKeyDeleteRequestSchema>;
export type AiTestRequest = z.infer<typeof aiTestRequestSchema>;

export const aiSettingsResponseSchema = z.strictObject({
  mutationToken: z.string().min(1).max(2048).optional(),
  version,
  mode: z.enum(["hosted", "byok"]).nullable(),
  providerId: identifier.nullable(),
  modelId: aiModelIdentifierSchema.nullable(),
  keyConfigured: z.boolean(),
  processingReviewRequired: z.literal(true),
  configured: z.boolean(),
  allowance: z.strictObject({
    dailyDocumentsRemaining: z.number().int().min(0).max(Number(MINOR_BOUND)),
    monthlyDocumentsRemaining: z.number().int().min(0).max(Number(MINOR_BOUND)),
    dailyUnitsRemaining: z.number().int().min(0).max(Number(MINOR_BOUND)),
    monthlyUnitsRemaining: z.number().int().min(0).max(Number(MINOR_BOUND)),
    hostedFundingAvailable: z.boolean(),
    cooldownActive: z.boolean(),
  }),
  availability: z.enum([
    "configuration",
    "budget",
    "rate-limit",
    "processing-review-required",
  ]),
  capabilities: z.strictObject({
    text: z.literal(true),
    image: z.literal(false),
    nativePdf: z.literal(false),
    jsonSchema: z.boolean(),
    jsonObject: z.boolean(),
  }),
  providers: z
    .array(
      z.strictObject({
        id: identifier,
        models: z.array(aiModelIdentifierSchema).min(1).max(10),
        policyVersion: z.number().int().min(1).max(2147483646),
        noticeRefs: z.array(identifier).min(1).max(10),
      }),
    )
    .max(10),
});
export type AiSettingsResponse = z.infer<typeof aiSettingsResponseSchema>;

export const aiTestResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("passed") }),
  z.strictObject({
    status: z.literal("failed"),
    reason: z.enum([
      "timeout",
      "rate-limit",
      "invalid-key",
      "unsupported",
      "refusal",
      "outage",
      "schema",
      "incomplete",
    ]),
  }),
]);
export type AiTestResponse = z.infer<typeof aiTestResponseSchema>;
