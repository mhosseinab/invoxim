/**
 * Bounded JSON body/response reading shared by auth, AI, mailbox, discovery
 * and worker routes (D8, W8, S10). Callers map `BoundedJsonError.reason` onto
 * their own error type; this module stays provider-agnostic.
 */

export type BoundedJsonFailure =
  | "content-type"
  | "content-length"
  | "redirect"
  | "body-missing"
  | "too-large"
  | "invalid-json"
  | "aborted";

export class BoundedJsonError extends Error {
  constructor(readonly reason: BoundedJsonFailure) {
    super(reason);
  }
}

/** W8: worker `json()` refuses serialized responses above 128 KiB. */
export const MAX_JSON_RESPONSE_BYTES = 128 * 1024;

const MAX_DATA_CHUNKS = 4096;
const MAX_EMPTY_CHUNKS = 32;

function checkLimit(maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new BoundedJsonError("too-large");
}

/**
 * Read at most `maxBytes` from `body` and parse JSON. Rejects as `too-large`
 * on the byte cap or on excessive empty/data chunks, matching the bounded
 * readers in auth/http, ai/http, mailbox/* and discovery/*.
 */
export async function readBoundedJson(
  body: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
  options?: { signal?: AbortSignal; deadline?: number },
): Promise<unknown> {
  checkLimit(maxBytes);
  if (!body) throw new BoundedJsonError("body-missing");
  const reader = body.getReader();
  const signal = options?.signal;
  const deadline = options?.deadline;
  const cancelled = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelled, { once: true });
  const checkDeadline = () => {
    if (signal?.aborted || (deadline !== undefined && Date.now() >= deadline))
      throw new BoundedJsonError("aborted");
  };
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  let dataChunks = 0;
  let emptyChunks = 0;
  let completed = false;
  try {
    while (true) {
      checkDeadline();
      const item = await reader.read();
      checkDeadline();
      if (item.done) {
        completed = true;
        break;
      }
      if (item.value.byteLength === 0) {
        if (++emptyChunks > MAX_EMPTY_CHUNKS)
          throw new BoundedJsonError("too-large");
        continue;
      }
      if (++dataChunks > MAX_DATA_CHUNKS || item.value.byteLength > maxBytes - size)
        throw new BoundedJsonError("too-large");
      bytes.set(item.value, size);
      size += item.value.byteLength;
    }
    checkDeadline();
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes.subarray(0, size),
        ),
      );
    } catch {
      throw new BoundedJsonError("invalid-json");
    }
  } catch (error) {
    if (!completed) cancelled();
    if (error instanceof BoundedJsonError) throw error;
    if (signal?.aborted || (deadline !== undefined && Date.now() >= deadline))
      throw new BoundedJsonError("aborted");
    throw new BoundedJsonError("too-large");
  } finally {
    signal?.removeEventListener("abort", cancelled);
    reader.releaseLock();
  }
}

function declaredOverCap(
  headers: Headers,
  maxBytes: number,
): boolean {
  // Missing headers read as 0 and malformed ones as NaN; neither is > cap, so
  // those fall through to the streamed byte limit (auth/http, ai/http).
  return Number(headers.get("content-length") ?? 0) > maxBytes;
}

/** Request-body JSON read with the auth/http content-type and length pins. */
export async function readJsonRequestBody(
  request: Request,
  maxBytes: number,
  options?: { signal?: AbortSignal; deadline?: number },
): Promise<unknown> {
  checkLimit(maxBytes);
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new BoundedJsonError("content-type");
  if (declaredOverCap(request.headers, maxBytes))
    throw new BoundedJsonError("content-length");
  return readBoundedJson(request.body, maxBytes, options);
}

/**
 * Response-body JSON read. 3xx is refused before the body is parsed (callers
 * fetch with `redirect: "manual"`), matching mailbox/* and discovery/*.
 */
export async function readJsonResponseBody(
  response: Response,
  maxBytes: number,
  options?: { signal?: AbortSignal; deadline?: number },
): Promise<unknown> {
  checkLimit(maxBytes);
  if (response.status >= 300 && response.status < 400)
    throw new BoundedJsonError("redirect");
  if (declaredOverCap(response.headers, maxBytes))
    throw new BoundedJsonError("content-length");
  return readBoundedJson(response.body, maxBytes, options);
}

/**
 * Serialize `value` as a JSON response under the W8 128 KiB cap. Throws
 * `BoundedJsonError("too-large")` when the encoded body exceeds the cap so
 * the caller can emit its own 413 shape.
 */
export function boundedJsonResponse(
  value: unknown,
  init?: { status?: number; headers?: HeadersInit },
): Response {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > MAX_JSON_RESPONSE_BYTES)
    throw new BoundedJsonError("too-large");
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(body, {
    status: init?.status ?? 200,
    headers,
  });
}

const HTTP_DATE =
  /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const MAX_RETRY_AFTER_CHARS = 128;
/** Longer than a day is a pause sentinel so callers cannot shorten it. */
const RETRY_AFTER_PAUSE_SENTINEL = 86400001;
const MAX_RETRY_AFTER_MS = 86400000;
const MIN_RETRY_AFTER_MS = 1000;

/**
 * Parse a Retry-After header (delay-seconds or HTTP-date) into milliseconds.
 *
 * Malformed-date fallback (G5): a non-numeric value that is not a strict
 * HTTP-date is treated as absent (`undefined`) rather than fed to `Date.parse`,
 * so garbage can never become an elapsed (negative) cooldown. Callers apply
 * their own default when the result is `undefined`.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  if (value.length > MAX_RETRY_AFTER_CHARS) return RETRY_AFTER_PAUSE_SENTINEL;
  const numeric = /^\d+$/.test(value);
  if (!numeric && !HTTP_DATE.test(value)) return undefined;
  const milliseconds = numeric
    ? Number(value) * 1000
    : Date.parse(value) - now;
  if (!numeric && !Number.isFinite(milliseconds)) return undefined;
  return Number.isSafeInteger(milliseconds) && milliseconds <= MAX_RETRY_AFTER_MS
    ? Math.max(MIN_RETRY_AFTER_MS, milliseconds)
    : RETRY_AFTER_PAUSE_SENTINEL;
}
