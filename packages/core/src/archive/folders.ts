import type { TenantContext } from "../tenant-context";

export interface ArchiveFolderAuthorization {
  connectionId: string;
  settingsVersion: number;
  generation: number;
}
export interface ArchiveFolderPlan {
  connectionId: string;
  storageSubject: string;
  fileId: string;
  workspaceMarker: string;
  name: string;
  state: "planned" | "ready";
}
export interface ArchiveFolderLease extends ArchiveFolderAuthorization {
  leaseId: string;
  fence: number;
  expiresAt: number;
  storageSubject: string;
}
export interface ArchiveFolderWork {
  plan: ArchiveFolderPlan;
  lease: ArchiveFolderLease;
}
export interface ArchiveFolderStore {
  getOrPlan(
    context: TenantContext,
    authorization: ArchiveFolderAuthorization,
    proposed: { fileId: string; workspaceMarker: string },
  ): Promise<ArchiveFolderPlan>;
  claim(
    context: TenantContext,
    authorization: ArchiveFolderAuthorization,
  ): Promise<ArchiveFolderWork | null>;
  authorized(
    context: TenantContext,
    lease: ArchiveFolderLease,
  ): Promise<boolean>;
  complete(context: TenantContext, lease: ArchiveFolderLease): Promise<boolean>;
}
