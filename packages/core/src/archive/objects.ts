import type { TenantContext } from "../tenant-context";

export interface ArchiveObjectRequest {
  documentId: string;
  storageConnectionId: string;
  settingsVersion: number;
}
export interface ArchiveObjectLease {
  id: string;
  leaseId: string;
  fence: number;
  expiresAt: number;
}
/** Only metadata is durable. Original bytes remain transient. */
export interface ArchiveUploadPlan {
  fileId: string;
  parentId: string;
  workspaceMarker: string;
  mimeType: "application/pdf" | "image/jpeg" | "image/png" | "message/rfc822";
  size: number;
  sha256: string;
}
export interface ArchiveObjectWork {
  lease: ArchiveObjectLease;
  documentId: string;
  sourceMessageId: string;
  providerMessageId: string;
  partKey: string;
  mailboxConnectionId: string;
  mailboxGeneration: number;
  storageConnectionId: string;
  storageGeneration: number;
  storageSubject: string;
  settingsVersion: number;
  plan: ArchiveUploadPlan | null;
}
export interface ArchiveObjectStore {
  request(context: TenantContext, input: ArchiveObjectRequest): Promise<string>;
  claim(context: TenantContext, id: string): Promise<ArchiveObjectWork | null>;
  savePlan(
    context: TenantContext,
    lease: ArchiveObjectLease,
    plan: ArchiveUploadPlan,
  ): Promise<boolean>;
  authorized(
    context: TenantContext,
    lease: ArchiveObjectLease,
  ): Promise<boolean>;
  complete(context: TenantContext, lease: ArchiveObjectLease): Promise<boolean>;
}
