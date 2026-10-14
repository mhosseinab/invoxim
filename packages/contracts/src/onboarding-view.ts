import { z } from "zod";
import copy from "../../../contracts/ux-copy.en.json" with { type: "json" };

export const copyKeySchema = z.enum(
  Object.keys(copy.messages) as [string, ...string[]],
);

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
