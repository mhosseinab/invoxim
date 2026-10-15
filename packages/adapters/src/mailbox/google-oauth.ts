import { oauthTokenResponseSchema } from "@invoxim/contracts";
import { verifyProviderIdToken } from "better-auth/oauth2";
import { google } from "better-auth/social-providers";
import { z } from "zod";

/**
 * D2: the one Google OAuth client for independent mailbox (Gmail) and storage
 * (Drive) authorization. Both previously built their own client and verified
 * ID tokens differently, so a token with a foreign `azp`, a multi-value
 * audience, a non-printable subject or an ambiguous key ID passed Gmail but
 * not Drive. Verification now has a single, strict definition.
 *
 * The adapter supplies its bounded, redirect-refusing transport and its own
 * error type; this module never calls `fetch` itself.
 */
export type GoogleOAuthFailure =
  | "ACCOUNT_MISMATCH"
  | "MISSING_PERMISSION"
  | "RECONNECT_REQUIRED"
  | "UNAVAILABLE";

export interface GoogleOAuthClientOptions {
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  /** Adapter-owned bounded JSON transport (fixed endpoints, no redirects). */
  json(url: string, init?: RequestInit): Promise<unknown>;
  /** Builds the adapter's own error for a failure code. */
  fail(code: GoogleOAuthFailure): Error;
  /** True for errors the adapter already owns (rethrown unchanged). */
  owns(error: unknown): boolean;
}

export type GoogleTokenResponse = z.infer<typeof oauthTokenResponseSchema>;

const tokenEndpoint = "https://oauth2.googleapis.com/token";
const keysEndpoint = "https://www.googleapis.com/oauth2/v3/certs";
const userEndpoint = "https://openidconnect.googleapis.com/v1/userinfo";
const subject = z
  .string()
  .min(1)
  .max(254)
  .regex(/^[\x21-\x7e]+$/);
export const googleIdentitySchema = z.object({
  sub: subject,
  email: z.email().max(254),
  email_verified: z.literal(true),
});
const claimsSchema = googleIdentitySchema.extend({
  iss: z.enum(["https://accounts.google.com", "accounts.google.com"]),
  aud: z.string().min(1).max(300),
  azp: z.string().min(1).max(300).optional(),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
});
export type GoogleIdTokenClaims = z.infer<typeof claimsSchema>;
const jwksSchema = z.object({
  keys: z
    .array(
      z.strictObject({
        kty: z.literal("RSA"),
        kid: z
          .string()
          .min(1)
          .max(160)
          .regex(/^[\x21-\x7e]+$/),
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
      }),
    )
    .min(1)
    .max(20),
});

export function createGoogleOAuthClient(options: GoogleOAuthClientOptions) {
  const { clientId, clientSecret, json, fail, owns } = options;
  const provider = google({
    clientId,
    clientSecret,
    disableDefaultScope: true,
    scope: [...options.scopes],
    includeGrantedScopes: false,
    accessType: "offline",
    prompt: "select_account consent",
  });
  async function authorizationUrl(input: {
    state: string;
    verifier: string;
    callback: string;
    nonce: string;
  }): Promise<URL> {
    const url = await provider.createAuthorizationURL({
      state: input.state,
      codeVerifier: input.verifier,
      redirectURI: input.callback,
    });
    url.searchParams.set("nonce", input.nonce);
    return url;
  }
  async function token(
    parameters: Record<string, string>,
  ): Promise<GoogleTokenResponse> {
    const result = oauthTokenResponseSchema.safeParse(
      await json(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...parameters,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      }),
    );
    if (!result.success) throw fail("UNAVAILABLE");
    return result.data;
  }
  /** RS256 only, fixed Google JWKS, exact audience/azp, issued-before-expiry. */
  async function verifyIdToken(
    idToken: string | undefined,
    nonce?: string,
  ): Promise<GoogleIdTokenClaims> {
    if (!idToken) throw fail("ACCOUNT_MISMATCH");
    let claims: GoogleIdTokenClaims | undefined;
    let resolverFailure: Error | undefined;
    const verifier = {
      ...provider,
      idToken: {
        ...provider.idToken,
        algorithms: ["RS256"],
        jwks: async (header: { kid?: string }) => {
          if (!header.kid || header.kid.length > 160)
            throw fail("ACCOUNT_MISMATCH");
          try {
            const keys = jwksSchema.safeParse(
              await json(keysEndpoint, { method: "GET" }),
            );
            if (!keys.success) throw fail("ACCOUNT_MISMATCH");
            const matches = keys.data.keys.filter(
              (key) => key.kid === header.kid,
            );
            const key = matches[0];
            if (matches.length !== 1 || !key) throw fail("ACCOUNT_MISMATCH");
            return await crypto.subtle.importKey(
              "jwk",
              { kty: key.kty, n: key.n, e: key.e, alg: "RS256", use: "sig" },
              { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
              false,
              ["verify"],
            );
          } catch (error) {
            if (owns(error)) resolverFailure = error as Error;
            throw error;
          }
        },
        verifyClaims: (value: Record<string, unknown>) => {
          const result = claimsSchema.safeParse(value);
          const now = Math.floor(Date.now() / 1000);
          if (
            !result.success ||
            result.data.aud !== clientId ||
            (result.data.azp !== undefined && result.data.azp !== clientId) ||
            result.data.iat > now ||
            result.data.exp <= now ||
            result.data.exp <= result.data.iat
          )
            return false;
          claims = result.data;
          return true;
        },
      },
    };
    if (!(await verifyProviderIdToken(verifier, idToken, nonce)) || !claims) {
      if (resolverFailure) throw resolverFailure;
      throw fail("ACCOUNT_MISMATCH");
    }
    return claims;
  }
  async function userinfo(accessToken: string) {
    const parsed = googleIdentitySchema.safeParse(
      await json(userEndpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    if (!parsed.success) throw fail("ACCOUNT_MISMATCH");
    return parsed.data;
  }
  function credentials(result: GoogleTokenResponse) {
    return {
      accessToken: result.access_token,
      expiresAt: Date.now() + result.expires_in * 1000,
      ...(result.refresh_token ? { refreshToken: result.refresh_token } : {}),
    };
  }
  return { authorizationUrl, token, verifyIdToken, userinfo, credentials };
}
