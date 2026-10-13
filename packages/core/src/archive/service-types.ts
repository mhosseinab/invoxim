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
