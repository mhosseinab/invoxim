import { z } from "zod";

const connectionId = z.string().min(1).max(120);
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const archiveVersion = z.number().int().min(0).max(2147483646);
const acceptedAt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const storageStartRequestSchema = z.strictObject({
  connectionId: connectionId.optional(),
});
export const storageStartResponseSchema = z.strictObject({
  authorizationUrl: z.url().max(4096),
});
export const storageConnectionViewSchema = z
  .strictObject({
    id: connectionId,
    provider: z.literal("google-drive"),
    kind: z.literal("storage"),
    address: z.email().max(254),
    state: z.enum(["connected", "needs_reconnect", "disconnected"]),
    generation,
    credentialVersion: version,
    configured: z.boolean(),
    archivingEnabled: z.boolean(),
  })
  .refine(
    (value) =>
      !value.archivingEnabled ||
      (value.configured && value.state === "connected"),
  );
export const storageConnectionsResponseSchema = z.strictObject({
  connections: z.array(storageConnectionViewSchema).max(10),
  hasMore: z.boolean(),
});
export const storageDisconnectRequestSchema = z.strictObject({
  generation,
  credentialVersion: version,
});
export const archiveSettingsViewSchema = z.discriminatedUnion("enabled", [
  z.strictObject({
    version: archiveVersion,
    enabled: z.literal(false),
    connectionId: z.null(),
    generation: z.null(),
    disclosureVersion: z.null(),
    acceptedAt: z.null(),
  }),
  z.strictObject({
    version: archiveVersion.refine((value) => value > 0),
    enabled: z.literal(true),
    connectionId,
    generation,
    disclosureVersion: z.literal(1),
    acceptedAt,
  }),
]);
export const archiveEnableRequestSchema = z.strictObject({
  expectedVersion: archiveVersion,
  connectionId,
  expectedGeneration: generation,
  disclosureVersion: z.literal(1),
});
export const archiveDisableRequestSchema = z.strictObject({
  expectedVersion: archiveVersion,
});
export type StorageConnectionView = z.infer<typeof storageConnectionViewSchema>;
export type ArchiveSettingsView = z.infer<typeof archiveSettingsViewSchema>;
export type ArchiveEnableRequest = z.infer<typeof archiveEnableRequestSchema>;
export type ArchiveDisableRequest = z.infer<typeof archiveDisableRequestSchema>;

export const storageSettingsResponseSchema = z.strictObject({
  authorizationAvailable: z.boolean(),
  archivingAvailable: z.literal(false),
  connections: z.array(storageConnectionViewSchema).max(10),
  hasMore: z.boolean(),
  settings: archiveSettingsViewSchema,
  mutationToken: z.string().min(1).max(2048),
});
export type StorageSettingsResponse = z.infer<
  typeof storageSettingsResponseSchema
>;
