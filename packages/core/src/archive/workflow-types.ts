import type { TenantContext } from "../tenant-context";
import type { ArchiveFolderPlan, ArchiveFolderStore } from "./folders";
import type {
  ArchiveObjectStore,
  ArchiveObjectWork,
  ArchiveUploadPlan,
} from "./objects";

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
  uploadOriginal(plan: ArchiveUploadPlan, bytes: Uint8Array): Promise<void>;
}
export interface ArchiveWorkflowPorts {
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
