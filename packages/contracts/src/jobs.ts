import { z } from "zod";

export const syncRequestSchema = z.strictObject({});
export const syncQueuedResponseSchema = z.strictObject({
  jobId: z.string().min(1).max(256),
});
