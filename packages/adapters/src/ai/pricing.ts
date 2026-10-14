import { z } from "zod";

/**
 * One pricing snapshot shape (A5). Registry models, Clef classification and
 * budget verification all describe the same approved USD micro-price fields.
 */
export const aiPricingSchema = z.strictObject({
  version: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9._:-]+$/),
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
export type AiPricing = Readonly<z.infer<typeof aiPricingSchema>>;
