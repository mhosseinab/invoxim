import { z } from "zod";
import {
  fxConversionResultSchema,
  fxConversionSummarySchema,
  fxCurrencySchema,
  fxEntrySchema,
} from "./fx";
import { hasControlCharacters, validCalendarDate } from "./primitives";

const identifier = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !hasControlCharacters(value));
const version = z.number().int().min(1).max(2147483646);
const fields = {
  expectedProfileVersion: version,
  reportingCurrency: fxCurrencySchema,
  fromDate: z.string().refine(validCalendarDate),
  toDate: z.string().refine(validCalendarDate),
  purchaseId: identifier.optional(),
  cursor: z.string().min(1).max(32768).optional(),
  limit: z.number().int().min(1).max(20),
};
export const fxReportingRequestSchema = z
  .strictObject(fields)
  .refine((value) => value.fromDate <= value.toDate);
export const fxRevaluationRequestSchema = z
  .strictObject({ ...fields, limit: z.number().int().min(1).max(3) })
  .refine((value) => value.fromDate <= value.toDate);
const queryInteger = z
  .string()
  .regex(/^[1-9][0-9]{0,9}$/)
  .transform(Number);
export const fxReportingQuerySchema = z
  .strictObject({
    ...fields,
    expectedProfileVersion: queryInteger.pipe(version),
    limit: queryInteger.pipe(fields.limit).default(20),
  })
  .refine((value) => value.fromDate <= value.toDate);
export const fxReportingRowSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("pending"),
    entry: fxEntrySchema,
    entryVersion: version,
  }),
  z.strictObject({
    status: z.literal("valued"),
    entry: fxEntrySchema,
    entryVersion: version,
    result: fxConversionResultSchema,
  }),
]);
const page = {
  status: z.literal("current"),
  summaryScope: z.literal("page"),
  expectedProfileVersion: version,
  reportingCurrency: fxCurrencySchema,
  pageSummary: fxConversionSummarySchema,
  pendingCount: z.number().int().min(0).max(20),
  nextCursor: z.string().max(32768).nullable(),
};
export const fxReportingResponseSchema = z.strictObject({
  ...page,
  entries: z.array(fxReportingRowSchema).max(20),
  mutationToken: z.string().min(1).max(2048),
});
export const fxReportingExportSchema = z.strictObject({
  ...page,
  schemaVersion: z.literal(1),
  rows: z.array(fxReportingRowSchema).max(20),
});
export const fxRevaluationResponseSchema = z.strictObject({
  status: z.literal("current"),
  processed: z.number().int().min(0).max(3),
  nextCursor: z.string().max(32768).nullable(),
});
