import type { MailboxSession } from "../mailbox/types";

/** Shared trusted application session; storage identity remains independent. */
export type ArchiveSession = MailboxSession;
export class ArchiveServiceError extends Error {
  constructor(
    readonly code:
      | "UNAUTHENTICATED"
      | "RECENT_AUTH_REQUIRED"
      | "INVALID_INPUT"
      | "INVALID_STATE"
      | "DENIED"
      | "MISSING_PERMISSION"
      | "ACCOUNT_MISMATCH"
      | "MISSING_REFRESH_TOKEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "RECONNECT_REQUIRED"
      | "UNAVAILABLE",
  ) {
    super(code);
  }
}
/** Storage identity is independent of application login and mailbox identities. */
export interface ArchiveIdentity {
  subject: string;
  address: string;
}
export interface ArchiveCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}
export interface ArchiveAuthorization {
  identity: ArchiveIdentity;
  credentials: ArchiveCredentials;
  canArchiveFiles: true;
}
export interface ArchiveAuthorizationPort {
  authorize(input: {
    state: string;
    nonce: string;
    verifier: string;
    callback: string;
  }): Promise<string>;
  exchange(input: {
    code: string;
    verifier: string;
    nonce: string;
    callback: string;
  }): Promise<ArchiveAuthorization>;
  refresh(
    credentials: ArchiveCredentials,
    expectedIdentity: ArchiveIdentity,
  ): Promise<ArchiveCredentials>;
}
export class ArchiveAuthorizationError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "ACCOUNT_MISMATCH"
      | "MISSING_PERMISSION"
      | "MISSING_REFRESH_TOKEN"
      | "RECONNECT_REQUIRED"
      | "UNAVAILABLE",
  ) {
    super(code);
  }
}
