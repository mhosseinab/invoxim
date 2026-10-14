import { z } from "zod";

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

export type AppConfig = z.infer<typeof configSchema>;
