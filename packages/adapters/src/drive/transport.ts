import { ArchiveServiceError } from "@invoxim/core";
import { z } from "zod";
import { MAX_ARCHIVE_ORIGINAL_BYTES } from "../../../core/src/archive/workflow-types";
import {
  DriveArchiveError,
  type DriveArchiveTransport,
  type DriveFolderPlan,
  type DriveHttpTransport,
  type DriveOriginalPlan,
} from "./types";

const api = "https://www.googleapis.com/drive/v3/files";
const upload = "https://www.googleapis.com/upload/drive/v3/files";
const folderMime = "application/vnd.google-apps.folder";
const maximumOriginalBytes = 5 * 1024 * 1024;
const maximumResponseBytes = 16384;
const fields =
  "id,mimeType,size,parents,appProperties,ownedByMe,trashed,sha256Checksum";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const folderSchema = z.strictObject({
  fileId: id,
  workspaceMarker: z.string().regex(/^[A-Za-z0-9_-]{16,96}$/),
  name: z
    .string()
    .min(1)
    .max(180)
    .refine(
      (value) =>
        new TextEncoder().encode(value).byteLength <= 180 &&
        [...value].every((character) => {
          const code = character.codePointAt(0) ?? 0;
          return (
            code >= 32 &&
            code !== 127 &&
            character !== "/" &&
            character !== "\\"
          );
        }) &&
        value.trim() === value &&
        value !== "." &&
        value !== "..",
    ),
});
const originalSchema = folderSchema.extend({
  parentId: id,
  mimeType: z.enum([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "message/rfc822",
  ]),
  size: z.number().int().min(1).max(MAX_ARCHIVE_ORIGINAL_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const metadataSchema = z.object({
  id,
  mimeType: z.string(),
  size: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .optional(),
  parents: z.array(id).max(1).optional(),
  ownedByMe: z.literal(true),
  trashed: z.literal(false),
  appProperties: z.object({
    workspace: z.string(),
    kind: z.enum(["folder", "original"]),
    sha256: z.string().optional(),
  }),
  sha256Checksum: z.string().optional(),
});

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new DriveArchiveError("timeout"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([promise, stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

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
      const next = await abortable(reader.read(), signal);
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

function verifyFolder(body: unknown, plan: DriveFolderPlan) {
  const parsed = metadataSchema.safeParse(body);
  if (
    !parsed.success ||
    parsed.data.id !== plan.fileId ||
    parsed.data.mimeType !== folderMime ||
    parsed.data.appProperties.workspace !== plan.workspaceMarker ||
    parsed.data.appProperties.kind !== "folder"
  )
    throw new DriveArchiveError("metadata_mismatch");
}
function verifyOriginal(body: unknown, plan: DriveOriginalPlan) {
  const parsed = metadataSchema.safeParse(body);
  if (
    !parsed.success ||
    parsed.data.id !== plan.fileId ||
    parsed.data.mimeType !== plan.mimeType ||
    parsed.data.size !== String(plan.size) ||
    parsed.data.parents?.[0] !== plan.parentId ||
    parsed.data.appProperties.workspace !== plan.workspaceMarker ||
    parsed.data.appProperties.kind !== "original" ||
    parsed.data.appProperties.sha256 !== plan.sha256 ||
    parsed.data.sha256Checksum !== plan.sha256
  )
    throw new DriveArchiveError("metadata_mismatch");
}

/** Stateless transport. Persist the plan and authorize its token/marker before calling. */
export function createDriveArchiveTransport(
  http: DriveHttpTransport = (request) => fetch(request),
  timeoutMs = 10000,
  options: { authorize?: () => Promise<void>; signal?: AbortSignal } = {},
): DriveArchiveTransport {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000)
    throw new DriveArchiveError("invalid_input");
  async function request(
    accessToken: string,
    url: string,
    init: RequestInit = {},
  ) {
    if (
      typeof accessToken !== "string" ||
      !/^[\x21-\x7e]{1,8192}$/.test(accessToken)
    )
      throw new DriveArchiveError("invalid_input");
    const controller = new AbortController();
    const deadline = Date.now() + timeoutMs;
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
          // Ignored cancellation can settle after the race has already timed out.
          if (controller.signal.aborted && settled.body)
            void settled.body.cancel().catch(() => undefined);
          return settled;
        }),
        controller.signal,
      );
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      )
        throw new DriveArchiveError("invalid_response");
      if (response.status === 401)
        throw new DriveArchiveError("reconnect_required");
      if (response.status === 404) return { status: 404, body: null };
      if (response.status === 409) return { status: 409, body: null };
      if (response.status === 429) throw new DriveArchiveError("rate_limited");
      const body = await readDriveJson(response, controller.signal, deadline);
      if (!response.ok) {
        const parsed = z
          .object({
            error: z.object({
              errors: z
                .array(z.object({ reason: z.string().max(128) }))
                .max(10),
            }),
          })
          .safeParse(body);
        const reasons = parsed.success
          ? parsed.data.error.errors.map((item) => item.reason)
          : [];
        if (reasons.includes("storageQuotaExceeded"))
          throw new DriveArchiveError("quota_exceeded");
        if (
          reasons.includes("rateLimitExceeded") ||
          reasons.includes("userRateLimitExceeded")
        )
          throw new DriveArchiveError("rate_limited");
        throw new DriveArchiveError(
          response.status === 403 ? "permission_denied" : "unavailable",
        );
      }
      return { status: response.status, body };
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
  async function inspect(accessToken: string, fileId: string) {
    const url = new URL(`${api}/${fileId}`);
    url.searchParams.set("fields", fields);
    const result = await request(accessToken, url.toString());
    if (result.status === 404) return null;
    if (result.status !== 200) throw new DriveArchiveError("invalid_response");
    return result.body;
  }
  async function create(
    accessToken: string,
    url: string,
    init: RequestInit,
    fileId: string,
  ): Promise<unknown> {
    try {
      const result = await request(accessToken, url, {
        ...init,
        method: "POST",
      });
      if (result.status === 404) throw new DriveArchiveError("missing_file");
      if (result.status !== 409) return result.body;
    } catch (error) {
      if (
        !(error instanceof DriveArchiveError) ||
        !["unavailable", "timeout"].includes(error.code)
      )
        throw error;
    }
    // A lost response or 409 is ambiguous until this exact, persisted ID is verified.
    const existing = await inspect(accessToken, fileId);
    if (existing === null) throw new DriveArchiveError("unavailable");
    return existing;
  }
  return {
    async generateFileId(accessToken) {
      const result = await request(
        accessToken,
        `${api}/generateIds?count=1&space=drive&type=files`,
      );
      const parsed = z
        .object({
          ids: z.array(id).length(1),
          space: z.literal("drive"),
          kind: z.literal("drive#generatedIds"),
        })
        .safeParse(result.body);
      if (result.status !== 200 || !parsed.success || !parsed.data.ids[0])
        throw new DriveArchiveError("invalid_response");
      return parsed.data.ids[0];
    },
    async inspectFolder(accessToken, input) {
      const parsed = folderSchema.safeParse(input);
      if (!parsed.success) throw new DriveArchiveError("invalid_input");
      const metadata = await inspect(accessToken, parsed.data.fileId);
      if (metadata === null) throw new DriveArchiveError("folder_missing");
      verifyFolder(metadata, parsed.data);
    },
    async ensureFolder(accessToken, input) {
      const parsed = folderSchema.safeParse(input);
      if (!parsed.success) throw new DriveArchiveError("invalid_input");
      const plan = parsed.data;
      let metadata = await inspect(accessToken, plan.fileId);
      if (metadata === null) {
        metadata = await create(
          accessToken,
          `${api}?fields=${encodeURIComponent(fields)}`,
          {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: plan.fileId,
              name: plan.name,
              mimeType: folderMime,
              appProperties: {
                workspace: plan.workspaceMarker,
                kind: "folder",
              },
            }),
          },
          plan.fileId,
        );
      }
      verifyFolder(metadata, plan);
    },
    async inspectOriginal(accessToken, input) {
      const parsed = originalSchema.safeParse(input);
      if (!parsed.success) throw new DriveArchiveError("invalid_input");
      const metadata = await inspect(accessToken, parsed.data.fileId);
      if (metadata === null) return false;
      verifyOriginal(metadata, parsed.data);
      return true;
    },
    async uploadOriginal(accessToken, input, originalBytes) {
      const parsed = originalSchema.safeParse(input);
      if (
        !parsed.success ||
        !(originalBytes instanceof Uint8Array) ||
        parsed.data.size > maximumOriginalBytes ||
        originalBytes.byteLength !== parsed.data.size
      )
        throw new DriveArchiveError("invalid_input");
      const plan = parsed.data;
      // Copy once before awaits so caller mutation cannot change already-hashed upload bytes.
      const bytes = new Uint8Array(originalBytes);
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", bytes),
      );
      const hash = [...digest]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (hash !== plan.sha256) throw new DriveArchiveError("invalid_input");
      const folder = await inspect(accessToken, plan.parentId);
      if (folder === null) throw new DriveArchiveError("folder_missing");
      verifyFolder(folder, {
        fileId: plan.parentId,
        workspaceMarker: plan.workspaceMarker,
        name: "unused",
      });
      const boundary = `invoxim_${crypto.randomUUID().replaceAll("-", "")}`;
      const metadata = JSON.stringify({
        id: plan.fileId,
        name: plan.name,
        mimeType: plan.mimeType,
        parents: [plan.parentId],
        appProperties: {
          workspace: plan.workspaceMarker,
          kind: "original",
          sha256: plan.sha256,
        },
      });
      const prefix = new TextEncoder().encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${plan.mimeType}\r\n\r\n`,
      );
      const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
      const body = new Uint8Array(prefix.length + bytes.length + suffix.length);
      body.set(prefix);
      body.set(bytes, prefix.length);
      body.set(suffix, prefix.length + bytes.length);
      const result = await create(
        accessToken,
        `${upload}?uploadType=multipart&fields=${encodeURIComponent(fields)}`,
        {
          headers: {
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body,
        },
        plan.fileId,
      );
      verifyOriginal(result, plan);
    },
  };
}
