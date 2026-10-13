import type {
  TransientOriginalReader,
  TransientOriginalResult,
} from "@invoxim/core";
import { MAX_TRANSIENT_ORIGINAL_BYTES, OriginalReadError } from "@invoxim/core";
import { z } from "zod";
import { MAX_ARCHIVE_ORIGINAL_BYTES } from "../../../core/src/archive/workflow-types";

type UnsupportedCode = Extract<
  TransientOriginalResult,
  { status: "unsupported" }
>["code"];
class UnsupportedOriginal extends Error {
  constructor(readonly code: UnsupportedCode) {
    super(code);
  }
}
class MissingOriginal extends Error {}
const tokenSchema = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);
/** Trusted server selection, never supplied by message/model instructions. */
export interface OriginalMailConfiguration {
  provider: "gmail" | "outlook";
  accessToken: string;
  policy: { maxOriginalBytes: number; deadlineMs: number };
}
function cancelResponse(response: Response) {
  if (!response.body || response.body.locked) return;
  void response.body.cancel().catch(() => {});
}
function decodeRaw(raw: string, maxBytes: number) {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(raw))
    throw new UnsupportedOriginal("invalid_encoding");
  const unpadded = raw.replace(/=+$/, "");
  const padding = raw.length - unpadded.length;
  if (
    unpadded.length % 4 === 1 ||
    (padding > 0 &&
      (raw.length % 4 !== 0 || padding !== (4 - (unpadded.length % 4)) % 4))
  )
    throw new UnsupportedOriginal("invalid_encoding");
  if (Math.floor((unpadded.length * 3) / 4) > maxBytes)
    throw new UnsupportedOriginal("byte_limit");
  let decoded: string;
  try {
    decoded = atob(
      unpadded.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (unpadded.length % 4)) % 4),
    );
  } catch {
    throw new UnsupportedOriginal("invalid_encoding");
  }
  if (
    btoa(decoded).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_") !==
    unpadded
  )
    throw new UnsupportedOriginal("invalid_encoding");
  if (decoded.length > maxBytes) throw new UnsupportedOriginal("byte_limit");
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++)
    bytes[index] = decoded.charCodeAt(index);
  return bytes;
}
/** Header shape only: preserves every byte and does not parse/rewrite MIME or recipients. */
function looksLikeOriginal(bytes: Uint8Array) {
  let end = -1;
  for (let index = 0; index < Math.min(bytes.length, 16384); index++) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      end = index;
      break;
    }
    if (bytes[index] === 10 && bytes[index + 1] === 10) {
      end = index;
      break;
    }
  }
  if (end < 1) return false;
  let start = 0,
    known = false,
    hasHeader = false;
  while (start < end) {
    let finish = start;
    while (finish < end && bytes[finish] !== 10) finish++;
    const line = bytes.subarray(
      start,
      finish > start && bytes[finish - 1] === 13 ? finish - 1 : finish,
    );
    if (!line.length || line.includes(0)) return false;
    if (line[0] === 32 || line[0] === 9) {
      if (!hasHeader) return false;
    } else {
      const colon = line.indexOf(58);
      if (
        colon < 1 ||
        line.subarray(0, colon).some((byte) => byte < 33 || byte > 126)
      )
        return false;
      const name = String.fromCharCode(
        ...line.subarray(0, colon),
      ).toLowerCase();
      known ||= [
        "from",
        "to",
        "date",
        "subject",
        "received",
        "mime-version",
        "content-type",
      ].includes(name);
      hasHeader = true;
    }
    start = finish + 1;
  }
  return hasHeader && known;
}
export function createOriginalMailReader(
  configuration: OriginalMailConfiguration,
  options: { fetcher?: typeof fetch; archiveByteLimit?: number } = {},
): TransientOriginalReader {
  const { deadlineMs } = configuration.policy;
  const maxOriginalBytes =
    options.archiveByteLimit ?? configuration.policy.maxOriginalBytes;
  if (
    !["gmail", "outlook"].includes(configuration.provider) ||
    !tokenSchema.safeParse(configuration.accessToken).success ||
    !Number.isSafeInteger(maxOriginalBytes) ||
    maxOriginalBytes < 1 ||
    maxOriginalBytes > MAX_ARCHIVE_ORIGINAL_BYTES ||
    !Number.isSafeInteger(configuration.policy.maxOriginalBytes) ||
    configuration.policy.maxOriginalBytes < 1 ||
    configuration.policy.maxOriginalBytes > MAX_TRANSIENT_ORIGINAL_BYTES ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 100 ||
    deadlineMs > 10000
  )
    throw new OriginalReadError("INVALID_INPUT");
  const fetcher = options.fetcher ?? fetch;
  return {
    async read(input) {
      const pattern =
        configuration.provider === "gmail"
          ? /^[A-Za-z0-9_-]{1,256}$/
          : /^[A-Za-z0-9_+=/-]{1,256}$/;
      if (
        typeof input.providerMessageId !== "string" ||
        !pattern.test(input.providerMessageId)
      )
        throw new OriginalReadError("INVALID_INPUT");
      if (input.signal.aborted) throw new OriginalReadError("CANCELED");
      const deadlineAt = Date.now() + deadlineMs;
      const controller = new AbortController();
      const abort = () => controller.abort();
      input.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, deadlineMs);
      const abortError = () =>
        new OriginalReadError(
          input.signal.aborted ? "CANCELED" : "UNAVAILABLE",
        );
      function ensureActive() {
        if (
          controller.signal.aborted ||
          input.signal.aborted ||
          Date.now() >= deadlineAt
        )
          throw abortError();
      }
      let stop: (() => void) | undefined;
      const stopped = new Promise<never>((_, reject) => {
        stop = () => reject(abortError());
        controller.signal.addEventListener("abort", stop, { once: true });
      });
      const responses = new Set<Response>();
      async function request(
        url: string,
        limit: number,
        mediaTypes: readonly string[],
      ) {
        ensureActive();
        const headers: Record<string, string> = {
          Authorization: `Bearer ${configuration.accessToken}`,
        };
        if (configuration.provider === "outlook")
          headers.Prefer = 'IdType="ImmutableId"';
        const pending = Promise.resolve()
          .then(() =>
            fetcher(url, {
              headers,
              redirect: "manual",
              signal: controller.signal,
            }),
          )
          .then((response) => {
            // A noncooperative transport may resolve after the abort race already returned.
            if (
              controller.signal.aborted ||
              input.signal.aborted ||
              Date.now() >= deadlineAt
            ) {
              cancelResponse(response);
              throw abortError();
            }
            responses.add(response);
            return response;
          });
        const response = await Promise.race([pending, stopped]);
        if (response.status === 404) throw new MissingOriginal();
        if (response.status === 401 || response.status === 403)
          throw new OriginalReadError("AUTH_REQUIRED");
        if (response.status === 429 || response.status === 503) {
          const value = response.headers.get("retry-after");
          const delay =
            value && /^[0-9]+$/.test(value)
              ? Number(value) * 1000
              : value
                ? Date.parse(value) - Date.now()
                : 30000;
          throw new OriginalReadError(
            "RATE_LIMITED",
            Number.isFinite(delay) ? Math.max(1000, delay) : 86400001,
          );
        }
        if (response.status !== 200) throw new OriginalReadError("UNAVAILABLE");
        const type = response.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase();
        if (!type || !mediaTypes.includes(type))
          throw new UnsupportedOriginal("unsupported_type");
        const size = response.headers.get("content-length");
        if (
          size !== null &&
          (!/^[0-9]+$/.test(size) || !Number.isSafeInteger(Number(size)))
        )
          throw new OriginalReadError("UNAVAILABLE");
        if (size !== null && Number(size) > limit)
          throw new UnsupportedOriginal("byte_limit");
        const reader = response.body?.getReader();
        if (!reader) throw new OriginalReadError("UNAVAILABLE");
        // Bound memory independently of transport fragmentation and empty reads.
        const bytes = new Uint8Array(limit);
        let length = 0;
        let chunks = 0;
        let emptyChunks = 0;
        try {
          while (true) {
            ensureActive();
            const chunk = await Promise.race([reader.read(), stopped]);
            ensureActive();
            if (chunk.done) break;
            chunks++;
            if (chunk.value.byteLength === 0) emptyChunks++;
            if (chunks > 4096 || emptyChunks > 32)
              throw new OriginalReadError("UNAVAILABLE");
            if (length + chunk.value.byteLength > limit)
              throw new UnsupportedOriginal("byte_limit");
            bytes.set(chunk.value, length);
            length += chunk.value.byteLength;
          }
        } catch (error) {
          void reader.cancel().catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
        }
        ensureActive();
        return bytes.subarray(0, length);
      }
      function json(bytes: Uint8Array): unknown {
        try {
          return JSON.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
              bytes,
            ),
          );
        } catch {
          throw new OriginalReadError("UNAVAILABLE");
        }
      }
      try {
        const id = encodeURIComponent(input.providerMessageId);
        let bytes: Uint8Array;
        if (configuration.provider === "gmail") {
          const payload = json(
            await request(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=raw&fields=id,raw`,
              Math.ceil((maxOriginalBytes * 4) / 3) + 16384,
              ["application/json"],
            ),
          );
          const parsed = z
            .object({ id: z.string().min(1).max(256), raw: z.string() })
            .safeParse(payload);
          if (!parsed.success) throw new OriginalReadError("UNAVAILABLE");
          if (parsed.data.id !== input.providerMessageId)
            throw new UnsupportedOriginal("source_mismatch");
          bytes = decodeRaw(parsed.data.raw, maxOriginalBytes);
        } else {
          const payload = json(
            await request(
              `https://graph.microsoft.com/v1.0/me/messages/${id}?$select=id`,
              16384,
              ["application/json"],
            ),
          );
          const parsed = z
            .object({ id: z.string().min(1).max(256) })
            .safeParse(payload);
          if (!parsed.success || parsed.data.id !== input.providerMessageId)
            throw new UnsupportedOriginal("source_mismatch");
          bytes = await request(
            `https://graph.microsoft.com/v1.0/me/messages/${id}/$value`,
            maxOriginalBytes,
            ["message/rfc822", "text/plain", "application/octet-stream"],
          );
        }
        ensureActive();
        if (!looksLikeOriginal(bytes))
          throw new UnsupportedOriginal("invalid_original");
        ensureActive();
        return {
          status: "ready",
          bytes,
          mimeType: "message/rfc822",
          extension: ".eml",
          providerMessageId: input.providerMessageId,
        };
      } catch (error) {
        if (error instanceof UnsupportedOriginal)
          return { status: "unsupported", code: error.code };
        if (error instanceof MissingOriginal)
          return { status: "source_unavailable" };
        if (error instanceof OriginalReadError) throw error;
        throw new OriginalReadError("UNAVAILABLE");
      } finally {
        controller.abort();
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        if (stop) controller.signal.removeEventListener("abort", stop);
        for (const response of responses) cancelResponse(response);
        responses.clear();
      }
    },
  };
}
