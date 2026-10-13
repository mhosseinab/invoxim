import type { MailboxAuthorization, MailboxSession } from "./types";
import { MailboxError } from "./types";
export function requireRecentMailboxSession(
  session: MailboxSession,
  now: number,
): void {
  if (
    session.tenant.authority !== "session" ||
    !Number.isSafeInteger(session.createdAtMs) ||
    session.createdAtMs > now ||
    now - session.createdAtMs > 3600000
  )
    throw new MailboxError("RECENT_AUTH_REQUIRED");
}
export function authorizeMailboxCredentials(
  authorization: MailboxAuthorization,
  existing?: { subject: string; refreshToken?: string },
): MailboxAuthorization {
  if (authorization.canReadMessages !== true)
    throw new MailboxError("MISSING_PERMISSION");
  if (existing && existing.subject !== authorization.identity.subject)
    throw new MailboxError("ACCOUNT_MISMATCH");
  const refreshToken =
    authorization.credentials.refreshToken ?? existing?.refreshToken;
  if (!refreshToken) throw new MailboxError("MISSING_REFRESH_TOKEN");
  return {
    ...authorization,
    credentials: { ...authorization.credentials, refreshToken },
  };
}
