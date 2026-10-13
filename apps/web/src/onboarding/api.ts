import { profileViewSchema } from "@invoxim/contracts";
import { PrivateLoadError, readPrivate } from "../private/api";
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
  "conflict",
  "unauthorized",
  "origin_required",
  "recent_auth_required",
  "account_not_allowed",
  "missing_permission",
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
export async function confirmActor(userId: string, signal: AbortSignal) {
  const profile = await readPrivate("/api/me", profileViewSchema, signal);
  if (profile.user.id !== userId)
    throw new OnboardingRequestError(401, "unauthorized");
}
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

export function identityFailure(error: unknown) {
  return (
    (error instanceof OnboardingRequestError ||
      error instanceof PrivateLoadError) &&
    (error.status === 401 || error.status === 403)
  );
}
