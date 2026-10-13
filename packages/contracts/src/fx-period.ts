import { z } from "zod";
import { fxCurrencySchema, fxUnconvertedReasonSchema } from "./fx";
import { hasControlCharacters } from "./primitives";
import { purchaseFiltersSchema } from "./purchases";

const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(100);
const signed = z
  .string()
  .regex(/^(0|-?[1-9][0-9]*)$/)
  .max(100);
const token = z
  .string()
  .min(1)
  .max(16384)
  .refine((v) => !hasControlCharacters(v));
export const fxPeriodRequestSchema = z.strictObject({
  filters: purchaseFiltersSchema,
  stamp: token.optional(),
  continuation: token.optional(),
});
export const fxPeriodSummarySchema = z
  .strictObject({
    paidMinor: decimal,
    refundedMinor: decimal,
    netMinor: signed,
    convertedCount: decimal,
    pendingCount: decimal,
    unconvertedCount: decimal,
    reasons: z.partialRecord(fxUnconvertedReasonSchema, decimal),
  })
  .refine(
    (v) =>
      BigInt(v.paidMinor) - BigInt(v.refundedMinor) === BigInt(v.netMinor) &&
      Object.values(v.reasons).reduce(
        (total, count) => total + BigInt(count),
        0n,
      ) === BigInt(v.unconvertedCount),
  );
export const fxPeriodResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("in_progress"),
    stamp: token,
    continuation: token,
  }),
  z.strictObject({
    status: z.literal("complete"),
    stamp: token,
    summaryScope: z.literal("period"),
    reportingCurrency: fxCurrencySchema,
    summary: fxPeriodSummarySchema,
  }),
]);
export type FxPeriodSummary = z.infer<typeof fxPeriodSummarySchema>;
