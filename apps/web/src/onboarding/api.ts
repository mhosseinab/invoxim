import { assertPrivateIdentity, identityFailure } from "../private/api";

export { identityFailure };
export class OnboardingRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super("Onboarding request unavailable");
  }
}
const safeCodes = new Set([
  "processing_review_required",
  "allowance_unavailable",
  "mailbox_reconnect_required",
  "mailbox_api_disabled",
  "conflict",
  "unauthorized",
  "origin_required",
  "recent_auth_required",
  "account_not_allowed",
  "missing_permission",
  "denied",
  "account_mismatch",
  "limit_reached",
]);
export async function sendOnboarding(
  path: string,
  body: unknown,
  signal: AbortSignal,
  key?: string,
  method: "POST" | "PUT" | "DELETE" = "POST",
  workspaceToken?: string,
): Promise<unknown> {
  const response = await fetch(path, {
    method,
    signal,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
      ...(workspaceToken ? { "X-Workspace-Token": workspaceToken } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let code = "request_unavailable";
    try {
      const value: unknown = await response.json();
      if (
        value &&
        typeof value === "object" &&
        "error" in value &&
        value.error &&
        typeof value.error === "object" &&
        "code" in value.error &&
        typeof value.error.code === "string" &&
        safeCodes.has(value.error.code)
      )
        code = value.error.code;
    } catch {
      /* The response body is not product copy. */
    }
    throw new OnboardingRequestError(response.status, code);
  }
  if (response.status === 204) return null;
  return response.json();
}
export const confirmActor = assertPrivateIdentity;
export function googleAuthorization(value: string): string {
  const url = new URL(value);
  if (
    url.origin !== "https://accounts.google.com" ||
    url.username ||
    url.password
  )
    throw new OnboardingRequestError(502, "request_unavailable");
  return url.href;
}

export function mailboxAuthorization(
  value: string,
  provider: "gmail" | "outlook",
): string {
  if (provider === "gmail") return googleAuthorization(value);
  const url = new URL(value);
  if (
    url.origin !== "https://login.microsoftonline.com" ||
    url.username ||
    url.password ||
    !/^\/(?:common|consumers|organizations|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/oauth2\/v2\.0\/authorize$/i.test(
      url.pathname,
    )
  )
    throw new OnboardingRequestError(502, "request_unavailable");
  return url.href;
}
