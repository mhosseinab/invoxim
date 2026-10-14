import type { MailboxAuthorizationPort, MailboxIdentity } from "@invoxim/core";
import { MailboxError } from "@invoxim/core";
import { z } from "zod";
import { createGoogleOAuthClient } from "./google-oauth";

const MAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const scopes = ["openid", "email", "profile", MAIL_SCOPE];
function checkScopes(value: string | undefined, required: boolean) {
  if (value === undefined) {
    if (required) throw new MailboxError("MISSING_PERMISSION");
    return;
  }
  const aliases: Record<string, string> = {
    "https://www.googleapis.com/auth/userinfo.email": "email",
    "https://www.googleapis.com/auth/userinfo.profile": "profile",
  };
  const granted = new Set(
    value
      .trim()
      .split(/\s+/)
      .map((item) => aliases[item] ?? item),
  );
  if (
    scopes.some((scope) => !granted.has(scope)) ||
    [...granted].some((scope) => !scopes.includes(scope))
  )
    throw new MailboxError("MISSING_PERMISSION");
}
async function providerJson(
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const signal = AbortSignal.timeout(10000);
  const deadline = Date.now() + 10000;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal,
    });
  } catch {
    throw new MailboxError("UNAVAILABLE");
  }
  if (response.status >= 300 && response.status < 400)
    throw new MailboxError("UNAVAILABLE");
  if (
    response.headers.get("content-length") &&
    Number(response.headers.get("content-length")) > 65536
  )
    throw new MailboxError("UNAVAILABLE");
  const reader = response.body?.getReader();
  if (!reader) throw new MailboxError("UNAVAILABLE");
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new MailboxError("UNAVAILABLE"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  const bytes = new Uint8Array(65536);
  let length = 0;
  let dataChunks = 0;
  let emptyChunks = 0;
  function checkDeadline() {
    if (signal.aborted || Date.now() >= deadline)
      throw new MailboxError("UNAVAILABLE");
  }
  try {
    while (true) {
      checkDeadline();
      const chunk = await Promise.race([reader.read(), stopped]);
      checkDeadline();
      if (chunk.done) break;
      if (chunk.value.byteLength === 0) {
        if (++emptyChunks > 32) throw new MailboxError("UNAVAILABLE");
        continue;
      }
      if (++dataChunks > 4096 || length + chunk.value.byteLength > bytes.length)
        throw new MailboxError("UNAVAILABLE");
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
  } catch {
    void reader.cancel().catch(() => {});
    throw new MailboxError("UNAVAILABLE");
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  let body: unknown;
  try {
    body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        bytes.subarray(0, length),
      ),
    );
  } catch {
    throw new MailboxError("UNAVAILABLE");
  }
  if (!response.ok) {
    if (
      response.status === 400 &&
      z.object({ error: z.literal("invalid_grant") }).safeParse(body).success
    )
      throw new MailboxError("RECONNECT_REQUIRED");
    throw new MailboxError("UNAVAILABLE");
  }
  return body;
}
export function createGmailAuthorization(configuration: {
  clientId: string;
  clientSecret: string;
}): MailboxAuthorizationPort {
  const google = createGoogleOAuthClient({
    clientId: configuration.clientId,
    clientSecret: configuration.clientSecret,
    scopes,
    json: providerJson,
    fail: (code) => new MailboxError(code),
    owns: (error) => error instanceof MailboxError,
  });
  async function accessIdentity(accessToken: string): Promise<MailboxIdentity> {
    const identity = await google.userinfo(accessToken);
    return { subject: identity.sub, address: identity.email.toLowerCase() };
  }
  async function identityToken(
    idToken: string | undefined,
    nonce?: string,
  ): Promise<MailboxIdentity> {
    const claims = await google.verifyIdToken(idToken, nonce);
    return { subject: claims.sub, address: claims.email.toLowerCase() };
  }
  return {
    async authorize(input) {
      return (await google.authorizationUrl(input)).toString();
    },
    async exchange(input) {
      const result = await google.token({
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: input.verifier,
        redirect_uri: input.callback,
      });
      checkScopes(result.scope, true);
      const identity = await identityToken(result.id_token, input.nonce);
      const access = await accessIdentity(result.access_token);
      if (
        access.subject !== identity.subject ||
        access.address !== identity.address
      )
        throw new MailboxError("ACCOUNT_MISMATCH");
      return {
        identity,
        credentials: google.credentials(result),
        canReadMessages: true,
      };
    },
    async refresh(current, expectedIdentity) {
      if (!current.refreshToken) throw new MailboxError("RECONNECT_REQUIRED");
      const result = await google.token({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
      });
      checkScopes(result.scope, false);
      const access = await accessIdentity(result.access_token);
      if (access.subject !== expectedIdentity.subject)
        throw new MailboxError("ACCOUNT_MISMATCH");
      if (result.id_token) {
        const identity = await identityToken(result.id_token);
        if (
          identity.subject !== access.subject ||
          identity.address !== access.address
        )
          throw new MailboxError("ACCOUNT_MISMATCH");
      }
      return {
        ...google.credentials(result),
        refreshToken: result.refresh_token ?? current.refreshToken,
      };
    },
  };
}
