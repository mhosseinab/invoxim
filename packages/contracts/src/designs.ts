import { z } from "zod";
import copy from "../../../contracts/ux-copy.en.json";
import { hasControlCharacters, validCalendarDate } from "./primitives";
export const copyKeySchema = z.enum(
  Object.keys(copy.messages) as [string, ...string[]],
);
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
export const EXTRACTION_PROMPT_VERSION = "invoice-extraction-v5";
export function supportedExtractionPrompt(version: string): boolean {
  return (
    version === "invoice-extraction-v1" ||
    version === "invoice-extraction-v2" ||
    version === "invoice-extraction-v3" ||
    version === "invoice-extraction-v4" ||
    version === EXTRACTION_PROMPT_VERSION
  );
}
export const configSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    environment: z.enum(["local", "staging", "production"]),
    publicSignupEnabled: z.boolean(),
    signupMode: z.enum(["allowlist", "public"]),
    defaultReportingCurrency: z.string().regex(/^[A-Z]{3}$/),
    defaultTimezone: z.string().max(80),
    mail: z.strictObject({
      maxMailboxesPerUser: z.number().int().min(1).max(100),
      defaultHistoryMonths: z.number().int().min(1).max(120),
      syncIntervalMinutes: z.number().int().min(15).max(1440),
      dispatchIntervalMinutes: z.number().int().min(1).max(60),
      manualSyncCooldownSeconds: z.number().int().min(30).max(3600),
      discoveryPageSize: z.number().int().min(1).max(100),
      providers: z.array(z.enum(["gmail", "outlook"])).max(2),
      recentFirstDays: z.number().int().min(1).max(90),
    }),
    jobs: z.strictObject({
      maxConcurrentPerTenant: z.number().int().min(1).max(10),
      consumerConcurrency: z.number().int().min(1).max(10),
      leaseSeconds: z.number().int().min(60).max(1800),
      maxQueueBodyBytes: z.number().int().min(128).max(2048),
    }),
    documents: z.strictObject({
      maxAttachmentBytes: z.number().int().min(1024).max(16777216),
      maxAiTextCharacters: z.number().int().min(1000).max(100000),
      maxJsonResponseBytes: z.number().int().min(1024).max(524288),
      parser: z.strictObject({
        provider: z.enum([
          "disabled",
          "cloudflare-markdown",
          "approved-custom",
        ]),
        enabled: z.boolean(),
        approvedCapabilities: z
          .array(z.enum(["pdf-text", "image-ocr", "pdf-scan"]))
          .max(3),
      }),
    }),
    ai: z.strictObject({
      hosted: z.strictObject({
        enabled: z.boolean(),
        providerId: z.string().max(80),
        adapter: z.enum([
          "openai-chat-compatible",
          "cloudflare-workers-ai",
          "custom-approved",
        ]),
        baseUrl: z
          .string()
          .regex(/^https:\/\//)
          .refine((value) => {
            try {
              new URL(value);
              return true;
            } catch {
              return false;
            }
          }, "Invalid URI")
          .nullable(),
        model: z.string().max(200).nullable(),
        secretRef: z.string().max(120),
        priceVersion: z.string().max(80).nullable(),
      }),
      approvedByokProviders: z
        .array(
          z.strictObject({
            id: z.string().max(80),
            adapter: z.enum(["openai-chat-compatible", "custom-approved"]),
            baseUrl: z
              .string()
              .regex(/^https:\/\//)
              .refine((value) => {
                try {
                  new URL(value);
                  return true;
                } catch {
                  return false;
                }
              }, "Invalid URI"),
            modelIds: z.array(z.string().max(200)).max(100),
            capabilities: z
              .array(z.enum(["text", "json-schema", "image", "pdf"]))
              .max(4),
            pricingVersion: z.string().max(80).nullable(),
          }),
        )
        .max(30),
      maxAttemptsPerExtraction: z.number().int().min(1).max(2),
      limits: z.strictObject({
        documentsPerUserDay: z.number().int().min(1).max(10000),
        documentsPerUserMonth: z.number().int().min(1).max(100000),
        operatorDailyUsdMicros: z.number().int().min(0).max(1000000000),
        operatorMonthlyUsdMicros: z.number().int().min(0).max(10000000000),
      }),
    }),
    storage: z.strictObject({
      rawArchiveEnabledByDefault: z.literal(false),
      supportedProviders: z.array(z.enum(["google-drive"])).max(1),
      allowOperatorRawStorage: z.literal(false),
    }),
    fx: z.strictObject({
      provider: z.enum(["frankfurter-v2"]),
      rateSource: z.enum(["ecb"]),
      maxPriorRateAgeDays: z.number().int().min(1).max(14),
    }),
    retention: z.strictObject({
      completedJobsDays: z.number().int().min(1).max(30),
      failedJobsDays: z.number().int().min(1).max(90),
      usageEventsDays: z.number().int().min(1).max(365),
      oauthStateSeconds: z.number().int().min(60).max(600),
    }),
    safety: z.strictObject({
      logDocumentContent: z.literal(false),
      runtimeAiToolsEnabled: z.literal(false),
      followModelUrls: z.literal(false),
      allowUnapprovedAiHosts: z.literal(false),
    }),
    product: z.strictObject({
      displayName: z.string().min(1).max(80),
      demoEnabled: z.boolean(),
      releaseStage: z.enum(["M0", "M1", "M2"]),
      features: z.strictObject({
        outlook: z.boolean(),
        driveArchive: z.boolean(),
        recurring: z.boolean(),
        useTags: z.boolean(),
      }),
    }),
    pilotMeasurement: z.strictObject({
      enabled: z.boolean(),
      requiresUserOptIn: z.literal(true),
      retentionDays: z.number().int().min(1).max(30),
      maxEventsPerUserDay: z.number().int().min(1).max(100),
    }),
  })
  .superRefine((v, ctx) => {
    if (v.publicSignupEnabled && v.signupMode !== "public")
      ctx.addIssue({ code: "custom", message: "Public signup mode required" });
    if (
      v.ai.hosted.enabled &&
      (!v.ai.hosted.model || !v.ai.hosted.priceVersion)
    )
      ctx.addIssue({
        code: "custom",
        message: "Hosted model and prices required",
      });
    if (
      v.product.releaseStage === "M0" &&
      Object.values(v.product.features).some(Boolean)
    )
      ctx.addIssue({ code: "custom", message: "M0 capabilities disabled" });
  });
export const onboardingViewSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    state: z.enum([
      "connect_mailbox",
      "review_import",
      "importing",
      "records_ready",
      "no_matches",
      "paused_budget",
      "needs_reconnect",
      "processing_unavailable",
      "needs_attention",
    ]),
    headlineKey: z.string().min(1),
    primaryAction: z.enum([
      "connect_mailbox",
      "review_import",
      "start_import",
      "view_purchases",
      "adjust_range",
      "view_usage",
      "reconnect",
      "view_example",
      "view_review",
      "none",
    ]),
    canStartImport: z.boolean(),
    readyRecordCount: z.number().int().min(0),
    historyComplete: z.boolean(),
    hasProcessingConsent: z.boolean(),
    exampleData: z.literal(false),
    activeImportId: z.string().max(120).nullable().optional(),
    connectionId: z.string().max(120).nullable().optional(),
    disclosureVersion: z.string().max(120).nullable().optional(),
    reviewItemCount: z.number().int().min(0),
  })
  .superRefine((v, ctx) => {
    const reject = (condition: boolean) => {
      if (condition)
        ctx.addIssue({
          code: "custom",
          message: "Inconsistent onboarding view",
        });
    };
    reject(!copyKeySchema.safeParse(v.headlineKey).success);
    reject(
      v.state === "records_ready" &&
        (v.readyRecordCount < 1 ||
          !v.hasProcessingConsent ||
          v.primaryAction !== "view_purchases"),
    );
    reject(
      v.state === "no_matches" &&
        (v.readyRecordCount !== 0 ||
          !v.historyComplete ||
          !v.hasProcessingConsent ||
          v.primaryAction !== "adjust_range" ||
          v.reviewItemCount !== 0),
    );
    reject(
      v.canStartImport &&
        (v.state !== "review_import" || v.primaryAction !== "start_import"),
    );
    reject(
      v.state === "connect_mailbox" &&
        (v.canStartImport ||
          v.readyRecordCount !== 0 ||
          v.hasProcessingConsent),
    );
    reject(
      v.state === "needs_attention" &&
        (v.reviewItemCount < 1 ||
          v.primaryAction !== "view_review" ||
          v.canStartImport ||
          !v.hasProcessingConsent),
    );
  });
export type AppConfig = z.infer<typeof configSchema>;
export type Extraction = z.infer<typeof extractionSchema>;
export type OnboardingView = z.infer<typeof onboardingViewSchema>;
