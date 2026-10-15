import { z } from "zod";
import { CLEF_DESTINATION_ID, CLEF_MODEL_ID } from "./clef-protocol";
import {
  PERPLEXITY_DECIDER_MODELS,
  PERPLEXITY_DESTINATION_ID,
} from "./perplexity-decider";
import { aiPricingSchema } from "./pricing";

/**
 * Shared decision policy fields; the provider selects only a code-owned
 * transport and one of its literal model ids. Key order is the historical
 * Clef order because the parsed value is hashed into consent digests.
 */
function variant<P extends z.ZodType, M extends z.ZodType>(
  provider: P,
  model: M,
) {
  return z.strictObject({
    enabled: z.boolean(),
    model,
    version: z.string().min(1).max(120),
    maxInputBytes: z.number().int().min(100).max(24000),
    timeoutMs: z.number().int().min(100).max(30000),
    negativeThreshold: z.number().min(0).max(0.1),
    positiveThreshold: z.number().min(0.5).max(1).optional(),
    uncertainAction: z.enum(["review", "extract"]).optional(),
    categoryThreshold: z.number().min(0.5).max(1),
    // Both destinations publish input-only tariffs: no output or request fee.
    pricing: aiPricingSchema.extend({
      outputUsdMicrosPerMillion: z.literal("0"),
      otherUsdMicrosPerMillion: z.literal("0"),
    }),
    provider,
  });
}
/**
 * Back-compat: a configuration without `provider` is Cloudflare Clef. The
 * parsed value keeps the absent key, so existing Clef consent digests and
 * classification fingerprints stay byte-identical (pinned by a golden test).
 */
const clefSchema = variant(
  z.literal(CLEF_DESTINATION_ID).optional(),
  z.literal(CLEF_MODEL_ID),
);
const perplexitySchema = variant(
  z.literal(PERPLEXITY_DESTINATION_ID),
  z.enum(PERPLEXITY_DECIDER_MODELS),
);
export const receiptClassificationConfigurationSchema = z.union([
  clefSchema,
  perplexitySchema,
]);
export type ReceiptClassificationConfiguration = z.infer<
  typeof receiptClassificationConfigurationSchema
>;
export type ClassificationProvider =
  | typeof CLEF_DESTINATION_ID
  | typeof PERPLEXITY_DESTINATION_ID;
/** The destination id recorded on usage, caches and disclosures. */
export function classificationProvider(
  configuration: ReceiptClassificationConfiguration,
): ClassificationProvider {
  return configuration.provider ?? CLEF_DESTINATION_ID;
}
/** Every code-owned classification destination/model pair (meter and recovery guards). */
export const CLASSIFICATION_DESTINATIONS: readonly {
  readonly destinationId: ClassificationProvider;
  readonly modelIds: readonly string[];
}[] = [
  { destinationId: CLEF_DESTINATION_ID, modelIds: [CLEF_MODEL_ID] },
  {
    destinationId: PERPLEXITY_DESTINATION_ID,
    modelIds: PERPLEXITY_DECIDER_MODELS,
  },
];
export function isClassificationDestination(
  destinationId: string,
  modelId: string,
): boolean {
  return CLASSIFICATION_DESTINATIONS.some(
    (entry) =>
      entry.destinationId === destinationId && entry.modelIds.includes(modelId),
  );
}
