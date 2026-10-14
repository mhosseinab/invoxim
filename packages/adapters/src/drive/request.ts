import { ArchiveServiceError } from "@invoxim/core";
import { z } from "zod";
import { abortable } from "../security/helpers";
import { DriveArchiveError, type DriveHttpTransport } from "./types";

const maximumResponseBytes = 16384;

export async function readDriveJson(
  response: Response,
  signal: AbortSignal,
  deadline: number,
): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^[0-9]+$/.test(length) || Number(length) > maximumResponseBytes)
  )
    throw new DriveArchiveError("invalid_response");
  if (
    response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    throw new DriveArchiveError("invalid_response");
  const reader = response.body?.getReader();
  if (!reader) throw new DriveArchiveError("invalid_response");
  const bytes = new Uint8Array(maximumResponseBytes);
  let size = 0;
  let nonemptyChunks = 0;
  let emptyChunks = 0;
  try {
    while (true) {
      if (signal.aborted || Date.now() >= deadline)
        throw new DriveArchiveError("timeout");
      const next = await abortable(reader.read(), signal, timeoutError);
      if (signal.aborted || Date.now() >= deadline)
        throw new DriveArchiveError("timeout");
      if (next.done) break;
      if (next.value.byteLength === 0) {
        if (++emptyChunks > 32) throw new DriveArchiveError("invalid_response");
        continue;
      }
      if (
        ++nonemptyChunks > 4096 ||
        next.value.byteLength > maximumResponseBytes - size
      )
        throw new DriveArchiveError("invalid_response");
      bytes.set(next.value, size);
      size += next.value.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes.subarray(0, size),
        ),
      );
    } catch {
      throw new DriveArchiveError("invalid_response");
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function timeoutError() {
  return new DriveArchiveError("timeout");
}

/** Map a failed Drive JSON body to a typed transport failure (D1). */
export function mapDriveFailure(
  status: number,
  body: unknown,
): DriveArchiveError {
  const parsed = z
    .object({
      error: z.object({
        errors: z.array(z.object({ reason: z.string().max(128) })).max(10),
      }),
    })
    .safeParse(body);
  const reasons = parsed.success
    ? parsed.data.error.errors.map((item) => item.reason)
    : [];
  if (reasons.includes("storageQuotaExceeded"))
    return new DriveArchiveError("quota_exceeded");
  if (
    reasons.includes("rateLimitExceeded") ||
    reasons.includes("userRateLimitExceeded")
  )
    return new DriveArchiveError("rate_limited");
  return new DriveArchiveError(
    status === 403 ? "permission_denied" : "unavailable",
  );
}

export interface DriveRequestContext {
  http: DriveHttpTransport;
  timeoutMs: number;
  authorize?: () => Promise<void>;
  signal?: AbortSignal;
}

/**
 * One bounded Drive dispatch: token check, authorize hook, abort/deadline
 * handling, redirect policy and shared error mapping (D1). The handler runs
 * before the response body is cancelled by the outer finally block.
 */
export async function driveRequest<T>(
  context: DriveRequestContext,
  accessToken: string,
  url: string,
  init: RequestInit,
  handle: (
    response: Response,
    signal: AbortSignal,
    deadline: number,
  ) => Promise<T>,
  options: { allowResumeStatus?: boolean } = {},
): Promise<T> {
  const { http, timeoutMs, authorize, signal } = context;
  if (
    typeof accessToken !== "string" ||
    !/^[\x21-\x7e]{1,8192}$/.test(accessToken)
  )
    throw new DriveArchiveError("invalid_input");
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;
  try {
    if (controller.signal.aborted) throw new DriveArchiveError("timeout");
    if (authorize)
      await abortable(authorize(), controller.signal, timeoutError);
    if (controller.signal.aborted || Date.now() >= deadline)
      throw new DriveArchiveError("timeout");
    response = await abortable<Response>(
      http(
        new Request(url, {
          ...init,
          headers: {
            ...init.headers,
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
          redirect: "manual",
          signal: controller.signal,
        }),
      ).then((settled) => {
        // Ignored cancellation can settle after the race has already timed out.
        if (controller.signal.aborted && settled.body)
          void settled.body.cancel().catch(() => undefined);
        return settled;
      }),
      controller.signal,
      timeoutError,
    );
    const isResume =
      options.allowResumeStatus === true && response.status === 308;
    if (
      response.redirected ||
      (response.status >= 300 &&
        response.status < 400 &&
        (!isResume || response.headers.has("Location")))
    )
      throw new DriveArchiveError("invalid_response");
    if (response.status === 401)
      throw new DriveArchiveError("reconnect_required");
    if (response.status === 429) throw new DriveArchiveError("rate_limited");
    return await handle(response, controller.signal, deadline);
  } catch (error) {
    if (
      error instanceof DriveArchiveError ||
      error instanceof ArchiveServiceError
    )
      throw error;
    throw new DriveArchiveError(
      controller.signal.aborted ? "timeout" : "unavailable",
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.abort();
    if (response?.body) void response.body.cancel().catch(() => undefined);
  }
}

/** Parse a resumable upload Range acknowledgement. */
export function acknowledgedBytes(response: Response, total: number): number {
  const range = response.headers.get("Range");
  if (range === null) return 0;
  const parsed = /^bytes=0-(0|[1-9][0-9]{0,15})$/.exec(range);
  const last = parsed?.[1] === undefined ? NaN : Number(parsed[1]);
  if (!Number.isSafeInteger(last) || last < 0 || last >= total)
    throw new DriveArchiveError("invalid_response");
  return last + 1;
}
