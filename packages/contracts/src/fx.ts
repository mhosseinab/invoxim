import { z } from "zod";
import {
  MINOR_BOUND,
  fxRateDecimal,
  hasControlCharacters,
  supportedCurrency,
  validCalendarDate,
} from "./primitives";

export const fxCalculationVersion = "fx-v1" as const;
export const fxMaxConvertedMinor = "9223372036854775807";
export const fxCurrencySchema = supportedCurrency;
const date = z.string().refine(validCalendarDate);
const identifier = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !hasControlCharacters(value));
const publicIdentifier = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => value.trim() === value && !hasControlCharacters(value));
const magnitude = z
  .string()
  .max(13)
  .regex(/^(?:0|[1-9][0-9]*)$/)
  .pipe(z.string().refine((value) => BigInt(value) <= MINOR_BOUND));
const signedInteger = z
  .string()
  .max(48)
  .regex(/^(?:0|-?[1-9][0-9]*)$/);
const convertedMinor = signedInteger.pipe(
  z.string().refine((value) => {
    const minor = BigInt(value);
    return (
      minor >= -BigInt(fxMaxConvertedMinor) &&
      minor <= BigInt(fxMaxConvertedMinor)
    );
  }),
);

export const fxEntrySchema = z
  .object({
    id: identifier,
    kind: z.enum(["payment", "refund"]),
    amountMinor: magnitude,
    currency: fxCurrencySchema,
    eventDate: date,
  })
  .strict();
export const fxRateRequestSchema = z
  .object({
    fromCurrency: fxCurrencySchema,
    toCurrency: fxCurrencySchema,
    requestedDate: date,
  })
  .strict();
export const fxRateQuoteSchema = fxRateRequestSchema
  .extend({
    effectiveDate: date,
    rate: fxRateDecimal,
    source: publicIdentifier,
    version: publicIdentifier,
    retrievedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const fxConversionPolicySchema = z
  .object({
    source: publicIdentifier,
    maxPriorAgeDays: z.number().int().min(0).max(31),
  })
  .strict();
export const fxUnconvertedReasonSchema = z.enum([
  "rate_missing",
  "currency_unsupported",
  "rate_future",
  "rate_stale",
  "quote_mismatch",
  "source_mismatch",
  "invalid_quote",
  "magnitude_overflow",
]);
const converted = z
  .object({
    status: z.literal("converted"),
    entry: fxEntrySchema,
    reportingCurrency: fxCurrencySchema,
    signedMinor: convertedMinor,
    calculationVersion: z.literal(fxCalculationVersion),
    basis: z.enum(["identity", "reference"]),
    quote: fxRateQuoteSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !convertedMinor.safeParse(value.signedMinor).success ||
      !fxEntrySchema.safeParse(value.entry).success
    )
      return;
    const known =
      supportedCurrency.safeParse(value.entry.currency).success &&
      supportedCurrency.safeParse(value.reportingCurrency).success;
    const signed = BigInt(value.signedMinor);
    if (
      !known ||
      (value.entry.kind === "payment" && signed < 0n) ||
      (value.entry.kind === "refund" && signed > 0n)
    )
      context.addIssue({
        code: "custom",
        message: "Invalid converted money provenance",
      });
    if (value.basis === "identity") {
      const expected =
        BigInt(value.entry.amountMinor) *
        (value.entry.kind === "refund" ? -1n : 1n);
      if (
        value.quote !== null ||
        value.reportingCurrency !== value.entry.currency ||
        signed !== expected
      )
        context.addIssue({
          code: "custom",
          message: "Invalid identity valuation",
        });
    } else if (
      value.reportingCurrency === value.entry.currency ||
      !value.quote ||
      value.quote.fromCurrency !== value.entry.currency ||
      value.quote.toCurrency !== value.reportingCurrency ||
      value.quote.requestedDate !== value.entry.eventDate ||
      value.quote.effectiveDate > value.entry.eventDate
    ) {
      context.addIssue({
        code: "custom",
        message: "Invalid reference valuation provenance",
      });
    }
  });
const unconverted = z
  .object({
    status: z.literal("unconverted"),
    entry: fxEntrySchema,
    reportingCurrency: fxCurrencySchema,
    reason: fxUnconvertedReasonSchema,
    calculationVersion: z.literal(fxCalculationVersion),
  })
  .strict();
export const fxConversionResultSchema = z.discriminatedUnion("status", [
  converted,
  unconverted,
]);
export const fxConversionSummarySchema = z
  .object({
    reportingCurrency: fxCurrencySchema,
    signedMinor: signedInteger,
    convertedCount: z.number().int().min(0).max(1000),
    unconverted: z.array(unconverted).max(1000),
    calculationVersion: z.literal(fxCalculationVersion),
  })
  .strict()
  .refine(
    (value) =>
      value.unconverted.every(
        (row) => row.reportingCurrency === value.reportingCurrency,
      ) && value.convertedCount + value.unconverted.length <= 1000,
  );

export type FxEntry = z.infer<typeof fxEntrySchema>;
export type FxRateRequest = z.infer<typeof fxRateRequestSchema>;
export type FxRateQuote = z.infer<typeof fxRateQuoteSchema>;
export type FxConversionPolicy = z.infer<typeof fxConversionPolicySchema>;
export type FxConversionResult = z.infer<typeof fxConversionResultSchema>;
export type FxConversionSummary = z.infer<typeof fxConversionSummarySchema>;
export type FxUnconvertedReason = z.infer<typeof fxUnconvertedReasonSchema>;
