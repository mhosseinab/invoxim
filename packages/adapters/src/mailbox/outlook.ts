import { oauthTokenResponseSchema } from "@invoxim/contracts";
import type {
  MailboxAuthorizationPort,
  MailboxCredentials,
  MailboxIdentity,
} from "@invoxim/core";
import { MailboxError } from "@invoxim/core";
import { verifyProviderIdToken } from "better-auth/oauth2";
import { microsoft } from "better-auth/social-providers";
import { z } from "zod";
import {
  OUTLOOK_AUTHORIZATION_SCOPES,
  outlookAuthoritySchema,
} from "./outlook-configuration";
import { mailboxProviderJson } from "./provider-json";

const origin = "https://login.microsoftonline.com";
const consumerTenant = "9188040d-6c67-4c5b-b112-36a304b66dad";
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const subject = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/);
const claimsSchema = z.object({
  iss: z.string().max(120),
  tid: uuid,
  sub: subject,
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
  ver: z.literal("2.0"),
});
const userinfoSchema = z.object({
  sub: subject,
  email: z.email().max(254).optional(),
});
const jwksSchema = z.object({
  keys: z
    .array(
      z.object({
        kty: z.literal("RSA"),
        kid: z.string().min(1).max(160),
        alg: z.literal("RS256").optional(),
        use: z.literal("sig").optional(),
        n: z
          .string()
          .min(342)
          .max(1024)
          .regex(/^[A-Za-z0-9_-]+$/),
        e: z
          .string()
          .min(1)
          .max(16)
          .regex(/^[A-Za-z0-9_-]+$/),
        issuer: z.string().min(1).max(160),
      }),
    )
    .min(1)
    .max(20),
});
function permittedTenant(authority: string, tid: string) {
  return (
    authority === "common" ||
    (authority === "consumers"
      ? tid === consumerTenant
      : authority === "organizations"
        ? tid !== consumerTenant
        : authority === tid)
  );
}
export function validateOutlookReadScopes(
  scope: string | undefined,
  required: boolean,
) {
  if (scope === undefined) {
    if (required) throw new MailboxError("MISSING_PERMISSION");
    return;
  }
  const normalized = scope
    .trim()
    .split(/\s+/)
    .map((value) =>
      value.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, ""),
    );
  if (
    !normalized.includes("mail.read") ||
    normalized.some(
      (value) =>
        !["openid", "profile", "email", "offline_access", "mail.read"].includes(
          value,
        ),
    )
  )
    throw new MailboxError("MISSING_PERMISSION");
}
const permissionErrors = [
  "invalid_scope",
  "consent_required",
  "interaction_required",
] as const;
function providerJson(url: string, init: RequestInit): Promise<unknown> {
  return mailboxProviderJson(url, init, permissionErrors);
}
export function createOutlookAuthorization(configuration: {
  clientId: string;
  clientSecret: string;
  authority?: string;
}): MailboxAuthorizationPort {
  const parsedAuthority = outlookAuthoritySchema.safeParse(
    configuration.authority ?? "common",
  );
  if (!parsedAuthority.success) throw new MailboxError("UNAVAILABLE");
  const authority = parsedAuthority.data;
  const provider = microsoft({
    clientId: configuration.clientId,
    clientSecret: configuration.clientSecret,
    tenantId: authority,
    disableDefaultScope: true,
    disableProfilePhoto: true,
    scope: [...OUTLOOK_AUTHORIZATION_SCOPES],
    prompt: "select_account",
  });
  async function token(parameters: Record<string, string>) {
    const result = oauthTokenResponseSchema.safeParse(
      await providerJson(`${origin}/${authority}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...parameters,
          client_id: configuration.clientId,
          client_secret: configuration.clientSecret,
          scope: OUTLOOK_AUTHORIZATION_SCOPES.join(" "),
        }),
      }),
    );
    if (!result.success) throw new MailboxError("UNAVAILABLE");
    return result.data;
  }
  async function signedIdentity(idToken: string | undefined, nonce: string) {
    if (!idToken || !nonce || nonce.length > 256)
      throw new MailboxError("ACCOUNT_MISMATCH");
    let claims: z.infer<typeof claimsSchema> | undefined;
    let keyIssuer: string | undefined;
    const verifier = {
      ...provider,
      idToken: {
        ...provider.idToken,
        algorithms: ["RS256"],
        jwks: async (header: { kid?: string }) => {
          if (!header.kid || header.kid.length > 160)
            throw new MailboxError("ACCOUNT_MISMATCH");
          const parsed = jwksSchema.safeParse(
            await providerJson(`${origin}/${authority}/discovery/v2.0/keys`, {
              method: "GET",
            }),
          );
          if (!parsed.success) throw new MailboxError("ACCOUNT_MISMATCH");
          const matches = parsed.data.keys.filter(
            (key) => key.kid === header.kid,
          );
          const key = matches[0];
          if (matches.length !== 1 || !key)
            throw new MailboxError("ACCOUNT_MISMATCH");
          keyIssuer = key.issuer;
          return crypto.subtle.importKey(
            "jwk",
            { kty: key.kty, n: key.n, e: key.e, alg: "RS256", use: "sig" },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          );
        },
        verifyClaims: (value: Record<string, unknown>) => {
          const parsed = claimsSchema.safeParse(value);
          if (
            !parsed.success ||
            !provider.idToken.verifyClaims(value) ||
            !permittedTenant(authority, parsed.data.tid) ||
            keyIssuer?.replace("{tenantid}", parsed.data.tid) !==
              parsed.data.iss
          )
            return false;
          claims = parsed.data;
          return true;
        },
      },
    };
    if (!(await verifyProviderIdToken(verifier, idToken, nonce)) || !claims)
      throw new MailboxError("ACCOUNT_MISMATCH");
    return claims;
  }
  async function accessIdentity(accessToken: string) {
    const result = userinfoSchema.safeParse(
      await providerJson("https://graph.microsoft.com/oidc/userinfo", {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    if (!result.success) throw new MailboxError("ACCOUNT_MISMATCH");
    return result.data;
  }
  function credentials(
    result: z.infer<typeof oauthTokenResponseSchema>,
  ): MailboxCredentials {
    return {
      accessToken: result.access_token,
      expiresAt: Date.now() + result.expires_in * 1000,
      ...(result.refresh_token ? { refreshToken: result.refresh_token } : {}),
    };
  }
  function expectedSubject(identity: MailboxIdentity) {
    const matched =
      /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0\|([A-Za-z0-9_-]{1,160})$/.exec(
        identity.subject,
      );
    const tid = matched?.[1],
      sub = matched?.[2];
    if (
      !tid ||
      !sub ||
      !uuid.safeParse(tid).success ||
      !permittedTenant(authority, tid)
    )
      throw new MailboxError("ACCOUNT_MISMATCH");
    return sub;
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
      // Never redeem a code without the state-bound nonce.
      if (!input.nonce) throw new MailboxError("INVALID_STATE");
      const result = await token({
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: input.verifier,
        redirect_uri: input.callback,
      });
      validateOutlookReadScopes(result.scope, true);
      const identity = await signedIdentity(result.id_token, input.nonce);
      const access = await accessIdentity(result.access_token);
      if (access.sub !== identity.sub)
        throw new MailboxError("ACCOUNT_MISMATCH");
      if (!access.email) throw new MailboxError("MISSING_PERMISSION");
      return {
        identity: {
          subject: `${identity.iss}|${identity.sub}`,
          address: access.email.toLowerCase(),
        },
        credentials: credentials(result),
        canReadMessages: true,
      };
    },
    async refresh(current, identity) {
      const expected = expectedSubject(identity);
      if (!current.refreshToken) throw new MailboxError("RECONNECT_REQUIRED");
      const result = await token({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
      });
      validateOutlookReadScopes(result.scope, false);
      const access = await accessIdentity(result.access_token);
      if (access.sub !== expected) throw new MailboxError("ACCOUNT_MISMATCH");
      // Microsoft may return an optional/unsigned refresh ID token. It is never authority.
      return {
        ...credentials(result),
        refreshToken: result.refresh_token ?? current.refreshToken,
      };
    },
  };
}
