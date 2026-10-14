import { z } from "zod";
import { extractionSchema } from "./designs";
import {
  MINOR_BOUND,
  dateSchema as date,
  hasControlCharacters,
  supportedCurrency,
} from "./primitives";

const id = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !hasControlCharacters(value));
const version = z.number().int().min(1).max(2147483646);
const currency = supportedCurrency;
const amount = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(13)
  .refine((value) => BigInt(value) <= MINOR_BOUND);
const positive = amount.refine((value) => BigInt(value) > 0n);
const merchant = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !hasControlCharacters(value));
const reference = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => !hasControlCharacters(value))
  .nullable();
const category = extractionSchema.shape.records.element.shape.category;
export const purchaseChangesSchema = z
  .strictObject({
    merchant: merchant.optional(),
    category: category.optional(),
    documentDate: date.optional(),
    totalMinor: amount.nullable().optional(),
    currency: currency.nullable().optional(),
    invoiceReference: reference.optional(),
    orderReference: reference.optional(),
  })
  .refine((value) => Object.keys(value).length > 0);
export const purchaseCorrectionRequestSchema = z.strictObject({
  version,
  changes: purchaseChangesSchema,
});
export const eventChangesSchema = z
  .strictObject({
    amountMinor: amount.optional(),
    currency: currency.optional(),
    eventDate: date.optional(),
  })
  .refine((value) => Object.keys(value).length > 0);
export const eventCorrectionRequestSchema = z.strictObject({
  version,
  changes: eventChangesSchema,
});
export const cashConfirmationRequestSchema = z.strictObject({
  version,
  confirmed: z.literal(true),
  amountMinor: positive,
  currency,
  eventDate: date,
  review: z.strictObject({ id, version }).optional(),
});
export const exclusionRequestSchema = z.strictObject({
  version,
  reason: z.enum(["not-my-purchase", "duplicate", "not-spending", "other"]),
});
export const restorationRequestSchema = z.strictObject({ version });
export const mergeRequestSchema = z
  .strictObject({
    target: z.strictObject({ id, version }),
    source: z.strictObject({ id, version }),
  })
  .refine((value) => value.target.id !== value.source.id);
export const unmergeRequestSchema = z.strictObject({
  mergeId: id,
  version,
  sourceVersion: version,
});
const missingChanges = z
  .strictObject({
    merchant: merchant.optional(),
    currency: currency.optional(),
    totalMinor: amount.optional(),
    documentDate: date.optional(),
  })
  .refine((value) => Object.keys(value).length > 0);
export const reviewResolutionRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ version, action: z.literal("dismiss-operational") }),
  z.strictObject({ version, action: z.literal("not-a-purchase") }),
  z.strictObject({
    version,
    action: z.literal("correct-missing-fields"),
    purchaseVersion: version,
    changes: missingChanges,
  }),
  z.strictObject({
    version,
    action: z.literal("complete-record"),
    record: z.strictObject({
      merchant,
      documentDate: date,
      currency,
      totalMinor: amount,
      category,
      invoiceReference: reference.optional(),
      orderReference: reference.optional(),
    }),
  }),
  z.strictObject({
    version,
    action: z.literal("different-purchase"),
    purchaseVersion: version,
  }),
]);
export type PurchaseChanges = z.infer<typeof purchaseChangesSchema>;
export type EventChanges = z.infer<typeof eventChangesSchema>;
export type CashConfirmationRequest = z.infer<
  typeof cashConfirmationRequestSchema
>;
export type ReviewResolutionRequest = z.infer<
  typeof reviewResolutionRequestSchema
>;
export type CorrectionCommand =
  | {
      kind: "purchase-edit";
      purchaseId: string;
      request: z.infer<typeof purchaseCorrectionRequestSchema>;
    }
  | {
      kind: "event-edit";
      entryId: string;
      request: z.infer<typeof eventCorrectionRequestSchema>;
    }
  | {
      kind: "cash-confirm";
      purchaseId: string;
      entryKind: "payment" | "refund";
      request: CashConfirmationRequest;
    }
  | {
      kind: "exclude";
      purchaseId: string;
      request: z.infer<typeof exclusionRequestSchema>;
    }
  | {
      kind: "restore";
      purchaseId: string;
      request: z.infer<typeof restorationRequestSchema>;
    }
  | { kind: "merge"; request: z.infer<typeof mergeRequestSchema> }
  | {
      kind: "unmerge";
      purchaseId: string;
      request: z.infer<typeof unmergeRequestSchema>;
    }
  | {
      kind: "review-resolve";
      reviewId: string;
      request: ReviewResolutionRequest;
    };
export const correctionResultSchema = z.strictObject({
  purchaseId: id.nullable(),
  version: version.nullable(),
  entryId: id.nullable(),
  entryVersion: version.nullable(),
  reviewId: id.nullable(),
  reviewVersion: version.nullable(),
  reviewStatus: z.enum(["open", "resolved", "dismissed"]).nullable(),
  mergeId: id.nullable(),
});
export type CorrectionResult = z.infer<typeof correctionResultSchema>;
export const correctionStateSchema = z.strictObject({
  mutationToken: z.string().min(40).max(2048),
  purchaseId: id,
  version,
  origin: z.enum(["source", "user-supplied"]),
  recordStatus: z.enum(["active", "excluded", "merged"]),
  overriddenFields: z.array(z.string()).max(20),
  entries: z
    .array(
      z.strictObject({
        id,
        version,
        origin: z.enum(["source", "user-confirmed"]),
        overriddenFields: z.array(z.string()).max(8),
      }),
    )
    .max(200),
  reviews: z
    .array(
      z.strictObject({
        id,
        version,
        reason: z.string(),
        blockingScope: z.enum(["financial", "operational"]),
        missingFields: z
          .array(z.enum(["merchant", "currency", "total", "documentDate"]))
          .max(4),
        status: z.enum(["open", "resolved", "dismissed"]),
        actions: z
          .array(
            z.enum([
              "dismiss-operational",
              "not-a-purchase",
              "correct-missing-fields",
              "complete-record",
              "different-purchase",
              "confirm-payment",
              "confirm-refund",
            ]),
          )
          .max(7),
      }),
    )
    .max(200),
  merges: z
    .array(
      z.strictObject({
        id,
        targetId: id,
        sourceId: id,
        targetVersion: version,
        sourceVersion: version,
        active: z.boolean(),
      }),
    )
    .max(20),
  capabilities: z.strictObject({
    editable: z.boolean(),
    maxMergeEvents: z.literal(200),
    maxMergeEvidence: z.literal(200),
  }),
});
export type CorrectionState = z.infer<typeof correctionStateSchema>;
export const correctionIdSchema = id;

export const correctionReviewSchema = z.strictObject({
  mutationToken: z.string().min(40).max(2048),
  review: correctionStateSchema.shape.reviews.element,
  documentId: id.nullable(),
  purchaseId: id.nullable(),
  purchaseVersion: version.nullable(),
});
export type CorrectionReview = z.infer<typeof correctionReviewSchema>;
