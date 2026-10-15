import type { MailboxAuthorizationPort, MailboxIdentity } from "@invoxim/core";
import { MailboxError } from "@invoxim/core";
import { createGoogleOAuthClient } from "./google-oauth";
import { mailboxProviderJson } from "./provider-json";

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
export function createGmailAuthorization(configuration: {
  clientId: string;
  clientSecret: string;
}): MailboxAuthorizationPort {
  const google = createGoogleOAuthClient({
    clientId: configuration.clientId,
    clientSecret: configuration.clientSecret,
    scopes,
    json: (url, init) => mailboxProviderJson(url, init),
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
