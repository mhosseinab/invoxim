import { sha256Hex } from "../security/helpers";
import { driveOriginalPlanSchema } from "./plans";
import {
  acknowledgedBytes,
  type DriveRequestContext,
  driveRequest,
  mapDriveFailure,
  readDriveJson,
} from "./request";
import { createDriveArchiveTransport } from "./transport";
import {
  DriveArchiveError,
  type DriveHttpTransport,
  type DriveOriginalPlan,
} from "./types";

export const DRIVE_RESUMABLE_CHUNK_BYTES = 4 * 1024 * 1024;
const uploadEndpoint = "https://www.googleapis.com/upload/drive/v3/files";
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
  const context: DriveRequestContext = { http, timeoutMs, ...options };
  const metadata = createDriveArchiveTransport(http, timeoutMs, options);
  async function request(
    accessToken: string,
    url: string,
    init: RequestInit,
    total?: number,
  ) {
    return driveRequest(
      context,
      accessToken,
      url,
      init,
      async (response, signal, deadline) => {
        if (response.status >= 500) throw new DriveArchiveError("unavailable");
        if ([200, 201, 308, 404, 409].includes(response.status)) {
          return {
            status: response.status,
            location: response.headers.get("Location"),
            uploadedBytes:
              response.status === 308
                ? acknowledgedBytes(response, total ?? 0)
                : 0,
          };
        }
        const body = await readDriveJson(response, signal, deadline);
        throw mapDriveFailure(response.status, body);
      },
      { allowResumeStatus: total !== undefined },
    );
  }
  function validate(plan: DriveOriginalPlan) {
    if (!driveOriginalPlanSchema.safeParse(plan).success)
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
      const end = Math.min(offset + DRIVE_RESUMABLE_CHUNK_BYTES, plan.size);
      // Snapshot the slice first so the bytes sent are exactly what was hashed.
      const chunk = originalBytes.slice(offset, end);
      // D15: full-buffer digest runs once at upload start; later chunks skip the
      // rehash. Completion still checks the remote sha256Checksum before success.
      if (offset === 0) {
        const hash = await sha256Hex(originalBytes);
        if (hash !== plan.sha256) throw new DriveArchiveError("invalid_input");
      }
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
            body: chunk,
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
