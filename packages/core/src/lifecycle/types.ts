import type {
  AccountDeleteRequest,
  DeleteDataRequest,
  DisconnectRequest,
} from "@invoxim/contracts";
import type { TenantContext } from "../tenant-context";
export interface LifecycleSession {
  tenant: TenantContext;
  sessionId: string;
  authenticatedAt: number;
}
export interface DeletionMarker {
  userId: string;
  deletedAt: number;
  requestId: string;
}
/** Must survive restoring application database backups independently. */
export interface DeletionJournal {
  append(marker: DeletionMarker): Promise<void>;
}
export interface DeleteDataPreview {
  connectionId: string;
  generation: number;
  sources: number;
  documents: number;
  observations: number;
  purchasesRemoved: number;
  purchasesRetained: number;
  eventsRemoved: number;
  eventsRetained: number;
  fingerprint: string;
  supported: boolean;
  driveFilesDeleted: false;
}
export interface LifecycleRepository {
  disconnect(
    session: LifecycleSession,
    id: string,
    request: DisconnectRequest,
    commandId: string,
  ): Promise<{
    generation: number;
    recordsRetained: true;
    localCredentialsRemoved: true;
    remoteRevocation: "not_attempted" | "accepted" | "failed";
  }>;
  preview(tenant: TenantContext, id: string): Promise<DeleteDataPreview>;
  deleteData(
    session: LifecycleSession,
    id: string,
    request: DeleteDataRequest,
    commandId: string,
  ): Promise<{ status: "cleanup_pending"; driveFilesDeleted: false }>;
  authorizeDeletion(
    session: LifecycleSession,
    request: AccountDeleteRequest,
  ): Promise<void>;
  beginDeletion(
    session: LifecycleSession,
    request: AccountDeleteRequest,
    marker: DeletionMarker,
  ): Promise<DeletionMarker>;
  acknowledgeJournal(marker: DeletionMarker): Promise<void>;
}

export interface CredentialRevoker {
  prepare(
    tenant: TenantContext,
    connectionId?: string,
  ): Promise<{ revoke(): Promise<"accepted" | "failed" | "not_attempted"> }>;
}
