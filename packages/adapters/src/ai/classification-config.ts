import { z } from "zod";
import { CLEF_MODEL_ID } from "./clef-protocol";
import { aiPricingSchema } from "./pricing";

export const receiptClassificationConfigurationSchema = z.strictObject({
  enabled: z.boolean(),
  model: z.literal(CLEF_MODEL_ID),
  version: z.string().min(1).max(120),
  maxInputBytes: z.number().int().min(100).max(24000),
  timeoutMs: z.number().int().min(100).max(30000),
  negativeThreshold: z.number().min(0).max(0.1),
  positiveThreshold: z.number().min(0.5).max(1).optional(),
  uncertainAction: z.enum(["review", "extract"]).optional(),
  categoryThreshold: z.number().min(0.5).max(1),
  pricing: aiPricingSchema.extend({
    outputUsdMicrosPerMillion: z.literal("0"),
    otherUsdMicrosPerMillion: z.literal("0"),
  }),
});
export type ReceiptClassificationConfiguration = z.infer<
  typeof receiptClassificationConfigurationSchema
>;
