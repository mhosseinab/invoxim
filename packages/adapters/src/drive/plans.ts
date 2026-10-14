import { hasControlCharacters } from "@invoxim/contracts";
import { MAX_ARCHIVE_ORIGINAL_BYTES } from "@invoxim/core";
import { z } from "zod";

const fileId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const workspaceMarker = z.string().regex(/^[A-Za-z0-9_-]{16,96}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const mimeType = z.enum([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "message/rfc822",
]);
const name = z
  .string()
  .min(1)
  .max(180)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= 180 &&
      !hasControlCharacters(value) &&
      !value.includes("/") &&
      !value.includes("\\") &&
      value.trim() === value &&
      value !== "." &&
      value !== "..",
  );

/** Durable upload plan. The 16 MiB cap applies at every boundary (D3). */
export const archiveUploadPlanSchema = z.strictObject({
  fileId,
  parentId: fileId,
  workspaceMarker,
  mimeType,
  size: z.number().int().min(1).max(MAX_ARCHIVE_ORIGINAL_BYTES),
  sha256,
});
export const driveFolderPlanSchema = z.strictObject({
  fileId,
  workspaceMarker,
  name,
});
export const driveOriginalPlanSchema = archiveUploadPlanSchema.extend({ name });
