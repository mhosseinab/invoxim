import { ArchiveServiceError, type TenantContext } from "@invoxim/core";
import type {
  ArchiveCredentialFences,
  ArchiveObjectLease,
} from "../../../core/src/archive/objects";
import type { ArchiveUploadSessionStore } from "../../../core/src/archive/workflow-session-types";
import type { CredentialCipher } from "../security/types";
import {
  type DriveResumableTransport,
  validatedDriveSessionUrl,
} from "./resumable";
import type { DriveArchiveTransport, DriveOriginalPlan } from "./types";

const localSessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
/** One durable session stage. The guarded transports authorize every actual HTTP dispatch. */
export function createDriveResumableWorkflow(options: {
  context: TenantContext;
  lease: ArchiveObjectLease;
  credentials: Required<ArchiveCredentialFences>;
  cipher: CredentialCipher;
  sessions: ArchiveUploadSessionStore;
  transport: DriveResumableTransport;
  metadata: DriveArchiveTransport;
  accessToken: string;
}) {
  const {
    context,
    lease,
    credentials,
    sessions,
    cipher,
    transport,
    metadata,
    accessToken,
  } = options;
  async function uploadOriginal(
    plan: DriveOriginalPlan,
    bytes: Uint8Array,
  ): Promise<undefined | { status: "deferred" }> {
    const persistedPlan = {
      fileId: plan.fileId,
      parentId: plan.parentId,
      workspaceMarker: plan.workspaceMarker,
      mimeType: plan.mimeType,
      size: plan.size,
      sha256: plan.sha256,
    };
    const saved = await sessions.read(
      context,
      lease,
      persistedPlan,
      credentials,
    );
    const binding = {
      entityId: lease.id,
      purpose: "archive-upload-session" as const,
    };
    let sessionUrl: string | undefined;
    if (saved) {
      if (saved.keyVersion > cipher.activeVersion)
        throw new ArchiveServiceError("CONFLICT");
      const payload = await cipher.open(context, binding, saved.ciphertext);
      if (payload.fileId !== plan.fileId || payload.sha256 !== plan.sha256)
        throw new ArchiveServiceError("CONFLICT");
      sessionUrl = validatedDriveSessionUrl(payload.url);
    }
    if (saved && sessionUrl && saved.expiresAt > Date.now()) {
      await metadata.inspectFolder(accessToken, {
        fileId: plan.parentId,
        workspaceMarker: plan.workspaceMarker,
        name: "unused",
      });
      const progress = await transport.probe(accessToken, plan, sessionUrl);
      if (progress.status === "complete") return;
      if (progress.status === "incomplete") {
        if (progress.uploadedBytes < saved.uploadedBytes)
          throw new ArchiveServiceError("CONFLICT");
        if (
          progress.uploadedBytes > saved.uploadedBytes &&
          !(await sessions.checkpoint(
            context,
            lease,
            persistedPlan,
            saved.version,
            progress.uploadedBytes,
            credentials,
          ))
        )
          throw new ArchiveServiceError("CONFLICT");
        const uploaded = await transport.uploadChunk(
          accessToken,
          plan,
          sessionUrl,
          bytes,
          progress.uploadedBytes,
        );
        if (uploaded.status === "complete") return;
        if (uploaded.status === "incomplete") {
          if (
            !(await sessions.checkpoint(
              context,
              lease,
              persistedPlan,
              saved.version,
              uploaded.uploadedBytes,
              credentials,
            ))
          )
            throw new ArchiveServiceError("CONFLICT");
          return { status: "deferred" };
        }
        // A vanished session gets a fresh reference on a later invocation, preserving this ID.
        return { status: "deferred" };
      }
    }
    if (saved && saved.version >= 2147483646)
      throw new ArchiveServiceError("CONFLICT");
    await metadata.inspectFolder(accessToken, {
      fileId: plan.parentId,
      workspaceMarker: plan.workspaceMarker,
      name: "unused",
    });
    const url = await transport.initiate(accessToken, plan);
    const ciphertext = await cipher.seal(context, binding, {
      url,
      fileId: plan.fileId,
      sha256: plan.sha256,
    });
    const stored = await sessions.save(
      context,
      lease,
      persistedPlan,
      saved?.version ?? 0,
      {
        ciphertext,
        keyVersion: cipher.activeVersion,
        expiresAt: Date.now() + localSessionLifetimeMs - 1000,
      },
      credentials,
    );
    if (!stored) throw new ArchiveServiceError("CONFLICT");
    // No bytes are dispatched until a subsequent invocation can read the durable encrypted reference.
    return { status: "deferred" };
  }
  return { uploadOriginal };
}
