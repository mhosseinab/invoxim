import { type FetchRoute, urlRoute } from "./fetch-spy";

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_ENDPOINT =
  "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_USERINFO_ENDPOINT =
  "https://openidconnect.googleapis.com/v1/userinfo";

/** Synthetic Google OAuth token response body. */
export function googleTokenResponse(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    access_token: "synthetic-google-access",
    expires_in: 3600,
    token_type: "Bearer",
    ...extra,
  };
}

export interface GoogleTokenRouteOptions {
  status?: number;
  before?: () => void | Promise<void>;
  method?: string;
}

/** Route that answers the Google token endpoint with a synthetic body. */
export function googleTokenRoute(
  body: Record<string, unknown>,
  options: GoogleTokenRouteOptions = {},
): FetchRoute {
  return urlRoute(
    GOOGLE_TOKEN_ENDPOINT,
    async () => {
      await options.before?.();
      return Response.json(body, { status: options.status ?? 200 });
    },
    options.method ?? "POST",
  );
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Encode a JSON JWT part as base64url. */
export function encodeJwtPart(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

export const SYNTHETIC_RSA_PARAMS = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;

/** Generate a correct and a wrong RSA pair for synthetic id-token signing. */
export async function generateSigningKeys(): Promise<{
  keys: CryptoKeyPair;
  wrongKeys: CryptoKeyPair;
}> {
  const keys = await crypto.subtle.generateKey(SYNTHETIC_RSA_PARAMS, true, [
    "sign",
    "verify",
  ]);
  const wrongKeys = await crypto.subtle.generateKey(
    SYNTHETIC_RSA_PARAMS,
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in keys) || !("privateKey" in wrongKeys))
    throw new Error("Synthetic RSA key setup failed");
  return { keys, wrongKeys };
}

export interface SignIdTokenOptions {
  claims: Record<string, unknown>;
  privateKey: CryptoKey;
  kid?: string;
  header?: Record<string, unknown>;
  /** When set, the exported public JWK set is returned for JWKS routes. */
  publicKey?: CryptoKey;
}

export interface SignedIdToken {
  jwt: string;
  claims: Record<string, unknown>;
  kid: string;
  jwks?: { keys: unknown[] };
}

/** Sign a synthetic JWT id-token (Google or Microsoft-shaped claims). */
export async function signIdToken(
  options: SignIdTokenOptions,
): Promise<SignedIdToken> {
  const kid = options.kid ?? "synthetic-id-token";
  const message = `${encodeJwtPart({
    alg: "RS256",
    kid,
    typ: "JWT",
    ...options.header,
  })}.${encodeJwtPart(options.claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    options.privateKey,
    new TextEncoder().encode(message),
  );
  const jwt = `${message}.${base64url(new Uint8Array(signature))}`;
  if (!options.publicKey) return { jwt, claims: options.claims, kid };
  const jwk = await crypto.subtle.exportKey("jwk", options.publicKey);
  if (!jwk.kty || !jwk.n || !jwk.e)
    throw new Error("Synthetic RSA JWK export failed");
  return {
    jwt,
    claims: options.claims,
    kid,
    jwks: {
      keys: [{ kty: jwk.kty, n: jwk.n, e: jwk.e, kid, alg: "RS256", use: "sig" }],
    },
  };
}

/** Default Google-shaped id-token claims; caller supplies aud/sub/nonce. */
export function googleIdTokenClaims(
  partial: Record<string, unknown> & { aud: unknown; sub: unknown },
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    email_verified: true,
    iat: now,
    exp: now + 3600,
    ...partial,
  };
}
