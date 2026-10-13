import type { TenantContext } from "../tenant-context";
export interface MailboxSession {
  tenant: TenantContext;
  sessionId: string;
  createdAtMs: number;
}
export interface MailboxIdentity {
  subject: string;
  address: string;
}
export interface MailboxCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}
export interface MailboxAuthorization {
  identity: MailboxIdentity;
  credentials: MailboxCredentials;
  canReadMessages: true;
}
export interface MailboxAuthorizationPort {
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
  }): Promise<MailboxAuthorization>;
  refresh(
    credentials: MailboxCredentials,
    expectedIdentity: MailboxIdentity,
  ): Promise<MailboxCredentials>;
}
export class MailboxError extends Error {
  constructor(
    readonly code:
      | "UNAUTHENTICATED"
      | "RECENT_AUTH_REQUIRED"
      | "INVALID_STATE"
      | "DENIED"
      | "MISSING_PERMISSION"
      | "ACCOUNT_MISMATCH"
      | "MISSING_REFRESH_TOKEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "LIMIT_REACHED"
      | "RECONNECT_REQUIRED"
      | "UNAVAILABLE",
  ) {
    super(code);
  }
}
