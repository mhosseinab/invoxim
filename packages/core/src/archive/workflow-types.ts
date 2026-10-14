import type { TenantContext } from "../tenant-context";
import type { ArchiveFolderPlan, ArchiveFolderStore } from "./folders";
import type {
  ArchiveObjectStore,
  ArchiveObjectWork,
  ArchiveUploadPlan,
} from "./objects";

export const MAX_ARCHIVE_ORIGINAL_BYTES = 16 * 1024 * 1024;
/** Above this size Drive uploads use the resumable protocol instead of multipart (D7). */
export const MAX_MULTIPART_ORIGINAL_BYTES = 5 * 1024 * 1024;

/** Every external request must invoke authorize immediately before dispatch. */
export interface ArchiveWorkflowControl {
  signal: AbortSignal;
  authorize(): Promise<void>;
}
export type ArchiveOriginalResult =
  | { status: "source_unavailable" }
  | { status: "unsupported" }
  | {
      status: "ready";
      bytes: Uint8Array;
      mimeType: ArchiveUploadPlan["mimeType"];
      sourceIdentity: {
        providerMessageId: string;
        partKey: string;
        sha256: string;
        mimeType: string;
        size: number;
      };
    };
export interface ArchiveWorkflowOriginalSource {
  read(
    context: TenantContext,
    work: ArchiveObjectWork,
    control: ArchiveWorkflowControl,
  ): Promise<ArchiveOriginalResult>;
}
/** Credentials and provider SDK details stay inside the concrete remote adapter. */
export interface ArchiveWorkflowRemote {
  generateFileId(): Promise<string>;
  ensureFolder(plan: ArchiveFolderPlan): Promise<void>;
  inspectOriginal(plan: ArchiveUploadPlan): Promise<boolean>;
  uploadOriginal(
    plan: ArchiveUploadPlan,
    bytes: Uint8Array,
  ): Promise<void> | Promise<undefined | { status: "deferred" }>;
}
export interface ArchiveWorkflowPorts {
  /** Adapter reserves its shared invocation's lease-release and queue-settlement headroom. */
  reserve?(requiredStatements: number): boolean;
  objects: ArchiveObjectStore;
  folders: ArchiveFolderStore;
  originals: ArchiveWorkflowOriginalSource;
  openRemote(
    context: TenantContext,
    work: ArchiveObjectWork,
    control: ArchiveWorkflowControl,
  ): Promise<ArchiveWorkflowRemote | { status: "deferred" }>;
  workspaceMarker(context: TenantContext): Promise<string>;
}
export type ArchiveWorkflowResult =
  | { status: "archived" }
  | { status: "not_claimed" }
  | { status: "deferred" }
  | { status: "source_unavailable" }
  | { status: "unsupported" };
