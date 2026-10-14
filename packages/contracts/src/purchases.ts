import { z } from "zod";
import { extractionSchema } from "./designs";
import {
  MINOR_BOUND,
  hasControlCharacters,
  supportedCurrency,
  validCalendarDate,
} from "./primitives";

const date = z.string().refine(validCalendarDate);
const id = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !hasControlCharacters(value));
const category = extractionSchema.shape.records.element.shape.category;
const currency = supportedCurrency;
const documentMinor = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(13)
  .pipe(z.string().refine((value) => BigInt(value) <= MINOR_BOUND));
const unsignedMinor = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(100);
const minor = z
  .string()
  .regex(/^(0|-?[1-9][0-9]*)$/)
  .max(100);
export const purchaseFiltersSchema = z
  .strictObject({
    from: date.optional(),
    to: date.optional(),
    q: z.string().trim().max(120).optional(),
    category: category.optional(),
    currency: supportedCurrency.optional(),
    mailbox: z.string().min(1).max(160).optional(),
    paymentState: z
      .enum(["unknown", "unpaid", "partially_paid", "paid"])
      .optional(),
    reviewState: z.enum(["open", "clear"]).optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to);
export const purchaseListRequestSchema = purchaseFiltersSchema.safeExtend({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).max(32768).optional(),
});
export type PurchaseFilters = z.infer<typeof purchaseFiltersSchema>;
export type PurchaseListRequest = z.infer<typeof purchaseListRequestSchema>;
export const currencyTotalsSchema = z.strictObject({
  currency,
  paidMinor: unsignedMinor,
  refundedMinor: unsignedMinor,
  netMinor: minor,
});
export type CurrencyTotals = z.infer<typeof currencyTotalsSchema>;
export const purchaseViewSchema = z.strictObject({
  id,
  merchant: z.string().max(200),
  date,
  invoiceReference: z.string().max(160).nullable(),
  orderReference: z.string().max(160).nullable(),
  category,
  currency: currency.nullable(),
  documentTotalMinor: documentMinor.nullable(),
  paymentState: z.enum(["unknown", "unpaid", "partially_paid", "paid"]),
  version: z.number().int().positive(),
  origin: z.enum(["source", "user-supplied"]).default("source"),
  recordStatus: z.enum(["active", "excluded", "merged"]).default("active"),
  evidenceCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reviewReasons: z.array(z.string().max(100)).max(100),
  lifecycle: z.array(currencyTotalsSchema).max(200),
  period: z.array(currencyTotalsSchema).max(200),
});
export type PurchaseView = z.infer<typeof purchaseViewSchema>;
export const purchaseListResponseSchema = z.strictObject({
  rows: z.array(purchaseViewSchema).max(50),
  nextCursor: z.string().max(32768).nullable(),
  dateBasis: z.literal("document-or-event"),
});
export type PurchaseListResponse = z.infer<typeof purchaseListResponseSchema>;
export const purchaseSummarySchema = z.strictObject({
  totals: z.array(currencyTotalsSchema).max(200),
  dateBasis: z.literal("event"),
  recordCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  unpaidCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  unknownCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reviewCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  excludedEntryCount: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  missingCurrencyCount: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  conversion: z.literal("not_configured"),
});
export type PurchaseSummary = z.infer<typeof purchaseSummarySchema>;
export const purchaseLedgerEntrySchema = z.strictObject({
  id,
  observationId: id.nullable(),
  origin: z.enum(["source", "user-confirmed"]),
  version: z.number().int().positive(),
  kind: z.enum(["payment", "refund"]),
  minor: documentMinor,
  currency,
  date,
  dateBasis: z.enum([
    "explicit-event-date",
    "document-date",
    "user-confirmed-date",
    "user-corrected-date",
  ]),
  eligible: z.boolean(),
});
export const manualPurchaseEvidenceSchema = z.strictObject({
  documentId: id,
  provenance: z.literal("user-associated"),
  source: z.strictObject({
    mailboxId: id,
    provider: z.string().max(80),
    originalAvailable: z.literal(false),
    reason: z.enum([
      "source_deleted",
      "mailbox_disconnected",
      "retrieval_not_implemented",
    ]),
  }),
});
export const purchaseDetailSchema = z.strictObject({
  purchase: purchaseViewSchema,
  ledgerEntries: z.array(purchaseLedgerEntrySchema).max(1000).default([]),
  manualEvidence: z.array(manualPurchaseEvidenceSchema).max(200).default([]),
  timeline: z
    .array(
      z.strictObject({
        observationId: id,
        documentId: id,
        documentType: z.string().max(40),
        relationship: z.string().max(80),
        evidenceCode: z.string().max(80),
        reviewState: z.string().max(40),
        date: date.nullable(),
        paymentEvidence: z.string().max(40).nullable(),
        refundEvidence: z.string().max(40).nullable(),
        source: z.strictObject({
          mailboxId: id,
          provider: z.string().max(80),
          originalAvailable: z.literal(false),
          reason: z.enum([
            "source_deleted",
            "mailbox_disconnected",
            "retrieval_not_implemented",
          ]),
        }),
        events: z
          .array(
            z.strictObject({
              id,
              kind: z.enum(["payment", "refund"]),
              minor: documentMinor,
              currency,
              date,
              dateBasis: z.string().max(40),
              eligible: z.boolean(),
            }),
          )
          .max(1000),
      }),
    )
    .max(200),
});
export type PurchaseDetail = z.infer<typeof purchaseDetailSchema>;
export const purchaseCoverageSchema = z.strictObject({
  readyPurchaseCount: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  openReviewCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  connections: z
    .array(
      z.strictObject({
        id,
        address: z.string().max(254),
        provider: z.string().max(80),
        state: z.string().max(80),
        schedulingState: z.string().max(80),
        pendingJobs: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER),
        pausedJobs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        failedJobs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        imports: z
          .array(
            z.strictObject({
              id,
              from: z.string().max(80),
              to: z.string().max(80),
              stage: z.string().max(80),
              pauseReason: z.string().max(100).nullable(),
              completedAt: z
                .number()
                .int()
                .nonnegative()
                .max(Number.MAX_SAFE_INTEGER)
                .nullable(),
              discoveredSources: z
                .number()
                .int()
                .nonnegative()
                .max(Number.MAX_SAFE_INTEGER),
              processedSources: z
                .number()
                .int()
                .nonnegative()
                .max(Number.MAX_SAFE_INTEGER),
            }),
          )
          .max(100),
      }),
    )
    .max(100),
});
export type PurchaseCoverage = z.infer<typeof purchaseCoverageSchema>;

/** Basic structured export: implemented records, evidence metadata and cash events only. */
export const purchaseOverrideSchema = z.strictObject({
  entityKind: z.enum(["purchase", "entry"]),
  entityId: id,
  field: z.enum([
    "merchant",
    "category",
    "documentDate",
    "totalMinor",
    "currency",
    "invoiceReference",
    "orderReference",
    "amountMinor",
    "eventDate",
    "dateBasis",
    "paymentState",
  ]),
  originalValue: z.string().max(1000).nullable(),
  value: z.string().max(1000).nullable(),
  revision: z.number().int().positive(),
});
export const purchaseExportSnapshotSchema = z.strictObject({
  overrides: z.array(purchaseOverrideSchema).max(4000).default([]),
  purchases: z.array(purchaseViewSchema).max(500),
  ledgerEntries: z
    .array(
      z.strictObject({
        id,
        purchaseId: id,
        observationId: id.nullable(),
        origin: z.enum(["source", "user-confirmed"]),
        version: z.number().int().positive(),
        kind: z.enum(["payment", "refund"]),
        minor: documentMinor,
        currency,
        date,
        dateBasis: z.string().max(40),
        eligible: z.boolean(),
      }),
    )
    .max(2000),
  sources: z
    .array(
      z.strictObject({
        purchaseId: id,
        documentId: id,
        observationId: id.nullable(),
        provenance: z
          .enum(["source-extracted", "user-associated"])
          .default("source-extracted"),
        mailboxId: z.string().min(1).max(160),
        provider: z.string().max(80),
        providerMessageId: z.string().max(4096),
        contentHash: z.string().max(128),
        available: z.boolean(),
        originalAvailable: z.literal(false),
      }),
    )
    .max(2000),
  observations: z
    .array(
      z.strictObject({
        id,
        purchaseId: id,
        documentId: id,
        relationship: z.string().max(80),
        evidenceCode: z.string().max(80),
        reviewState: z.string().max(40),
        documentType: z.string().max(40),
        fields: z.strictObject({
          schemaVersion: z.literal(1),
          merchant: z.string().max(200).nullable().optional(),
          date: date.nullable().optional(),
          totalMinor: documentMinor.nullable().optional(),
          currency: currency.nullable().optional(),
        }),
      }),
    )
    .max(2000),
});
export type PurchaseExportSnapshot = z.infer<
  typeof purchaseExportSnapshotSchema
>;

export const reviewSourceContextSchema = z.strictObject({
  mailboxAddress: z.string().max(254),
  receivedAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
  provider: z.string().max(80),
  available: z.boolean(),
});
export const reviewSourceSchema = z.strictObject({
  mailboxAddress: z.string().max(254),
  receivedAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
  subject: z.string().max(998).nullable(),
  sender: z.string().max(998).nullable(),
  attachments: z
    .array(
      z.strictObject({
        filename: z.string().max(255),
        mimeType: z.string().max(100),
        size: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .nullable(),
      }),
    )
    .max(64)
    .optional(),
  originalUrl: z
    .string()
    .max(4096)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          url.origin === "https://mail.google.com" &&
          url.pathname === "/mail/" &&
          !url.username &&
          !url.password &&
          url.hash.startsWith("#search/")
        );
      } catch {
        return false;
      }
    })
    .nullable(),
});
export type ReviewSource = z.infer<typeof reviewSourceSchema>;

/** Open questions only: no incomplete field guesses or source contents. */
export const purchaseReviewSchema = z.strictObject({
  id,
  documentId: id.nullable(),
  purchaseId: id.nullable(),
  reason: z.enum([
    "extraction-review",
    "incomplete-financial-facts",
    "unknown-payment",
    "payment-allocation-review",
    "ambiguous-event",
    "event-conflict",
    "invoice-conflict",
    "purchase-conflict",
    "possible-duplicate",
    "unmatched-refund",
    "refund-exceeds-payment",
    "refund-currency-mismatch",
    "credit-note-completion",
    "mixed-tender",
    "document-review",
  ]),
  sourceMessageId: id.optional(),
  sourceContext: reviewSourceContextSchema.optional(),
  missingFields: z
    .array(z.enum(["merchant", "currency", "total", "documentDate"]))
    .max(4)
    .refine((fields) => new Set(fields).size === fields.length),
});
export const purchaseReviewsSchema = z.strictObject({
  reviews: z.array(purchaseReviewSchema).max(50),
  hasMore: z.boolean(),
});
export type PurchaseReview = z.infer<typeof purchaseReviewSchema>;
export type PurchaseReviews = z.infer<typeof purchaseReviewsSchema>;
export const purchaseReviewRequestSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
