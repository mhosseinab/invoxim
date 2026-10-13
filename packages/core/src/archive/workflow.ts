import type { TenantContext } from "../tenant-context";
import type { ArchiveFolderLease } from "./folders";
import type { ArchiveUploadPlan } from "./objects";
import { ArchiveServiceError } from "./service-types";
import type {
  ArchiveWorkflowPorts,
  ArchiveWorkflowResult,
} from "./workflow-types";

const multipartMaximumBytes = 5 * 1024 * 1024;
async function digest(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
/** Executes one explicitly authorized multipart archive object; queue dispatch is separate. */
export function createArchiveWorkflow(ports: ArchiveWorkflowPorts) {
  async function run(
    context: TenantContext,
    objectId: string,
    signal: AbortSignal,
  ): Promise<ArchiveWorkflowResult> {
    if (signal.aborted) throw new ArchiveServiceError("CONFLICT");
    const claimed = await ports.objects.claim(context, objectId);
    if (!claimed) return { status: "not_claimed" };
    const work = claimed;
    let folderLease: ArchiveFolderLease | undefined;
    async function authorize() {
      if (
        signal.aborted ||
        !(await ports.objects.authorized(context, work.lease))
      )
        throw new ArchiveServiceError("CONFLICT");
      if (
        folderLease &&
        !(await ports.folders.authorized(context, folderLease))
      )
        throw new ArchiveServiceError("CONFLICT");
      if (signal.aborted) throw new ArchiveServiceError("CONFLICT");
    }
    const control = { signal, authorize };
    await authorize();
    const remote = await ports.openRemote(context, work, control);
    if ("status" in remote) {
      if (!(await ports.objects.release(context, work.lease)))
        throw new ArchiveServiceError("CONFLICT");
      return { status: "deferred" };
    }
    const original = await ports.originals.read(context, work, control);
    if (original.status !== "ready") return { status: original.status };
    const identity = original.sourceIdentity;
    if (
      identity.providerMessageId !== work.providerMessageId ||
      identity.partKey !== work.partKey ||
      identity.sha256 !== work.documentHash ||
      identity.mimeType !== work.documentMime ||
      identity.size !== work.documentSize
    )
      throw new ArchiveServiceError("CONFLICT");
    if (
      !(original.bytes instanceof Uint8Array) ||
      original.bytes.length < 1 ||
      original.bytes.length > multipartMaximumBytes
    )
      return { status: "unsupported" };
    const bytes = new Uint8Array(original.bytes);
    const sha256 = await digest(bytes);
    const isBody = ["text/plain", "text/html"].includes(work.documentMime);
    if (
      isBody
        ? original.mimeType !== "message/rfc822"
        : original.mimeType !== work.documentMime ||
          bytes.length !== work.documentSize ||
          sha256 !== work.documentHash
    )
      throw new ArchiveServiceError("CONFLICT");
    if (
      work.plan &&
      (work.plan.mimeType !== original.mimeType ||
        work.plan.size !== bytes.length ||
        work.plan.sha256 !== sha256)
    )
      throw new ArchiveServiceError("CONFLICT");
    await authorize();
    const folderAuthorization = {
      connectionId: work.storageConnectionId,
      settingsVersion: work.settingsVersion,
      generation: work.storageGeneration,
    };
    let folder = await ports.folders.readCurrent(context, folderAuthorization);
    if (!folder) {
      await authorize();
      const fileId = await remote.generateFileId();
      folder = await ports.folders.getOrPlan(context, folderAuthorization, {
        fileId,
        workspaceMarker: await ports.workspaceMarker(context),
      });
    }
    if (folder.storageSubject !== work.storageSubject)
      throw new ArchiveServiceError("CONFLICT");
    if (folder.state === "planned") {
      const claimed = await ports.folders.claim(context, folderAuthorization);
      if (!claimed) return { status: "not_claimed" };
      folderLease = claimed.lease;
      folder = claimed.plan;
      await authorize();
      await remote.ensureFolder(folder);
      if (!(await ports.folders.complete(context, folderLease)))
        throw new ArchiveServiceError("CONFLICT");
      folderLease = undefined;
    }
    let plan: ArchiveUploadPlan;
    if (work.plan) {
      plan = work.plan;
      if (
        plan.parentId !== folder.fileId ||
        plan.workspaceMarker !== folder.workspaceMarker
      )
        throw new ArchiveServiceError("CONFLICT");
    } else {
      await authorize();
      plan = {
        fileId: await remote.generateFileId(),
        parentId: folder.fileId,
        workspaceMarker: folder.workspaceMarker,
        mimeType: original.mimeType,
        size: bytes.length,
        sha256,
      };
      if (!(await ports.objects.savePlan(context, work.lease, plan)))
        throw new ArchiveServiceError("CONFLICT");
    }
    await authorize();
    if (!(await remote.inspectOriginal(plan))) {
      await authorize();
      await remote.uploadOriginal(plan, bytes);
    }
    if (!(await ports.objects.complete(context, work.lease)))
      throw new ArchiveServiceError("CONFLICT");
    return { status: "archived" };
  }
  return { run };
}
