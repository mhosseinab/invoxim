import { z } from "zod";
import {
  createOutlookGraphTransport,
  validateOutlookId,
} from "../discovery/outlook-transport";

const identity = z.object({
  id: z.string(),
  subject: z.string().max(998).nullish(),
  from: z
    .object({
      emailAddress: z.object({
        name: z.string().max(498).optional(),
        address: z
          .string()
          .max(254)
          .regex(/^[^\r\n<>]+$/),
      }),
    })
    .nullish(),
});
const attachments = z.object({
  value: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        name: z.string().max(255),
        contentType: z.string().min(1).max(100),
        size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .max(8),
  "@odata.nextLink": z.unknown().optional(),
});

/** Explicit inspection only: no body, MIME, file bytes, or provider-provided URL. */
export async function loadOutlookReviewMetadata(
  messageId: string,
  accessToken: string,
  assertCurrent: () => Promise<void>,
  fetcher: typeof fetch = fetch,
) {
  validateOutlookId(messageId);
  const request = createOutlookGraphTransport(accessToken, 5, fetcher);
  const base = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`;
  const signal = AbortSignal.timeout(20000);
  await assertCurrent();
  const message = identity.parse(
    await request(
      `${base}?${new URLSearchParams({ $select: "id,subject,from" })}`,
      signal,
      "metadata",
    ),
  );
  if (message.id !== messageId) throw new Error("OUTLOOK_REVIEW_METADATA");
  await assertCurrent();
  const files = attachments.parse(
    await request(
      `${base}/attachments?${new URLSearchParams({ $select: "id,name,contentType,size", $top: "8" })}`,
      signal,
      "collection",
    ),
  );
  if (
    files["@odata.nextLink"] !== undefined ||
    new Set(files.value.map((file) => file.id)).size !== files.value.length
  )
    throw new Error("OUTLOOK_REVIEW_METADATA");
  const sender = message.from?.emailAddress;
  return {
    subject: message.subject ?? null,
    sender: sender
      ? sender.name
        ? `${sender.name} <${sender.address}>`
        : sender.address
      : null,
    attachments: files.value.map((file) => ({
      filename: file.name,
      mimeType: file.contentType,
      size: file.size,
    })),
    originalUrl: null,
  };
}
