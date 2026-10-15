import { MailboxError } from "@invoxim/core";
import { z } from "zod";
import { readJsonResponseBody } from "../http";

/** G8: provider control-plane responses are small; 64 KiB is the cap. */
const MAX_PROVIDER_JSON_BYTES = 65536;
const PROVIDER_TIMEOUT_MS = 10000;
const errorSchema = z.object({ error: z.string() });

/**
 * G8: the one mailbox OAuth/userinfo/JWKS JSON transport for Gmail and
 * Outlook. Fixed caller-supplied endpoints only, redirects refused, a 10 s
 * deadline and SEC-4's bounded reader. Every transport or parse failure is
 * `UNAVAILABLE`; a 400 `invalid_grant` is `RECONNECT_REQUIRED`, and a 400
 * whose error is in `permissionErrors` is `MISSING_PERMISSION`. No provider
 * detail is reflected into the thrown error.
 */
export async function mailboxProviderJson(
  url: string,
  init: RequestInit = {},
  permissionErrors: readonly string[] = [],
): Promise<unknown> {
  const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  const deadline = Date.now() + PROVIDER_TIMEOUT_MS;
  let body: unknown;
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "manual", signal });
    body = await readJsonResponseBody(response, MAX_PROVIDER_JSON_BYTES, {
      signal,
      deadline,
    });
  } catch {
    throw new MailboxError("UNAVAILABLE");
  }
  if (!response.ok) {
    const error = errorSchema.safeParse(body);
    if (response.status === 400 && error.success) {
      if (error.data.error === "invalid_grant")
        throw new MailboxError("RECONNECT_REQUIRED");
      if (permissionErrors.includes(error.data.error))
        throw new MailboxError("MISSING_PERMISSION");
    }
    throw new MailboxError("UNAVAILABLE");
  }
  return body;
}
