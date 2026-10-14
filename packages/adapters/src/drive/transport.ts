import { z } from "zod";
import {
  MAX_MULTIPART_ORIGINAL_BYTES,
} from "../../../core/src/archive/workflow-types";
import { sha256Hex } from "../security/helpers";
import {
  driveFolderPlanSchema,
  driveOriginalPlanSchema,
} from "./plans";
import {
  type DriveRequestContext,
  driveRequest,
  mapDriveFailure,
  readDriveJson,
} from "./request";
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
const fields =
  "id,mimeType,size,parents,appProperties,ownedByMe,trashed,sha256Checksum";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
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
  const context: DriveRequestContext = { http, timeoutMs, ...options };
  async function request(
    accessToken: string,
    url: string,
    init: RequestInit = {},
  ) {
    return driveRequest(
      context,
      accessToken,
      url,
      init,
      async (response, signal, deadline) => {
        if (response.status === 404 || response.status === 409)
          return { status: response.status, body: null };
        const body = await readDriveJson(response, signal, deadline);
        if (!response.ok) throw mapDriveFailure(response.status, body);
        return { status: response.status, body };
      },
    );
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
      const parsed = driveFolderPlanSchema.safeParse(input);
      if (!parsed.success) throw new DriveArchiveError("invalid_input");
      const metadata = await inspect(accessToken, parsed.data.fileId);
      if (metadata === null) throw new DriveArchiveError("folder_missing");
      verifyFolder(metadata, parsed.data);
    },
    async ensureFolder(accessToken, input) {
      const parsed = driveFolderPlanSchema.safeParse(input);
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
      const parsed = driveOriginalPlanSchema.safeParse(input);
      if (!parsed.success) throw new DriveArchiveError("invalid_input");
      const metadata = await inspect(accessToken, parsed.data.fileId);
      if (metadata === null) return false;
      verifyOriginal(metadata, parsed.data);
      return true;
    },
    async uploadOriginal(accessToken, input, originalBytes) {
      const parsed = driveOriginalPlanSchema.safeParse(input);
      if (
        !parsed.success ||
        !(originalBytes instanceof Uint8Array) ||
        parsed.data.size > MAX_MULTIPART_ORIGINAL_BYTES ||
        originalBytes.byteLength !== parsed.data.size
      )
        throw new DriveArchiveError("invalid_input");
      const plan = parsed.data;
      // Copy once before awaits so caller mutation cannot change already-hashed upload bytes.
      const bytes = new Uint8Array(originalBytes);
      const hash = await sha256Hex(bytes);
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
