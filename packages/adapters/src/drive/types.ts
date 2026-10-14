import type { CredentialCipher } from "../security/types";

/** Trusted caller persists these IDs and binds token/marker to authorized Drive consent. */
export interface DriveFolderPlan {
  fileId: string;
  workspaceMarker: string;
  name: string;
}
export interface DriveOriginalPlan extends DriveFolderPlan {
  parentId: string;
  mimeType: "application/pdf" | "image/jpeg" | "image/png" | "message/rfc822";
  size: number;
  sha256: string;
}
export type DriveFailureCode =
  | "invalid_input"
  | "unavailable"
  | "timeout"
  | "invalid_response"
  | "reconnect_required"
  | "permission_denied"
  | "quota_exceeded"
  | "rate_limited"
  | "folder_missing"
  | "missing_file"
  | "metadata_mismatch";
export class DriveArchiveError extends Error {
  constructor(readonly code: DriveFailureCode) {
    super(code);
  }
}
export interface DriveArchiveTransport {
  generateFileId(accessToken: string): Promise<string>;
  ensureFolder(accessToken: string, plan: DriveFolderPlan): Promise<void>;
  inspectFolder(accessToken: string, plan: DriveFolderPlan): Promise<void>;
  inspectOriginal(
    accessToken: string,
    plan: DriveOriginalPlan,
  ): Promise<boolean>;
  uploadOriginal(
    accessToken: string,
    plan: DriveOriginalPlan,
    bytes: Uint8Array,
  ): Promise<void>;
}
export type DriveHttpTransport = (request: Request) => Promise<Response>;
/** Server-composed configuration; account and storage consent remain separate from login/mail. */
export interface DriveServiceConfiguration {
  provider: "google-drive";
  oauthProvider: "google";
  callback: string;
  cipher: CredentialCipher;
  scopes: readonly string[];
}
