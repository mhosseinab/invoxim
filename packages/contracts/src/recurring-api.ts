import { z } from "zod";
import { hasControlCharacters, validCalendarDate } from "./primitives";
import {
  recurringCadenceSchema,
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
