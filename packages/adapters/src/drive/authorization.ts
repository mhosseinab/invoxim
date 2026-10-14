import {
  ArchiveAuthorizationError,
  type ArchiveAuthorizationPort,
  type ArchiveIdentity,
} from "@invoxim/core";
import { z } from "zod";
import { createGoogleOAuthClient } from "../mailbox/google-oauth";
import { abortable } from "../security/helpers";
import { DRIVE_AUTHORIZATION_SCOPES, driveClientSchema } from "./configuration";
import { scopesMatchConfiguration } from "./scopes";
import type { DriveHttpTransport } from "./types";

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
  const google = createGoogleOAuthClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes: DRIVE_AUTHORIZATION_SCOPES,
    json: providerJson,
    fail: (code) => new ArchiveAuthorizationError(code),
    owns: (error) => error instanceof ArchiveAuthorizationError,
  });
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
      const url = await google.authorizationUrl({
        ...parsed.data,
        callback: config.callback,
      });
      url.searchParams.set("include_granted_scopes", "false");
      return url.toString();
    },
    async exchange(input) {
      const parsed = exchangeSchema.safeParse(input);
      if (!parsed.success || parsed.data.callback !== config.callback)
        throw new ArchiveAuthorizationError("INVALID_INPUT");
      const result = await google.token({
        grant_type: "authorization_code",
        code: parsed.data.code,
        code_verifier: parsed.data.verifier,
        redirect_uri: config.callback,
      });
      grantedScopes(result.scope, true);
      if (!result.refresh_token)
        throw new ArchiveAuthorizationError("MISSING_REFRESH_TOKEN");
      const signed = await google.verifyIdToken(
        result.id_token,
        parsed.data.nonce,
      );
      const access = await google.userinfo(result.access_token);
      if (access.sub !== signed.sub)
        throw new ArchiveAuthorizationError("ACCOUNT_MISMATCH");
      return {
        identity: { subject: signed.sub, address: access.email.toLowerCase() },
        credentials: google.credentials(result),
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
      const result = await google.token({
        grant_type: "refresh_token",
        refresh_token: parsed.data.refreshToken,
      });
      grantedScopes(result.scope, false);
      const access = await google.userinfo(result.access_token);
      if (access.sub !== stored.data.subject)
        throw new ArchiveAuthorizationError("ACCOUNT_MISMATCH");
      if (result.id_token) {
        const identity = await google.verifyIdToken(result.id_token);
        if (identity.sub !== access.sub)
          throw new ArchiveAuthorizationError("ACCOUNT_MISMATCH");
      }
      return {
        ...google.credentials(result),
        refreshToken: result.refresh_token ?? parsed.data.refreshToken,
      };
    },
  };
}
