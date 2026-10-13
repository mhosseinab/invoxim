import { hasControlCharacters } from "@invoxim/contracts";
import { ArchiveServiceError } from "@invoxim/core";
import { z } from "zod";
import { MAX_ARCHIVE_ORIGINAL_BYTES } from "../../../core/src/archive/workflow-types";
import { createDriveArchiveTransport, readDriveJson } from "./transport";
import {
  DriveArchiveError,
  type DriveHttpTransport,
  type DriveOriginalPlan,
} from "./types";

export const DRIVE_RESUMABLE_CHUNK_BYTES = 4 * 1024 * 1024;
const uploadEndpoint = "https://www.googleapis.com/upload/drive/v3/files";
const planSchema = z.object({
  fileId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  parentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  workspaceMarker: z.string().regex(/^[A-Za-z0-9_-]{16,96}$/),
  name: z
    .string()
    .min(1)
    .max(180)
    .refine(
      (value) =>
        new TextEncoder().encode(value).length <= 180 &&
        !hasControlCharacters(value) &&
        !value.includes("/") &&
        !value.includes("\\") &&
        value.trim() === value &&
        value !== "." &&
        value !== "..",
    ),
  mimeType: z.enum([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "message/rfc822",
  ]),
  size: z.number().int().min(1).max(MAX_ARCHIVE_ORIGINAL_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DriveResumableStatus =
  | { status: "complete" }
  | { status: "incomplete"; uploadedBytes: number }
  | { status: "expired" };
export interface DriveResumableTransport {
  initiate(accessToken: string, plan: DriveOriginalPlan): Promise<string>;
  probe(
    accessToken: string,
    plan: DriveOriginalPlan,
    sessionUrl: string,
  ): Promise<DriveResumableStatus>;
  uploadChunk(
    accessToken: string,
    plan: DriveOriginalPlan,
    sessionUrl: string,
    bytes: Uint8Array,
    offset: number,
  ): Promise<DriveResumableStatus>;
}
export function validatedDriveSessionUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096)
    throw new DriveArchiveError("invalid_response");
  try {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    const uploadId = url.searchParams.get("upload_id") ?? "";
    if (
      url.origin !== "https://www.googleapis.com" ||
      url.pathname !== "/upload/drive/v3/files" ||
      url.username ||
      url.password ||
      url.hash ||
      url.href !== value ||
      keys.length !== 2 ||
      new Set(keys).size !== 2 ||
      !keys.includes("uploadType") ||
      !keys.includes("upload_id") ||
      url.searchParams.get("uploadType") !== "resumable" ||
      !/^[A-Za-z0-9._~-]{1,3072}$/.test(uploadId)
    )
      throw new DriveArchiveError("invalid_response");
    return url.href;
  } catch {
    throw new DriveArchiveError("invalid_response");
  }
}
async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let stop = () => {};
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(new DriveArchiveError("timeout"));
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
function acknowledged(response: Response, total: number): number {
  const range = response.headers.get("Range");
  if (range === null) return 0;
  const parsed = /^bytes=0-(0|[1-9][0-9]{0,15})$/.exec(range);
  const last = parsed?.[1] === undefined ? NaN : Number(parsed[1]);
  if (!Number.isSafeInteger(last) || last < 0 || last >= total)
    throw new DriveArchiveError("invalid_response");
  return last + 1;
}
/** Fixed Drive protocol; caller persists the preallocated ID and encrypted session before bytes. */
export function createDriveResumableTransport(
  http: DriveHttpTransport = (request) => fetch(request),
  options: {
    authorize?: () => Promise<void>;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): DriveResumableTransport {
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000)
    throw new DriveArchiveError("invalid_input");
  const metadata = createDriveArchiveTransport(http, timeoutMs, options);
  async function request(
    accessToken: string,
    url: string,
    init: RequestInit,
    total?: number,
  ) {
    if (!/^[\x21-\x7e]{1,8192}$/.test(accessToken))
      throw new DriveArchiveError("invalid_input");
    const controller = new AbortController();
    const deadline = Date.now() + timeoutMs;
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(cancel, timeoutMs);
    let response: Response | undefined;
    try {
      if (controller.signal.aborted) throw new DriveArchiveError("timeout");
      if (options.authorize)
        await abortable(options.authorize(), controller.signal);
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
          if (controller.signal.aborted && settled.body)
            void settled.body.cancel().catch(() => undefined);
          return settled;
        }),
        controller.signal,
      );
      if (
        response.redirected ||
        (response.status >= 300 &&
          response.status < 400 &&
          (total === undefined || response.status !== 308)) ||
        (response.status === 308 && response.headers.has("Location"))
      )
        throw new DriveArchiveError("invalid_response");
      if (response.status === 401)
        throw new DriveArchiveError("reconnect_required");
      if (response.status === 429) throw new DriveArchiveError("rate_limited");
      if (response.status >= 500) throw new DriveArchiveError("unavailable");
      if ([200, 201, 308, 404, 409].includes(response.status))
        return {
          status: response.status,
          location: response.headers.get("Location"),
          uploadedBytes:
            response.status === 308 ? acknowledged(response, total ?? 0) : 0,
        };
      const body = await readDriveJson(response, controller.signal, deadline);
      const reasons = z
        .object({
          error: z.object({
            errors: z.array(z.object({ reason: z.string().max(128) })).max(10),
          }),
        })
        .safeParse(body);
      const values = reasons.success
        ? reasons.data.error.errors.map((entry) => entry.reason)
        : [];
      if (values.includes("storageQuotaExceeded"))
        throw new DriveArchiveError("quota_exceeded");
      if (
        values.includes("rateLimitExceeded") ||
        values.includes("userRateLimitExceeded")
      )
        throw new DriveArchiveError("rate_limited");
      throw new DriveArchiveError(
        response.status === 403 ? "permission_denied" : "unavailable",
      );
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
      options.signal?.removeEventListener("abort", cancel);
      controller.abort();
      if (response?.body) void response.body.cancel().catch(() => undefined);
    }
  }
  function validate(plan: DriveOriginalPlan) {
    if (!planSchema.safeParse(plan).success)
      throw new DriveArchiveError("invalid_input");
  }
  async function complete(
    accessToken: string,
    plan: DriveOriginalPlan,
  ): Promise<DriveResumableStatus> {
    if (!(await metadata.inspectOriginal(accessToken, plan)))
      throw new DriveArchiveError("unavailable");
    return { status: "complete" };
  }
  async function probe(
    accessToken: string,
    plan: DriveOriginalPlan,
    sessionUrl: string,
  ): Promise<DriveResumableStatus> {
    validate(plan);
    const url = validatedDriveSessionUrl(sessionUrl);
    const result = await request(
      accessToken,
      url,
      {
        method: "PUT",
        headers: {
          "Content-Length": "0",
          "Content-Range": `bytes */${plan.size}`,
        },
      },
      plan.size,
    );
    if (result.status === 404)
      return (await metadata.inspectOriginal(accessToken, plan))
        ? { status: "complete" }
        : { status: "expired" };
    if (result.status === 200 || result.status === 201)
      return complete(accessToken, plan);
    if (result.status !== 308) throw new DriveArchiveError("invalid_response");
    if (result.uploadedBytes === plan.size) return complete(accessToken, plan);
    return { status: "incomplete", uploadedBytes: result.uploadedBytes };
  }
  return {
    async initiate(accessToken, plan) {
      validate(plan);
      const result = await request(
        accessToken,
        `${uploadEndpoint}?uploadType=resumable`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": plan.mimeType,
            "X-Upload-Content-Length": String(plan.size),
          },
          body: JSON.stringify({
            id: plan.fileId,
            name: plan.name,
            mimeType: plan.mimeType,
            parents: [plan.parentId],
            appProperties: {
              workspace: plan.workspaceMarker,
              kind: "original",
              sha256: plan.sha256,
            },
          }),
        },
      );
      if (result.status !== 200)
        throw new DriveArchiveError(
          result.status === 409 ? "unavailable" : "invalid_response",
        );
      return validatedDriveSessionUrl(result.location);
    },
    probe,
    async uploadChunk(accessToken, plan, sessionUrl, originalBytes, offset) {
      validate(plan);
      const url = validatedDriveSessionUrl(sessionUrl);
      if (
        !(originalBytes instanceof Uint8Array) ||
        originalBytes.length !== plan.size ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset >= plan.size
      )
        throw new DriveArchiveError("invalid_input");
      const bytes = new Uint8Array(originalBytes);
      const hash = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (hash !== plan.sha256) throw new DriveArchiveError("invalid_input");
      const end = Math.min(offset + DRIVE_RESUMABLE_CHUNK_BYTES, plan.size);
      try {
        const result = await request(
          accessToken,
          url,
          {
            method: "PUT",
            headers: {
              "Content-Type": plan.mimeType,
              "Content-Length": String(end - offset),
              "Content-Range": `bytes ${offset}-${end - 1}/${plan.size}`,
            },
            body: bytes.subarray(offset, end),
          },
          plan.size,
        );
        if (result.status === 404)
          return (await metadata.inspectOriginal(accessToken, plan))
            ? { status: "complete" }
            : { status: "expired" };
        if (result.status === 200 || result.status === 201)
          return complete(accessToken, plan);
        if (
          result.status !== 308 ||
          result.uploadedBytes < offset ||
          result.uploadedBytes > end
        )
          throw new DriveArchiveError("invalid_response");
        if (result.uploadedBytes === plan.size)
          return complete(accessToken, plan);
        return { status: "incomplete", uploadedBytes: result.uploadedBytes };
      } catch (error) {
        if (
          error instanceof DriveArchiveError &&
          ["timeout", "unavailable"].includes(error.code)
        )
          return probe(accessToken, plan, url);
        throw error;
      }
    },
  };
}
