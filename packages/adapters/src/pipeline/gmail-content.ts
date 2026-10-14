import { DOCUMENT_LIMITS } from "@invoxim/core";
import type {
  GmailAttachmentContent,
  GmailDocumentInputResult,
} from "../documents/gmail";
import { normalizeGmailDocumentInput } from "../documents/gmail";
import {
  attachmentBatchRequest,
  GMAIL_BATCH_URL,
  GmailBatchError,
  parseAttachmentBatch,
  retryAfterMs,
} from "./gmail-batch";

export class ContentError extends Error {
  constructor(
    readonly code:
      | "CONTENT_AUTH_CHANGED"
      | "CONTENT_UNAVAILABLE"
      | "CONTENT_AUTH_REQUIRED"
      | "CONTENT_SOURCE_UNAVAILABLE"
      | "CONTENT_BYTE_LIMIT",
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}
export interface ContentLoadInput {
  connectionId: string;
  providerMessageId: string;
  /** Server-owned persisted part identity for one inference stage. */
  partKey?: string;
  signal: AbortSignal;
  checkpoint: () => Promise<boolean>;
}
export interface TransientContentReader {
  load(input: ContentLoadInput): Promise<GmailDocumentInputResult>;
}
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);

/** Fixed Gmail endpoints; decoded content is returned only to the transient parser. */
export function createGmailContentReader(
  accessToken: string,
  options: { fetcher?: typeof fetch } = {},
): TransientContentReader {
  const fetcher = options.fetcher ?? fetch;
  return {
    async load(input) {
      if (!validId(input.providerMessageId))
        throw new ContentError("CONTENT_UNAVAILABLE");
      let requests = 0;
      let responseBytes = 0;
      async function request(
        path: string,
        batch?: ReturnType<typeof attachmentBatchRequest>,
      ): Promise<unknown> {
        if (input.signal.aborted || !(await input.checkpoint()))
          throw new ContentError("CONTENT_AUTH_CHANGED");
        if (++requests > 9) throw new ContentError("CONTENT_UNAVAILABLE");
        const deadlineAt = Date.now() + 10000;
        const controller = new AbortController();
        const abort = () => controller.abort();
        input.signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, 10000);
        function ensureActive() {
          if (input.signal.aborted)
            throw new ContentError("CONTENT_AUTH_CHANGED");
          if (controller.signal.aborted || Date.now() >= deadlineAt)
            throw new ContentError("CONTENT_UNAVAILABLE");
        }
        try {
          if (input.signal.aborted)
            throw new ContentError("CONTENT_AUTH_CHANGED");
          const response = await fetcher(
            batch
              ? GMAIL_BATCH_URL
              : `https://gmail.googleapis.com/gmail/v1/users/me/messages/${path}`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                ...(batch ? { "Content-Type": batch.contentType } : {}),
              },
              ...(batch ? { method: "POST", body: batch.body } : {}),
              redirect: "manual",
              signal: controller.signal,
            },
          );
          if (response.status === 401)
            throw new ContentError("CONTENT_AUTH_REQUIRED");
          if (response.status === 404)
            throw new ContentError("CONTENT_SOURCE_UNAVAILABLE");
          if (!response.ok) {
            console.warn("gmail_content_http_failure", {
              operation: batch
                ? "batch"
                : path.includes("/attachments/")
                  ? "attachment"
                  : "message",
              status: response.status,
            });
            throw new ContentError(
              "CONTENT_UNAVAILABLE",
              retryAfterMs(response.headers.get("Retry-After")) ??
                (response.status === 429 ? 30000 : undefined),
            );
          }
          const reader = response.body?.getReader();
          if (!reader) throw new ContentError("CONTENT_UNAVAILABLE");
          const cancel = () => {
            void reader.cancel().catch(() => undefined);
          };
          controller.signal.addEventListener("abort", cancel, { once: true });
          const maxResponseBytes =
            Math.ceil((DOCUMENT_LIMITS.bytes * 4) / 3) + 65536;
          // Only the remaining aggregate allowance can be retained by this request.
          const bytes = new Uint8Array(maxResponseBytes - responseBytes);
          let length = 0;
          let chunks = 0;
          let emptyChunks = 0;
          try {
            while (true) {
              ensureActive();
              const chunk = await reader.read();
              ensureActive();
              if (chunk.done) break;
              if (chunk.value.byteLength === 0) emptyChunks++;
              else chunks++;
              if (chunks > 4096 || emptyChunks > 32)
                throw new ContentError("CONTENT_UNAVAILABLE");
              length += chunk.value.byteLength;
              responseBytes += chunk.value.byteLength;
              // Base64 + bounded MIME/header framing. Never buffer an unbounded JSON body.
              if (
                responseBytes >
                Math.ceil((DOCUMENT_LIMITS.bytes * 4) / 3) + 65536
              ) {
                throw new ContentError("CONTENT_BYTE_LIMIT");
              }
              bytes.set(chunk.value, length - chunk.value.byteLength);
            }
          } catch (cause) {
            void reader.cancel().catch(() => undefined);
            throw cause;
          } finally {
            controller.signal.removeEventListener("abort", cancel);
            reader.releaseLock();
          }
          ensureActive();
          const text = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: false,
          }).decode(bytes.subarray(0, length));
          return batch
            ? {
                text,
                contentType: response.headers.get("Content-Type") ?? "",
                retryAfterMs: retryAfterMs(response.headers.get("Retry-After")),
              }
            : JSON.parse(text);
        } catch (cause) {
          if (cause instanceof ContentError) throw cause;
          throw new ContentError(
            input.signal.aborted
              ? "CONTENT_AUTH_CHANGED"
              : "CONTENT_UNAVAILABLE",
          );
        } finally {
          clearTimeout(timer);
          input.signal.removeEventListener("abort", abort);
        }
      }
      const response = await request(
        `${encodeURIComponent(input.providerMessageId)}?format=full&fields=id,payload`,
      );
      if (!response || typeof response !== "object")
        throw new ContentError("CONTENT_UNAVAILABLE");
      const message = response as { id?: unknown; payload?: unknown };
      if (message.id !== input.providerMessageId)
        throw new ContentError("CONTENT_UNAVAILABLE");
      const pending = [{ value: message.payload, depth: 1 }];
      const attachments = new Map<string, GmailAttachmentContent>();
      const refs: { id: string; size: number; partKey: string }[] = [];
      let selectedPayload: unknown;
      const identities = new Set<string>();
      let count = 0,
        bytes = 0;
      while (pending.length) {
        const entry = pending.pop();
        if (!entry) break;
        if (++count > DOCUMENT_LIMITS.parts)
          return { status: "incomplete", code: "part_limit" };
        if (entry.depth > DOCUMENT_LIMITS.depth)
          return { status: "incomplete", code: "depth_limit" };
        if (!entry.value || typeof entry.value !== "object")
          return { status: "unreadable", code: "invalid_mime" };
        const part = entry.value as {
          partId?: unknown;
          mimeType?: unknown;
          parts?: unknown;
          body?: { size?: unknown; attachmentId?: unknown };
        };
        if (
          typeof part.partId !== "string" ||
          part.partId.length > 256 ||
          identities.has(part.partId) ||
          typeof part.mimeType !== "string" ||
          !part.mimeType ||
          part.mimeType.length > 128
        )
          return { status: "unreadable", code: "invalid_mime" };
        identities.add(part.partId);
        if (part.partId === input.partKey) selectedPayload = entry.value;
        if (
          part.parts !== undefined &&
          (!Array.isArray(part.parts) || part.parts.length > 0)
        ) {
          if (!Array.isArray(part.parts))
            return { status: "unreadable", code: "invalid_mime" };
          if (part.parts.length > DOCUMENT_LIMITS.parts - count)
            return { status: "incomplete", code: "part_limit" };
          for (const child of part.parts)
            pending.push({ value: child, depth: entry.depth + 1 });
        } else {
          if (
            !part.body ||
            !Number.isSafeInteger(part.body.size) ||
            Number(part.body.size) < 0
          )
            return { status: "unreadable", code: "invalid_mime" };
          bytes += Number(part.body.size);
          if (bytes > DOCUMENT_LIMITS.bytes)
            return { status: "incomplete", code: "byte_limit" };
          if (part.body.attachmentId !== undefined) {
            if (
              typeof part.body.attachmentId !== "string" ||
              !/^[A-Za-z0-9_-]{1,4096}$/.test(part.body.attachmentId)
            )
              return { status: "unreadable", code: "invalid_mime" };
            refs.push({
              id: part.body.attachmentId,
              partKey: part.partId,
              size: Number(part.body.size),
            });
          }
        }
      }
      if (input.partKey !== undefined && selectedPayload === undefined)
        throw new ContentError("CONTENT_SOURCE_UNAVAILABLE");
      const selectedRefs =
        input.partKey === undefined
          ? refs
          : refs.filter((ref) => ref.partKey === input.partKey);
      if (new Set(selectedRefs.map((ref) => ref.id)).size > 8)
        return { status: "incomplete", code: "part_limit" };
      const uniqueRefs = [
        ...new Map(selectedRefs.map((ref) => [ref.id, ref])).values(),
      ];
      let values: unknown[];
      if (uniqueRefs.length >= 2) {
        const batch = attachmentBatchRequest(
          input.providerMessageId,
          uniqueRefs,
        );
        const response = (await request("", batch)) as {
          text: string;
          contentType: string;
          retryAfterMs?: number;
        };
        let results: ReturnType<typeof parseAttachmentBatch>;
        try {
          results = parseAttachmentBatch(
            response.text,
            response.contentType,
            uniqueRefs.length,
          );
        } catch (cause) {
          console.warn("gmail_attachment_batch_invalid", {
            reason: cause instanceof GmailBatchError ? cause.reason : "json",
          });
          throw new ContentError("CONTENT_UNAVAILABLE");
        }
        const failures = results.filter((result) => result.status !== 200);
        if (failures.length) {
          const retry = Math.max(
            response.retryAfterMs ?? 0,
            ...failures.map((result) => result.retryAfterMs ?? 0),
          );
          const code = failures.some((result) => result.status === 401)
            ? "CONTENT_AUTH_REQUIRED"
            : failures.some((result) => result.status === 404)
              ? "CONTENT_SOURCE_UNAVAILABLE"
              : "CONTENT_UNAVAILABLE";
          throw new ContentError(
            code,
            code === "CONTENT_UNAVAILABLE" ? retry || undefined : undefined,
          );
        }
        values = results.map((result) => result.value);
      } else {
        values = [];
        for (const ref of uniqueRefs)
          values.push(
            await request(
              `${encodeURIComponent(input.providerMessageId)}/attachments/${encodeURIComponent(ref.id)}`,
            ),
          );
      }
      for (const [index, ref] of uniqueRefs.entries()) {
        const value = values[index];
        if (!value || typeof value !== "object")
          throw new ContentError("CONTENT_UNAVAILABLE");
        const body = value as { size?: unknown; data?: unknown };
        if (body.size !== ref.size || typeof body.data !== "string")
          return { status: "unreadable", code: "invalid_mime" };
        attachments.set(ref.id, { size: ref.size, data: body.data });
      }
      return normalizeGmailDocumentInput({
        connectionId: input.connectionId,
        providerMessageId: input.providerMessageId,
        payload:
          input.partKey === undefined ? message.payload : selectedPayload,
        attachments,
      });
    },
  };
}
