import {
  ArchiveAuthorizationError,
  type ArchiveAuthorizationPort,
  type ArchiveCredentials,
  type ArchiveIdentity,
} from "@invoxim/core";
import { verifyProviderIdToken } from "better-auth/oauth2";
import { google } from "better-auth/social-providers";
import { z } from "zod";
import { abortable } from "../security/helpers";
import { DRIVE_AUTHORIZATION_SCOPES, driveClientSchema } from "./configuration";
import { scopesMatchConfiguration } from "./scopes";
import type { DriveHttpTransport } from "./types";

const tokenEndpoint = "https://oauth2.googleapis.com/token";
const keysEndpoint = "https://www.googleapis.com/oauth2/v3/certs";
const userEndpoint = "https://openidconnect.googleapis.com/v1/userinfo";
const maximumBytes = 65536;
const visible = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);
const subject = z
  .string()
  .min(1)
  .max(254)
  .regex(/^[\x21-\x7e]+$/);
const identitySchema = z.object({
  sub: subject,
  email: z.email().max(254),
  email_verified: z.literal(true),
});
const claimsSchema = identitySchema.extend({
  iss: z.enum(["https://accounts.google.com", "accounts.google.com"]),
  aud: z.string().min(1).max(300),
  azp: z.string().min(1).max(300).optional(),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
});
const tokensSchema = z.object({
  access_token: visible,
  refresh_token: visible.optional(),
  expires_in: z.number().int().min(1).max(86400),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  scope: z.string().max(4096).optional(),
  id_token: z.string().min(1).max(16384).optional(),
});
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
const challenge = z
  .string()
  .min(16)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
const exchangeSchema = z.object({
  code: visible.refine((value) => value.length <= 2048),
  verifier: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9._~-]+$/),
  nonce: challenge,
  callback: z.string().max(500),
});
function grantedScopes(value: string | undefined, required: boolean) {
  if (value === undefined) {
    if (required) throw new ArchiveAuthorizationError("MISSING_PERMISSION");
    return;
  }
  if (!scopesMatchConfiguration(value))
    throw new ArchiveAuthorizationError("MISSING_PERMISSION");
}
function unavailable() {
  return new ArchiveAuthorizationError("UNAVAILABLE");
}
async function bodyJson(
  response: Response,
  signal: AbortSignal,
  deadline: number,
): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^[0-9]+$/.test(length) || Number(length) > maximumBytes)
  )
    throw new ArchiveAuthorizationError("UNAVAILABLE");
  if (
    response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    throw new ArchiveAuthorizationError("UNAVAILABLE");
  const reader = response.body?.getReader();
  if (!reader) throw new ArchiveAuthorizationError("UNAVAILABLE");
  const bytes = new Uint8Array(maximumBytes);
  let size = 0;
  let nonemptyChunks = 0;
  let emptyChunks = 0;
  try {
    while (true) {
      if (signal.aborted || Date.now() >= deadline)
        throw new ArchiveAuthorizationError("UNAVAILABLE");
      const item = await abortable(reader.read(), signal, unavailable);
      if (signal.aborted || Date.now() >= deadline)
        throw new ArchiveAuthorizationError("UNAVAILABLE");
      if (item.done) break;
      if (item.value.byteLength === 0) {
        if (++emptyChunks > 32)
          throw new ArchiveAuthorizationError("UNAVAILABLE");
        continue;
      }
      if (
        ++nonemptyChunks > 4096 ||
        item.value.byteLength > maximumBytes - size
      )
        throw new ArchiveAuthorizationError("UNAVAILABLE");
      bytes.set(item.value, size);
      size += item.value.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes.subarray(0, size),
        ),
      );
    } catch {
      throw new ArchiveAuthorizationError("UNAVAILABLE");
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createDriveAuthorization(
  configuration: { clientId: string; clientSecret: string; callback: string },
  http: DriveHttpTransport = (request) => fetch(request),
  timeoutMs = 10000,
): ArchiveAuthorizationPort {
  const parsed = driveClientSchema.safeParse(configuration);
  if (
    !parsed.success ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 10000
  )
    throw new ArchiveAuthorizationError("INVALID_INPUT");
  const config = parsed.data;
  const provider = google({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    disableDefaultScope: true,
    scope: [...DRIVE_AUTHORIZATION_SCOPES],
    includeGrantedScopes: false,
    accessType: "offline",
    prompt: "select_account consent",
  });
  async function providerJson(
    url: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    try {
      response = await abortable<Response>(
        http(
          new Request(url, {
            ...init,
            redirect: "manual",
            signal: controller.signal,
          }),
        ).then((settled) => {
          if (controller.signal.aborted && settled.body)
            void settled.body.cancel().catch(() => undefined);
          return settled;
        }),
        controller.signal,
        unavailable,
      );
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      )
        throw new ArchiveAuthorizationError("UNAVAILABLE");
      if (response.status === 401)
        throw new ArchiveAuthorizationError("RECONNECT_REQUIRED");
      if (response.status === 403)
        throw new ArchiveAuthorizationError("MISSING_PERMISSION");
      const body = await bodyJson(response, controller.signal, deadline);
      if (!response.ok) {
        const error = z.object({ error: z.string() }).safeParse(body);
        if (error.success && error.data.error === "invalid_grant")
          throw new ArchiveAuthorizationError("RECONNECT_REQUIRED");
        if (
          error.success &&
          ["invalid_scope", "access_denied", "consent_required"].includes(
            error.data.error,
          )
        )
          throw new ArchiveAuthorizationError("MISSING_PERMISSION");
        throw new ArchiveAuthorizationError("UNAVAILABLE");
      }
      return body;
    } catch (error) {
      if (error instanceof ArchiveAuthorizationError) throw error;
      throw new ArchiveAuthorizationError("UNAVAILABLE");
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (response?.body) void response.body.cancel().catch(() => undefined);
    }
  }
  async function token(parameters: Record<string, string>) {
    const result = tokensSchema.safeParse(
      await providerJson(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...parameters,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
      }),
    );
    if (!result.success) throw new ArchiveAuthorizationError("UNAVAILABLE");
    return result.data;
  }
  async function signedIdentity(idToken: string | undefined, nonce?: string) {
    if (!idToken) throw new ArchiveAuthorizationError("ACCOUNT_MISMATCH");
    let claims: z.infer<typeof claimsSchema> | undefined;
    let resolverFailure: ArchiveAuthorizationError | undefined;
    const verifier = {
      ...provider,
      idToken: {
        ...provider.idToken,
        algorithms: ["RS256"],
        jwks: async (header: { kid?: string }) => {
          if (!header.kid || header.kid.length > 160)
            throw new ArchiveAuthorizationError("ACCOUNT_MISMATCH");
          try {
            const keys = jwksSchema.safeParse(await providerJson(keysEndpoint));
            if (!keys.success)
              throw new ArchiveAuthorizationError("ACCOUNT_MISMATCH");
            const matches = keys.data.keys.filter(
              (key) => key.kid === header.kid,
            );
            const key = matches[0];
            if (matches.length !== 1 || !key)
              throw new ArchiveAuthorizationError("ACCOUNT_MISMATCH");
            return await crypto.subtle.importKey(
              "jwk",
              { kty: key.kty, n: key.n, e: key.e, alg: "RS256", use: "sig" },
              { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
              false,
              ["verify"],
            );
          } catch (error) {
            if (error instanceof ArchiveAuthorizationError)
              resolverFailure = error;
            throw error;
          }
        },
        verifyClaims: (value: Record<string, unknown>) => {
          const result = claimsSchema.safeParse(value);
          const now = Math.floor(Date.now() / 1000);
          if (
            !result.success ||
            result.data.aud !== config.clientId ||
            (result.data.azp !== undefined &&
              result.data.azp !== config.clientId) ||
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
      throw new ArchiveAuthorizationError("ACCOUNT_MISMATCH");
    }
    return claims;
  }
  async function accessIdentity(accessToken: string) {
    const parsed = identitySchema.safeParse(
      await providerJson(userEndpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    if (!parsed.success)
      throw new ArchiveAuthorizationError("ACCOUNT_MISMATCH");
    return parsed.data;
  }
  function credentials(
    result: z.infer<typeof tokensSchema>,
  ): ArchiveCredentials {
    return {
      accessToken: result.access_token,
      expiresAt: Date.now() + result.expires_in * 1000,
      ...(result.refresh_token ? { refreshToken: result.refresh_token } : {}),
    };
  }
  return {
    async authorize(input) {
      const parsed = z
        .object({
          state: challenge,
          nonce: challenge,
          verifier: exchangeSchema.shape.verifier,
          callback: z.literal(config.callback),
        })
        .safeParse(input);
      if (!parsed.success) throw new ArchiveAuthorizationError("INVALID_INPUT");
      const url = await provider.createAuthorizationURL({
        state: parsed.data.state,
        codeVerifier: parsed.data.verifier,
        redirectURI: config.callback,
      });
      url.searchParams.set("nonce", parsed.data.nonce);
      url.searchParams.set("include_granted_scopes", "false");
      return url.toString();
    },
    async exchange(input) {
      const parsed = exchangeSchema.safeParse(input);
      if (!parsed.success || parsed.data.callback !== config.callback)
        throw new ArchiveAuthorizationError("INVALID_INPUT");
      const result = await token({
        grant_type: "authorization_code",
        code: parsed.data.code,
        code_verifier: parsed.data.verifier,
        redirect_uri: config.callback,
      });
      grantedScopes(result.scope, true);
      if (!result.refresh_token)
        throw new ArchiveAuthorizationError("MISSING_REFRESH_TOKEN");
      const signed = await signedIdentity(result.id_token, parsed.data.nonce);
      const access = await accessIdentity(result.access_token);
      if (access.sub !== signed.sub)
        throw new ArchiveAuthorizationError("ACCOUNT_MISMATCH");
      return {
        identity: { subject: signed.sub, address: access.email.toLowerCase() },
        credentials: credentials(result),
        canArchiveFiles: true,
      };
    },
    async refresh(current, expected: ArchiveIdentity) {
      const stored = z
        .object({ subject, address: z.email().max(254) })
        .safeParse(expected);
      const parsed = z
        .object({
          accessToken: visible,
          refreshToken: visible.optional(),
          expiresAt: z.number().int().safe(),
        })
        .safeParse(current);
      if (!stored.success || !parsed.success)
        throw new ArchiveAuthorizationError("INVALID_INPUT");
      if (!parsed.data.refreshToken)
        throw new ArchiveAuthorizationError("RECONNECT_REQUIRED");
      const result = await token({
        grant_type: "refresh_token",
        refresh_token: parsed.data.refreshToken,
      });
      grantedScopes(result.scope, false);
      const access = await accessIdentity(result.access_token);
      if (access.sub !== stored.data.subject)
        throw new ArchiveAuthorizationError("ACCOUNT_MISMATCH");
      if (result.id_token) {
        const identity = await signedIdentity(result.id_token);
        if (identity.sub !== access.sub)
          throw new ArchiveAuthorizationError("ACCOUNT_MISMATCH");
      }
      return {
        ...credentials(result),
        refreshToken: result.refresh_token ?? parsed.data.refreshToken,
      };
    },
  };
}
