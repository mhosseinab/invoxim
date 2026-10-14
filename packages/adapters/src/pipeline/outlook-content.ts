import type { MimePart } from "@invoxim/core";
import { DOCUMENT_LIMITS } from "@invoxim/core";
import { z } from "zod";
import { hashJsonValue } from "../hash";
import type { ContentLoadInput, TransientContentReader } from "./content-types";
import { ContentError } from "./content-types";

const idSchema = z.string().regex(/^[A-Za-z0-9_+=/-]{1,256}$/);
const bodySchema = z.object({
  id: idSchema,
  body: z.object({
    contentType: z.enum(["text", "html"]),
    content: z.string(),
  }),
  hasAttachments: z.boolean(),
});
const attachmentSchema = z.object({
  "@odata.type": z.enum([
    "#microsoft.graph.fileAttachment",
    "#microsoft.graph.referenceAttachment",
    "#microsoft.graph.itemAttachment",
  ]),
  id: idSchema,
  name: z.string().max(256),
  contentType: z.string().min(1).max(128),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  isInline: z.boolean(),
  contentId: z.string().max(256).optional(),
  contentBytes: z.string().optional(),
});
const attachmentsSchema = z.object({
  value: z.array(attachmentSchema).max(8),
  "@odata.nextLink": z.string().optional(),
});
function cancel(response: Response) {
  if (response.body && !response.body.locked)
    void response.body.cancel().catch(() => undefined);
}
function decode(value: string): Uint8Array | null {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    return null;
  try {
    const binary = atob(value);
    if (btoa(binary) !== value) return null;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}
async function attachmentKey(messageId: string, attachmentId: string) {
  // Graph IDs may occupy all 256 characters; a deterministic key remains within part limits.
  return `attachment:${await hashJsonValue([messageId, attachmentId])}`;
}
/** Graph-supplied body/files only; external references never become fetch destinations. */
export function createOutlookContentReader(
  accessToken: string,
  options: { fetcher?: typeof fetch } = {},
): TransientContentReader {
  if (!/^[\x21-\x7e]{1,8192}$/.test(accessToken))
    throw new ContentError("CONTENT_UNAVAILABLE");
  const fetcher = options.fetcher ?? fetch;
  return {
    async load(input: ContentLoadInput) {
      if (!idSchema.safeParse(input.providerMessageId).success)
        throw new ContentError("CONTENT_UNAVAILABLE");
      const controller = new AbortController();
      const abort = () => controller.abort();
      input.signal.addEventListener("abort", abort, { once: true });
      const deadline = Date.now() + 10000;
      const timer = setTimeout(abort, 10000);
      const responses = new Set<Response>();
      const responseLimit = Math.ceil((DOCUMENT_LIMITS.bytes * 4) / 3) + 65536;
      let responseBytes = 0;
      const error = () =>
        new ContentError(
          input.signal.aborted ? "CONTENT_AUTH_CHANGED" : "CONTENT_UNAVAILABLE",
        );
      let stop: (() => void) | undefined;
      const stopped = new Promise<never>((_, reject) => {
        stop = () => reject(error());
        controller.signal.addEventListener("abort", stop, { once: true });
      });
      void stopped.catch(() => undefined);
      function active() {
        if (
          input.signal.aborted ||
          controller.signal.aborted ||
          Date.now() >= deadline
        )
          throw error();
      }
      async function checkpoint() {
        active();
        if (!(await input.checkpoint()))
          throw new ContentError("CONTENT_AUTH_CHANGED");
        active();
      }
      async function request(url: string): Promise<unknown> {
        await checkpoint();
        const pending = Promise.resolve()
          .then(() => {
            active();
            return fetcher(url, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                Prefer: 'IdType="ImmutableId"',
              },
              redirect: "manual",
              signal: controller.signal,
            });
          })
          .then((response) => {
            if (
              controller.signal.aborted ||
              input.signal.aborted ||
              Date.now() >= deadline
            ) {
              cancel(response);
              throw error();
            }
            responses.add(response);
            return response;
          });
        const response = await Promise.race([pending, stopped]);
        if (response.status === 401 || response.status === 403)
          throw new ContentError("CONTENT_AUTH_REQUIRED");
        if (response.status === 404)
          throw new ContentError("CONTENT_SOURCE_UNAVAILABLE");
        if (
          response.status !== 200 ||
          response.headers
            .get("content-type")
            ?.split(";")[0]
            ?.trim()
            .toLowerCase() !== "application/json"
        )
          throw new ContentError("CONTENT_UNAVAILABLE");
        const declared = response.headers.get("content-length");
        if (
          declared !== null &&
          (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))
        )
          throw new ContentError("CONTENT_UNAVAILABLE");
        if (
          declared !== null &&
          Number(declared) > responseLimit - responseBytes
        )
          throw new ContentError("CONTENT_BYTE_LIMIT");
        const reader = response.body?.getReader();
        if (!reader) throw new ContentError("CONTENT_UNAVAILABLE");
        const bytes = new Uint8Array(responseLimit - responseBytes);
        let length = 0,
          chunks = 0,
          empty = 0;
        try {
          while (true) {
            active();
            const chunk = await Promise.race([reader.read(), stopped]);
            active();
            if (chunk.done) break;
            if (chunk.value.byteLength === 0) empty++;
            else chunks++;
            if (empty > 32 || chunks > 4096)
              throw new ContentError("CONTENT_UNAVAILABLE");
            if (chunk.value.byteLength > bytes.length - length)
              throw new ContentError("CONTENT_BYTE_LIMIT");
            bytes.set(chunk.value, length);
            length += chunk.value.byteLength;
            responseBytes += chunk.value.byteLength;
          }
        } catch (cause) {
          void reader.cancel().catch(() => undefined);
          throw cause;
        } finally {
          reader.releaseLock();
        }
        active();
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
            bytes.subarray(0, length),
          ),
        );
      }
      try {
        const base = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(input.providerMessageId)}`;
        const body = bodySchema.safeParse(
          await request(`${base}?$select=id,body,hasAttachments`),
        );
        if (!body.success || body.data.id !== input.providerMessageId)
          throw new ContentError("CONTENT_SOURCE_UNAVAILABLE");
        const bodyBytes = new TextEncoder().encode(body.data.body.content);
        if (bodyBytes.byteLength > DOCUMENT_LIMITS.bytes)
          return { status: "incomplete", code: "byte_limit" };
        const children: MimePart[] = [
          {
            partId: "body",
            mimeType:
              body.data.body.contentType === "html"
                ? "text/html"
                : "text/plain",
            charset: "utf-8",
            bytes: bodyBytes,
          },
        ];
        // Graph's hasAttachments excludes inline attachments; inspect the collection even when false.
        const attachments = attachmentsSchema.safeParse(
          await request(`${base}/attachments?$top=8`),
        );
        if (!attachments.success)
          return { status: "unreadable", code: "invalid_mime" };
        if (attachments.data["@odata.nextLink"])
          return { status: "incomplete", code: "part_limit" };
        let total = bodyBytes.byteLength;
        const seen = new Set<string>();
        for (const attachment of attachments.data.value) {
          if (seen.has(attachment.id))
            return { status: "unreadable", code: "invalid_mime" };
          seen.add(attachment.id);
          const partId = await attachmentKey(
            input.providerMessageId,
            attachment.id,
          );
          let bytes: Uint8Array = new Uint8Array();
          let mimeType = attachment.contentType;
          if (attachment["@odata.type"] === "#microsoft.graph.fileAttachment") {
            if (
              attachment.size > DOCUMENT_LIMITS.bytes - total ||
              (attachment.contentBytes?.length ?? 0) >
                Math.ceil(((DOCUMENT_LIMITS.bytes - total) * 4) / 3) + 4
            )
              return { status: "incomplete", code: "byte_limit" };
            if (attachment.contentBytes === undefined)
              return { status: "unreadable", code: "invalid_mime" };
            const decoded = decode(attachment.contentBytes);
            if (!decoded)
              return { status: "unreadable", code: "invalid_encoding" };
            if (decoded.byteLength !== attachment.size)
              return { status: "unreadable", code: "invalid_mime" };
            total += decoded.byteLength;
            if (total > DOCUMENT_LIMITS.bytes)
              return { status: "incomplete", code: "byte_limit" };
            bytes = decoded;
          } else {
            mimeType =
              attachment["@odata.type"] ===
              "#microsoft.graph.referenceAttachment"
                ? "application/vnd.microsoft.graph.reference-attachment"
                : "application/vnd.microsoft.graph.item-attachment";
          }
          children.push({
            partId,
            mimeType,
            filename: attachment.name,
            disposition: attachment.isInline ? "inline" : "attachment",
            ...(attachment.contentId
              ? { contentId: attachment.contentId }
              : {}),
            bytes,
          });
        }
        // Returning transient bytes has no external effect. The pipeline checks
        // the accepted processing selection before models and fences every write.
        active();
        const root: MimePart =
          input.partKey === undefined
            ? { partId: "", mimeType: "multipart/mixed", children }
            : (children.find((part) => part.partId === input.partKey) ??
              (() => {
                throw new ContentError("CONTENT_SOURCE_UNAVAILABLE");
              })());
        return {
          status: "ready",
          input: {
            connectionId: input.connectionId,
            providerMessageId: input.providerMessageId,
            root,
          },
        };
      } catch (cause) {
        if (cause instanceof ContentError) throw cause;
        throw new ContentError(
          input.signal.aborted ? "CONTENT_AUTH_CHANGED" : "CONTENT_UNAVAILABLE",
        );
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        if (stop) controller.signal.removeEventListener("abort", stop);
        controller.abort();
        for (const response of responses) cancel(response);
      }
    },
  };
}
