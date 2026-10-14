import { z } from "zod";
import {
  connectionIdSchema as connectionId,
  connectionStartRequestSchema,
  connectionStartResponseSchema,
  generationSchema as generation,
} from "./primitives";

const credentialVersion = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const mailboxStartRequestSchema = connectionStartRequestSchema;
export const mailboxStartResponseSchema = connectionStartResponseSchema;
export const mailboxConnectionViewSchema = z.strictObject({
  id: connectionId,
  provider: z.enum(["gmail", "outlook"]),
  kind: z.literal("mailbox"),
  address: z.email().max(254),
  state: z.enum(["connected", "needs_reconnect", "disconnected"]),
  schedulingState: z.enum(["awaiting_import", "active", "paused"]),
  generation,
  credentialVersion,
  configured: z.boolean(),
});
export const mailboxConnectionsResponseSchema = z.strictObject({
  connections: z.array(mailboxConnectionViewSchema).max(10),
  hasMore: z.boolean(),
});
export const mailboxDisconnectRequestSchema = z.strictObject({
  generation,
  credentialVersion,
});

export type MailboxStartRequest = z.infer<typeof mailboxStartRequestSchema>;
export type MailboxConnectionView = z.infer<typeof mailboxConnectionViewSchema>;
export type MailboxDisconnectRequest = z.infer<
  typeof mailboxDisconnectRequestSchema
>;
