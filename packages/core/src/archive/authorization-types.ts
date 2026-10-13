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
