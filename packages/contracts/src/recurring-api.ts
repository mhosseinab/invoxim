import { z } from "zod";
import { hasControlCharacters, validCalendarDate } from "./primitives";
import {
  recurringCadenceSchema,
  recurringPaymentSchema,
  recurringResultSchema,
  recurringServiceIdentitySchema,
} from "./recurring";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !hasControlCharacters(value));
const version = z.number().int().min(1).max(2147483646);
export const recurringSelectionSchema = z.strictObject({
  entryId: identifier,
  expectedVersion: version,
});
export const recurringCreateSchema = z
  .strictObject({
    id: identifier,
    identityKey: recurringServiceIdentitySchema.shape.key,
    cadence: recurringCadenceSchema,
    anchorDate: z.string().refine(validCalendarDate),
    entries: z.array(recurringSelectionSchema).min(1).max(20),
  })
  .refine(
    (value) =>
      new Set(value.entries.map((entry) => entry.entryId)).size ===
      value.entries.length,
  );
export const recurringDecisionInputSchema = z.strictObject({
  expectedVersion: version,
  state: z.enum(["confirmed", "dismissed", "paused", "canceled"]),
});
export const recurringAutomaticPreviewSchema = z
  .strictObject({
    entries: z.array(recurringSelectionSchema).min(1).max(20),
  })
  .refine(
    (value) =>
      new Set(value.entries.map((entry) => entry.entryId)).size ===
      value.entries.length,
  );
export type RecurringCreateInput = z.infer<typeof recurringCreateSchema>;
export type RecurringDecisionInput = z.infer<
  typeof recurringDecisionInputSchema
>;
export type RecurringAutomaticPreviewInput = z.infer<
  typeof recurringAutomaticPreviewSchema
>;
export const recurringPageLimit = 10;
export const recurringSeriesMetadataSchema = z.strictObject({
  id: identifier,
  identity_kind: recurringServiceIdentitySchema.shape.kind,
  identity_key: recurringServiceIdentitySchema.shape.key,
  currency: recurringPaymentSchema.shape.currency,
  cadence: recurringCadenceSchema,
  anchor_date: z.string().refine(validCalendarDate),
  state: z.enum(["suggestion", "confirmed", "dismissed", "paused", "canceled"]),
  pricing_kind: z.enum(["unknown", "fixed", "usage-variable"]),
  selected_entry_count: z.number().int().min(1).max(20),
  version,
});
export const recurringRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("current"),
    series: recurringSeriesMetadataSchema,
    projection: recurringResultSchema,
  }),
  z.strictObject({
    status: z.literal("stale"),
    series: recurringSeriesMetadataSchema,
    entryIds: z.array(identifier).max(20),
    reason: z.literal("evidence_changed"),
  }),
]);
const mutationToken = z.string().min(1).max(2048);
export const recurringListResponseSchema = z.strictObject({
  status: z.literal("current"),
  pageScope: z.literal("page"),
  pageSnapshot: z.literal(false),
  automaticSuggestionsAvailable: z.literal(false),
  userSelectionRequired: z.literal(true),
  records: z.array(recurringRecordSchema).max(recurringPageLimit),
  nextCursor: identifier.nullable(),
  mutationToken,
});
export const recurringDetailResponseSchema = z.strictObject({
  record: recurringRecordSchema,
  mutationToken,
});
export const recurringWriteResponseSchema = z.strictObject({
  status: z.literal("stored"),
  version,
});
export const recurringPreviewResponseSchema = z.strictObject({
  result: recurringResultSchema,
});
