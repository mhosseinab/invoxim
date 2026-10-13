import type {
  MailboxAuthorizationPort,
  MailboxCredentials,
  MailboxIdentity,
} from "@invoxim/core";
import { MailboxError } from "@invoxim/core";
import { google, verifyGoogleIdToken } from "better-auth/social-providers";
import { z } from "zod";

const MAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const scopes = ["openid", "email", "profile", MAIL_SCOPE];
const identitySchema = z.object({
  sub: z.string().min(1).max(254),
  email: z.email().max(254),
  email_verified: z.literal(true),
});
const tokenText = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);
const responseSchema = z.object({
  access_token: tokenText,
  refresh_token: tokenText.optional(),
  expires_in: z.number().int().min(1).max(86400),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  scope: z.string().max(4096).optional(),
  id_token: z.string().min(1).max(16384).optional(),
});
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
async function providerJson(url: string, init: RequestInit): Promise<unknown> {
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
  const provider = google({
    clientId: configuration.clientId,
    clientSecret: configuration.clientSecret,
    disableDefaultScope: true,
    scope: scopes,
    includeGrantedScopes: false,
    accessType: "offline",
    prompt: "select_account consent",
  });
  async function token(parameters: Record<string, string>) {
    const parsed = responseSchema.safeParse(
      await providerJson("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...parameters,
          client_id: configuration.clientId,
          client_secret: configuration.clientSecret,
        }),
      }),
    );
    if (!parsed.success) throw new MailboxError("UNAVAILABLE");
    return parsed.data;
  }
  async function accessIdentity(accessToken: string): Promise<MailboxIdentity> {
    const parsed = identitySchema.safeParse(
      await providerJson("https://openidconnect.googleapis.com/v1/userinfo", {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    if (!parsed.success) throw new MailboxError("ACCOUNT_MISMATCH");
    return {
      subject: parsed.data.sub,
      address: parsed.data.email.toLowerCase(),
    };
  }
  async function identityToken(
    idToken: string | undefined,
    nonce?: string,
  ): Promise<MailboxIdentity> {
    if (!idToken) throw new MailboxError("ACCOUNT_MISMATCH");
    const claims = await verifyGoogleIdToken({
      token: idToken,
      audience: configuration.clientId,
      ...(nonce ? { nonce } : {}),
    });
    const parsed = identitySchema
      .extend({ exp: z.number().int().positive() })
      .safeParse(claims);
    if (
      !parsed.success ||
      parsed.data.exp <= Math.floor(Date.now() / 1000) ||
      (nonce && claims?.nonce !== nonce)
    )
      throw new MailboxError("ACCOUNT_MISMATCH");
    return {
      subject: parsed.data.sub,
      address: parsed.data.email.toLowerCase(),
    };
  }
  function credentials(
    result: z.infer<typeof responseSchema>,
  ): MailboxCredentials {
    return {
      accessToken: result.access_token,
      expiresAt: Date.now() + result.expires_in * 1000,
      ...(result.refresh_token ? { refreshToken: result.refresh_token } : {}),
    };
  }
  return {
    async authorize(input) {
      const url = await provider.createAuthorizationURL({
        state: input.state,
        codeVerifier: input.verifier,
        redirectURI: input.callback,
      });
      url.searchParams.set("nonce", input.nonce);
      return url.toString();
    },
    async exchange(input) {
      const result = await token({
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
        credentials: credentials(result),
        canReadMessages: true,
      };
    },
    async refresh(current, expectedIdentity) {
      if (!current.refreshToken) throw new MailboxError("RECONNECT_REQUIRED");
      const result = await token({
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
        ...credentials(result),
        refreshToken: result.refresh_token ?? current.refreshToken,
      };
    },
  };
}
