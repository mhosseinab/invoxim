import type { DiscoveryProviderPort } from "@invoxim/core";
import { DiscoveryError } from "@invoxim/core";
import { z } from "zod";
export const GMAIL_QUERY_VERSION = 1;
const terms = [
  "invoice",
  "receipt",
  "payment",
  "refund",
  "order",
  "rechnung",
  "quittung",
  "facture",
  "reçu",
  "factura",
  "recibo",
  "fattura",
  "scontrino",
  "pedido",
  "zahlung",
  "bestellung",
  "rückerstattung",
];
const idSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
const historyIdSchema = z.string().regex(/^[0-9]{1,40}$/);
const tokenSchema = z.string().min(1).max(4096);
const refSchema = z.object({ id: idSchema });
const listSchema = z.object({
  messages: z.array(refSchema).max(5).optional(),
  nextPageToken: tokenSchema.optional(),
});
const historySchema = z.object({
  history: z
    .array(
      z.object({
        messages: z.array(refSchema).max(500).optional(),
        messagesAdded: z
          .array(z.object({ message: refSchema }))
          .max(500)
          .optional(),
        messagesDeleted: z
          .array(z.object({ message: refSchema }))
          .max(500)
          .optional(),
        labelsAdded: z
          .array(z.object({ message: refSchema }))
          .max(500)
          .optional(),
        labelsRemoved: z
          .array(z.object({ message: refSchema }))
          .max(500)
          .optional(),
      }),
    )
    .max(5)
    .optional(),
  nextPageToken: tokenSchema.optional(),
  historyId: historyIdSchema,
});
const metadataSchema = z.object({
  id: idSchema,
  internalDate: z.string().regex(/^[0-9]{1,16}$/),
  labelIds: z.array(z.string().max(256)).max(100).optional(),
  payload: z
    .object({
      headers: z
        .array(
          z.object({ name: z.string().max(100), value: z.string().max(8192) }),
        )
        .max(30)
        .optional(),
    })
    .optional(),
});
/** Per-invocation approved token; endpoint/selection are server-owned constants. */
export function createGmailDiscovery(
  accessToken: string,
): DiscoveryProviderPort {
  let requests = 0;
  async function request(
    path: string,
    parameters: URLSearchParams,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted || ++requests > 12)
      throw new DiscoveryError("UNAVAILABLE");
    const url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
    );
    url.search = parameters.toString();
    const deadlineAt = Date.now() + 10000;
    const controller = new AbortController();
    const aborted = () => controller.abort();
    signal.addEventListener("abort", aborted, { once: true });
    const timer = setTimeout(aborted, 10000);
    function ensureActive() {
      if (
        signal.aborted ||
        controller.signal.aborted ||
        Date.now() >= deadlineAt
      )
        throw new DiscoveryError("UNAVAILABLE");
    }
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok)
        console.warn("gmail_request_failed", {
          operation: path === "profile" ? "profile" : "discovery",
          status: response.status,
        });
      if (response.status === 404)
        throw new DiscoveryError(
          path === "history"
            ? "HISTORY_EXPIRED"
            : path.startsWith("messages/")
              ? "SOURCE_UNAVAILABLE"
              : "UNAVAILABLE",
        );
      if (response.status === 401) throw new DiscoveryError("AUTH_REQUIRED");
      if (response.status === 429 || response.status === 503) {
        const value = response.headers.get("retry-after");
        const numeric = value !== null && /^[0-9]+$/.test(value);
        const delayMs = numeric
          ? Number(value) * 1000
          : value
            ? Date.parse(value) - Date.now()
            : 30000;
        throw new DiscoveryError(
          "RATE_LIMITED",
          Number.isFinite(delayMs)
            ? Math.max(1000, delayMs)
            : numeric
              ? 86400001
              : 30000,
        );
      }
      if (!response.ok || (response.status >= 300 && response.status < 400))
        throw new DiscoveryError("UNAVAILABLE");
      const reader = response.body?.getReader();
      if (!reader) throw new DiscoveryError("UNAVAILABLE");
      const bytes = new Uint8Array(65536);
      let length = 0;
      let chunks = 0;
      let emptyChunks = 0;
      try {
        while (true) {
          ensureActive();
          const item = await reader.read();
          ensureActive();
          if (item.done) break;
          if (item.value.byteLength === 0) emptyChunks++;
          else chunks++;
          if (
            chunks > 4096 ||
            emptyChunks > 32 ||
            length + item.value.byteLength > bytes.length
          )
            throw new DiscoveryError("UNAVAILABLE");
          bytes.set(item.value, length);
          length += item.value.byteLength;
        }
      } catch (cause) {
        void reader.cancel().catch(() => undefined);
        throw cause;
      } finally {
        reader.releaseLock();
      }
      ensureActive();
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes.subarray(0, length),
        ),
      );
    } catch (cause) {
      if (cause instanceof DiscoveryError) throw cause;
      throw new DiscoveryError("UNAVAILABLE");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    }
  }
  function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new DiscoveryError("UNAVAILABLE");
    return result.data;
  }
  return {
    async anchor(signal) {
      return parsed(
        z.object({ historyId: historyIdSchema }),
        await request(
          "profile",
          new URLSearchParams({ fields: "historyId" }),
          signal,
        ),
      ).historyId;
    },
    async list(input) {
      const before = Math.ceil(input.range.cutoffMs / 1000) + 1;
      const after = Math.max(0, Math.floor(input.range.startMs / 1000) - 1);
      const selection =
        input.queryMode === "filtered"
          ? ` {${terms.join(" ")} has:attachment}`
          : "";
      const parameters = new URLSearchParams({
        maxResults: "5",
        includeSpamTrash: "false",
        q: `after:${after} before:${before}${selection}`,
        fields: "messages/id,nextPageToken",
      });
      if (input.pageToken)
        parameters.set("pageToken", tokenSchema.parse(input.pageToken));
      const result = parsed(
        listSchema,
        await request("messages", parameters, input.signal),
      );
      return {
        ids: [...new Set(result.messages?.map((message) => message.id) ?? [])],
        ...(result.nextPageToken
          ? { nextPageToken: result.nextPageToken }
          : {}),
      };
    },
    async metadata(id, _mode, signal) {
      idSchema.parse(id);
      const parameters = new URLSearchParams({
        format: "metadata",
        fields: "id,internalDate,labelIds,payload/headers",
      });
      parameters.append("metadataHeaders", "Subject");
      parameters.append("metadataHeaders", "From");
      let result: z.infer<typeof metadataSchema>;
      try {
        result = parsed(
          metadataSchema,
          await request(
            `messages/${encodeURIComponent(id)}`,
            parameters,
            signal,
          ),
        );
      } catch (cause) {
        if (
          cause instanceof DiscoveryError &&
          cause.code === "SOURCE_UNAVAILABLE"
        ) {
          return {
            id,
            receivedAtMs: 0,
            available: false,
            excluded: true,
            candidate: "unknown",
          };
        }
        throw cause;
      }
      if (result.id !== id) throw new DiscoveryError("UNAVAILABLE");
      const receivedAtMs = Number(result.internalDate);
      if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0)
        throw new DiscoveryError("UNAVAILABLE");
      const text = (result.payload?.headers ?? [])
        .filter((header) =>
          ["subject", "from"].includes(header.name.toLowerCase()),
        )
        .map((header) => header.value.toLowerCase())
        .join(" ");
      return {
        id,
        receivedAtMs,
        available: true,
        excluded:
          result.labelIds?.some(
            (label) => label === "SPAM" || label === "TRASH",
          ) ?? false,
        candidate: terms.some((term) => text.includes(term))
          ? "matched"
          : "unknown",
      };
    },
    async history(input) {
      historyIdSchema.parse(input.historyId);
      const parameters = new URLSearchParams({
        startHistoryId: input.historyId,
        maxResults: "5",
        fields:
          "history/messages/id,history/messagesAdded/message/id,history/messagesDeleted/message/id,history/labelsAdded/message/id,history/labelsRemoved/message/id,nextPageToken,historyId",
      });
      if (input.pageToken)
        parameters.set("pageToken", tokenSchema.parse(input.pageToken));
      const result = parsed(
        historySchema,
        await request("history", parameters, input.signal),
      );
      const ids = new Set<string>();
      const deleted = new Set<string>();
      for (const item of result.history ?? []) {
        for (const ref of item.messages ?? []) ids.add(ref.id);
        for (const ref of [
          ...(item.messagesAdded ?? []),
          ...(item.labelsAdded ?? []),
          ...(item.labelsRemoved ?? []),
        ])
          ids.add(ref.message.id);
        for (const ref of item.messagesDeleted ?? [])
          deleted.add(ref.message.id);
      }
      if (ids.size + deleted.size > 500)
        throw new DiscoveryError("UNAVAILABLE");
      for (const id of deleted) ids.delete(id);
      return {
        ids: [...ids],
        deletedIds: [...deleted],
        historyId: result.historyId,
        ...(result.nextPageToken
          ? { nextPageToken: result.nextPageToken }
          : {}),
      };
    },
  };
}
