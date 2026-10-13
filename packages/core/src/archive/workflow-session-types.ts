import type { TenantContext } from "../tenant-context";
import type {
  ArchiveCredentialFences,
  ArchiveObjectLease,
  ArchiveUploadPlan,
} from "./objects";

/** Only authenticated ciphertext and progress metadata cross the persistence port. */
export interface ArchiveUploadSessionSnapshot {
  ciphertext: string;
  keyVersion: number;
  version: number;
  expiresAt: number;
  uploadedBytes: number;
}
export interface ArchiveUploadSessionStore {
  read(
    context: TenantContext,
    lease: ArchiveObjectLease,
    plan: ArchiveUploadPlan,
    credentials: Required<ArchiveCredentialFences>,
  ): Promise<ArchiveUploadSessionSnapshot | null>;
  save(
    context: TenantContext,
    lease: ArchiveObjectLease,
    plan: ArchiveUploadPlan,
    expectedVersion: number,
    reference: { ciphertext: string; keyVersion: number; expiresAt: number },
    credentials: Required<ArchiveCredentialFences>,
  ): Promise<ArchiveUploadSessionSnapshot | null>;
  checkpoint(
    context: TenantContext,
    lease: ArchiveObjectLease,
    plan: ArchiveUploadPlan,
    version: number,
    uploadedBytes: number,
    credentials: Required<ArchiveCredentialFences>,
  ): Promise<boolean>;
}
