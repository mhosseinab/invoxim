import { z } from "zod";
import { fxEntrySchema } from "./fx";
import { hasControlCharacters, validCalendarDate } from "./primitives";

export const recurringMethodVersion = "recurring-v1" as const;
export const recurringPostingToleranceDays = 3 as const;
const id = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !hasControlCharacters(value));
const key = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value && !hasControlCharacters(value));
const minor = fxEntrySchema.shape.amountMinor;
const date = z.string().refine(validCalendarDate);
const signed = z
  .string()
  .max(48)
  .regex(/^(?:0|-?[1-9][0-9]*)$/);
export const recurringServiceIdentitySchema = z
  .object({ kind: z.enum(["service-reference", "user-confirmed"]), key })
  .strict();
export const recurringCadenceSchema = z.enum(["weekly", "monthly", "annual"]);
const evidence = z.enum(["explicit-terms", "user-confirmed"]);
export const recurringTermsSchema = z
  .object({ cadence: recurringCadenceSchema, anchorDate: date, evidence })
  .strict();
export const recurringPaymentSchema = z
  .object({
    entryId: id,
    purchaseId: id,
    kind: z.enum(["payment", "refund"]),
    eligible: z.boolean(),
    installment: z.boolean(),
    amountMinor: minor,
    currency: fxEntrySchema.shape.currency,
    eventDate: date,
    serviceIdentity: recurringServiceIdentitySchema.nullable(),
    terms: recurringTermsSchema.optional(),
    pricing: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("unknown"), evidence: z.literal("unknown") })
        .strict(),
      z
        .object({ kind: z.enum(["fixed", "usage-variable"]), evidence })
        .strict(),
    ]),
    // Validated service/plan, interval, quantity, tax and discount basis; never gross-only inference.
    comparableCharge: z
      .object({ basisKey: key, amountMinor: minor, evidence })
      .strict()
      .optional(),
  })
  .strict();
export const recurringDecisionSchema = z
  .object({
    state: z.enum(["confirmed", "dismissed", "paused", "canceled"]),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const recurringInputSchema = z
  .object({
    payments: z.array(recurringPaymentSchema).max(1000),
    decision: recurringDecisionSchema.optional(),
  })
  .strict();
const comparison = z
  .object({
    previousEntryId: id,
    currentEntryId: id,
    previousAmountMinor: minor,
    currentAmountMinor: minor,
    deltaMinor: signed,
    percentHundredths: signed.nullable(),
    signal: z.enum([
      "stable",
      "usage_variation",
      "fixed_price_increase",
      "fixed_price_decrease",
      "charged_amount_changed",
    ]),
    basis: z.enum(["comparable-charge", "payment-amount"]),
  })
  .strict();
const forecast = z
  .object({
    estimatedNextDate: date.nullable(),
    monthlyMinor: z
      .string()
      .max(48)
      .regex(/^(?:0|[1-9][0-9]*)$/),
    annualMinor: z
      .string()
      .max(48)
      .regex(/^(?:0|[1-9][0-9]*)$/),
    amountBasis: z.literal("last-payment"),
    weeklyPaymentsPerYear: z.literal(52).nullable(),
    certainty: z.literal("estimate"),
  })
  .strict();
export const recurringResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("insufficient"),
      reason: z.enum([
        "no_eligible_payments",
        "missing_service_identity",
        "mixed_service_identity",
        "unsupported_currency",
        "mixed_currency",
        "insufficient_history",
        "unstable_intervals",
        "terms_conflict",
      ]),
      decision: recurringDecisionSchema.nullable(),
      methodVersion: z.literal(recurringMethodVersion),
    })
    .strict(),
  z
    .object({
      status: z.literal("series"),
      state: z.enum([
        "suggested",
        "confirmed",
        "dismissed",
        "paused",
        "canceled",
      ]),
      decision: recurringDecisionSchema.nullable(),
      serviceIdentity: recurringServiceIdentitySchema,
      currency: fxEntrySchema.shape.currency,
      cadence: recurringCadenceSchema,
      anchorDate: date,
      scheduleBasis: z.enum([
        "first-payment-estimate",
        "explicit-terms",
        "user-confirmed",
      ]),
      postingToleranceDays: z.literal(recurringPostingToleranceDays),
      methodVersion: z.literal(recurringMethodVersion),
      entryIds: z.array(id).min(1).max(1000),
      lastPayment: recurringPaymentSchema,
      comparison: comparison.nullable(),
      forecast: forecast.nullable(),
    })
    .strict(),
]);
export type RecurringPayment = z.infer<typeof recurringPaymentSchema>;
export type RecurringCadence = z.infer<typeof recurringCadenceSchema>;
export type RecurringInput = z.infer<typeof recurringInputSchema>;
export type RecurringResult = z.infer<typeof recurringResultSchema>;
