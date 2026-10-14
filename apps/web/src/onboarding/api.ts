import {
  assertPrivateIdentity,
  identityFailure,
  RequestError,
  type RequestJsonInit,
  requestJson,
} from "../private/api";

export { identityFailure };
export class OnboardingRequestError extends RequestError {}

const rawJson = {
  safeParse(value: unknown) {
    return { success: true as const, data: value };
  },
};

export async function sendOnboarding(
  path: string,
  body: unknown,
  signal: AbortSignal,
  key?: string,
  method: "POST" | "PUT" | "DELETE" = "POST",
  workspaceToken?: string,
): Promise<unknown> {
  try {
    return await requestJson(path, rawJson, {
      signal,
      method,
      body,
      idempotencyKey: key,
      workspaceToken,
    } satisfies RequestJsonInit);
  } catch (error) {
    if (error instanceof RequestError)
      throw new OnboardingRequestError(
        error.status,
        error.code,
        error.retryable,
      );
    throw error;
  }
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
