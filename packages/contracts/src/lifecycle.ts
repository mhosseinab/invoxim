import { z } from "zod";
import { hasControlCharacters } from "./primitives";
import {
  purchaseExportSnapshotSchema,
  purchaseFiltersSchema,
  purchaseSummarySchema,
} from "./purchases";

const version = z.number().int().min(1).max(2_147_483_646);
export const lifecycleCapabilitiesSchema = z.strictObject({
  accountDeletionAvailable: z.boolean(),
  providerRevocation: z.strictObject({
    available: z.boolean(),
    requiresExplicitOptIn: z.literal(true),
    scope: z.literal("google-project-wide"),
    mayAffect: z.tuple([
      z.literal("mailboxes"),
      z.literal("storage"),
      z.literal("login"),
    ]),
  }),
  exports: z.strictObject({
    maxPurchases: z.literal(500),
    maxEvents: z.literal(2000),
    maxBytes: z.literal(2097152),
  }),
  driveFilesDeleted: z.literal(false),
  mutationToken: z.string().min(1).max(2048),
});
export const lifecycleIdSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => !hasControlCharacters(value));
export const disconnectRequestSchema = z.strictObject({
  confirmed: z.literal(true),
  revokeProviderAccess: z.boolean().optional(),
  generation: version,
  credentialVersion: z.number().int().min(0).max(2_147_483_646),
});
export const deleteDataRequestSchema = z.strictObject({
  confirmed: z.literal(true),
  generation: version,
  previewFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export const accountDeleteRequestSchema = z.strictObject({
  confirmed: z.literal(true),
  revokeProviderAccess: z.boolean().optional(),
  version,
});
export const lifecycleExportRequestSchema = purchaseFiltersSchema.safeExtend({
  format: z.enum(["csv", "json"]),
});
export const lifecycleExportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  exportedAt: z.iso.datetime(),
  filters: purchaseFiltersSchema,
  preferences: z.strictObject({
    timezone: z.string(),
    reportingCurrency: z.string(),
  }),
  ...purchaseExportSnapshotSchema.shape,
  summary: purchaseSummarySchema,
});
export type LifecycleExport = z.infer<typeof lifecycleExportSchema>;
export type DisconnectRequest = z.infer<typeof disconnectRequestSchema>;
export type DeleteDataRequest = z.infer<typeof deleteDataRequestSchema>;
export type AccountDeleteRequest = z.infer<typeof accountDeleteRequestSchema>;
