import { z } from "zod";
import { mailboxConnectionViewSchema } from "./mailbox";
import { storageConnectionViewSchema } from "./storage";

export const connectionsResponseSchema = z.strictObject({
  connections: z
    .array(z.union([mailboxConnectionViewSchema, storageConnectionViewSchema]))
    .max(10),
  hasMore: z.boolean(),
});

