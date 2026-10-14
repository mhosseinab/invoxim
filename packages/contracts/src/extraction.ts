import { z } from "zod";
import { hasControlCharacters, validCalendarDate } from "./primitives";

const cashReferenceSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => !hasControlCharacters(value));

export const extractionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documentType: z.enum([
    "receipt",
    "invoice",
    "order-confirmation",
    "refund",
    "credit-note",
    "cancellation",
    "statement",
    "non-purchase",
    "unknown",
  ]),
  records: z
    .array(
      z.strictObject({
        merchant: z.string().max(200).nullable(),
        documentDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe(
            "Explicit document date normalized to YYYY-MM-DD, or null when missing or ambiguous; never substitute email sent/received or invoice due dates.",
          )
          .refine(validCalendarDate, "Invalid calendar date")
          .nullable(),
        eventDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe(
            "Explicit payment/refund event date normalized to YYYY-MM-DD, or null when missing or ambiguous; never substitute email sent/received dates.",
          )
          .refine(validCalendarDate, "Invalid calendar date")
          .nullable(),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .nullable(),
        total: z
          .string()
          .regex(/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,3})?$/)
          .nullable(),
        tax: z
          .string()
          .regex(/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,3})?$/)
          .nullable(),
        invoiceNumber: z.string().max(160).nullable(),
        orderReference: z.string().max(160).nullable(),
        paymentReference: cashReferenceSchema.nullable().optional(),
        refundReference: cashReferenceSchema.nullable().optional(),
        category: z.enum([
          "groceries",
          "dining",
          "shopping",
          "transport",
          "travel",
          "home",
          "utilities",
          "health",
          "education",
          "entertainment",
          "software",
          "business-services",
          "other",
          "uncategorized",
        ]),
        paymentEvidence: z.enum([
          "explicitly-paid",
          "explicitly-unpaid",
          "unknown",
        ]),
        refundEvidence: z.enum(["completed", "pending", "none", "unknown"]),
        paymentMethodHint: z.enum([
          "card",
          "cash",
          "bank-transfer",
          "wallet",
          "store-credit",
          "unknown",
        ]),
        recurringCadence: z.enum(["monthly", "yearly", "other", "unknown"]),
        evidence: z
          .array(
            z.strictObject({
              field: z.enum([
                "merchant",
                "documentDate",
                "eventDate",
                "currency",
                "total",
                "tax",
                "invoiceNumber",
                "orderReference",
                "paymentReference",
                "refundReference",
                "payment",
                "refund",
                "recurring",
                "paymentAmount",
                "refundAmount",
                "storeCreditAmount",
              ]),
              inputPartId: z.string().max(100),
              quote: z.string().max(400),
            }),
          )
          .max(20),
        paymentAmount: z
          .string()
          .regex(/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,3})?$/)
          .nullable(),
        refundAmount: z
          .string()
          .regex(/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,3})?$/)
          .nullable(),
        storeCreditAmount: z
          .string()
          .regex(/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,3})?$/)
          .nullable(),
      }),
    )
    .max(10),
  warnings: z
    .array(
      z.enum([
        "ambiguous-currency",
        "ambiguous-date",
        "missing-total",
        "multiple-totals",
        "unsupported-language",
        "incomplete-document",
        "suspected-injection",
        "unreadable",
      ]),
    )
    .max(12),
});

/** New inference output always includes nullable cash references; historical records may omit them. */
export const inferenceExtractionSchema = extractionSchema.extend({
  records: z
    .array(
      extractionSchema.shape.records.element.extend({
        paymentReference: cashReferenceSchema.nullable(),
        refundReference: cashReferenceSchema.nullable(),
      }),
    )
    .max(10),
});

export const EXTRACTION_PROMPT_VERSION = "invoice-extraction-v6";

export function supportedExtractionPrompt(version: string): boolean {
  return (
    version === "invoice-extraction-v1" ||
    version === "invoice-extraction-v2" ||
    version === "invoice-extraction-v3" ||
    version === "invoice-extraction-v4" ||
    version === "invoice-extraction-v5" ||
    version === EXTRACTION_PROMPT_VERSION
  );
}

export type Extraction = z.infer<typeof extractionSchema>;
