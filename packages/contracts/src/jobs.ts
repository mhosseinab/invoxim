import { z } from "zod";

/** W12: one queue-message schema for the worker's JOBS queue. */
export const queueMessageSchema = z.union([
  z.strictObject({
    schemaVersion: z.literal(1),
    jobId: z.string().min(1).max(256),
  }),
  z.strictObject({ schemaVersion: z.literal(1), dispatch: z.literal(true) }),
]);
export type QueueMessage = z.infer<typeof queueMessageSchema>;
export const syncRequestSchema = z.strictObject({});
export const syncQueuedResponseSchema = z.strictObject({
  jobId: z.string().min(1).max(256),
});
