import type { TenantContext } from "@invoxim/core";
import {
  CredentialError,
  encodeBase64url,
  readEnvelopeVersion,
} from "./cipher";
import { redactSecurityFailures } from "./errors";
import type { CredentialCipher, OAuthBinding, OAuthCallbacks } from "./types";

interface StateRow {
  state_hash: string;
  pkce_ciphertext: string;
  pkce_key_version: number;
  nonce: string;
  expires_at: number;
}
const TTL = 600000;
function nowValue(clock: () => number): number {
  const now = clock();
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - TTL
  )
    throw new CredentialError("INVALID_OAUTH_STATE");
  return now;
}
function checkBinding(context: TenantContext, binding: OAuthBinding) {
  if (
    context.authority !== "session" ||
    typeof binding.sessionId !== "string" ||
    binding.sessionId.length === 0 ||
    binding.sessionId.length > 256 ||
    !["mailbox", "storage"].includes(binding.purpose) ||
    !["google", "microsoft"].includes(binding.provider)
  )
    throw new CredentialError("INVALID_OAUTH_STATE");
}
async function digestState(state: string): Promise<string> {
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state))
    throw new CredentialError("INVALID_OAUTH_STATE");
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function createOAuthStateStore(
  db: D1Database,
  cipher: CredentialCipher,
  options: { callbacks: OAuthCallbacks; clock?: () => number },
) {
  const clock = options.clock ?? Date.now;
  const callbacks = new Map<string, string>();
  for (const [purpose, providers] of Object.entries(options.callbacks)) {
    if (!["mailbox", "storage"].includes(purpose))
      throw new CredentialError("INVALID_OAUTH_STATE");
    for (const [provider, value] of Object.entries(providers)) {
      if (
        !["google", "microsoft"].includes(provider) ||
        typeof value !== "string"
      )
        throw new CredentialError("INVALID_OAUTH_STATE");
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new CredentialError("INVALID_OAUTH_STATE");
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      )
        throw new CredentialError("INVALID_OAUTH_STATE");
      callbacks.set(`${purpose}:${provider}`, value);
    }
  }
  function callback(binding: OAuthBinding): string {
    const fixed = callbacks.get(`${binding.purpose}:${binding.provider}`);
    if (!fixed) throw new CredentialError("INVALID_OAUTH_STATE");
    return fixed;
  }
  const liveSession =
    "EXISTS(SELECT 1 FROM \"session\" s JOIN profiles p ON p.user_id=s.userId WHERE s.id=? AND s.userId=? AND s.expiresAt>? AND p.status='active')";
  const operations = {
    async create(
      context: TenantContext,
      input: OAuthBinding & { pkceVerifier: string },
    ): Promise<{
      state: string;
      nonce: string;
      callback: string;
      expiresAt: number;
    }> {
      checkBinding(context, input);
      const fixed = callback(input);
      const before = nowValue(clock);
      if (
        !(await db
          .prepare(`SELECT 1 AS live WHERE ${liveSession}`)
          .bind(input.sessionId, context.userId, before)
          .first())
      )
        throw new CredentialError("INVALID_OAUTH_STATE");
      const state = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
      const nonce = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
      const hash = await digestState(state);
      const encrypted = await cipher.seal(
        context,
        { entityId: hash, purpose: "oauth-pkce" },
        { verifier: input.pkceVerifier },
      );
      const now = nowValue(clock);
      const expiresAt = now + TTL;
      const result = await db
        .prepare(
          `INSERT INTO oauth_states(state_hash,user_id,session_id,purpose,provider,callback,pkce_ciphertext,pkce_key_version,nonce,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${liveSession}`,
        )
        .bind(
          hash,
          context.userId,
          input.sessionId,
          input.purpose,
          input.provider,
          fixed,
          encrypted,
          cipher.activeVersion,
          nonce,
          now,
          expiresAt,
          input.sessionId,
          context.userId,
          now,
        )
        .run();
      if (result.meta.changes !== 1)
        throw new CredentialError("INVALID_OAUTH_STATE");
      return { state, nonce, callback: fixed, expiresAt };
    },
    async consume(
      context: TenantContext,
      input: OAuthBinding & { state: string; callback: string },
    ): Promise<{ pkceVerifier: string; nonce: string } | null> {
      checkBinding(context, input);
      if (input.callback !== callback(input)) return null;
      let hash: string;
      try {
        hash = await digestState(input.state);
      } catch {
        return null;
      }
      const before = nowValue(clock);
      const where = `state_hash=? AND user_id=? AND session_id=? AND purpose=? AND provider=? AND callback=? AND consumed_at IS NULL AND expires_at>? AND ${liveSession}`;
      const bindings = [
        hash,
        context.userId,
        input.sessionId,
        input.purpose,
        input.provider,
        input.callback,
        before,
        input.sessionId,
        context.userId,
        before,
      ];
      const row = await db
        .prepare(
          `SELECT state_hash,pkce_ciphertext,pkce_key_version,nonce,expires_at FROM oauth_states WHERE ${where}`,
        )
        .bind(...bindings)
        .first<StateRow>();
      if (!row) return null;
      if (row.pkce_key_version !== readEnvelopeVersion(row.pkce_ciphertext))
        throw new CredentialError("SECRET_UNAVAILABLE");
      const secret = await cipher.open(
        context,
        { entityId: hash, purpose: "oauth-pkce" },
        row.pkce_ciphertext,
      );
      const now = nowValue(clock);
      const currentBindings = [
        hash,
        context.userId,
        input.sessionId,
        input.purpose,
        input.provider,
        input.callback,
        now,
        input.sessionId,
        context.userId,
        now,
      ];
      const result = await db
        .prepare(
          `UPDATE oauth_states SET consumed_at=?,pkce_ciphertext=NULL,pkce_key_version=NULL,nonce=NULL WHERE ${where} AND pkce_ciphertext=? AND pkce_key_version=? AND nonce=?`,
        )
        .bind(
          now,
          ...currentBindings,
          row.pkce_ciphertext,
          row.pkce_key_version,
          row.nonce,
        )
        .run();
      return result.meta.changes === 1
        ? { pkceVerifier: secret.verifier, nonce: row.nonce }
        : null;
    },
    async purgeExpired(context: TenantContext, limit = 100): Promise<number> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new CredentialError("INVALID_OAUTH_STATE");
      const now = nowValue(clock);
      return (
        await db
          .prepare(
            "DELETE FROM oauth_states WHERE user_id=? AND state_hash IN (SELECT state_hash FROM oauth_states WHERE user_id=? AND expires_at<=? ORDER BY expires_at,state_hash LIMIT ?)",
          )
          .bind(context.userId, context.userId, now, limit)
          .run()
      ).meta.changes;
    },
  };
  return {
    create: redactSecurityFailures(operations.create),
    consume: redactSecurityFailures(operations.consume),
    purgeExpired: redactSecurityFailures(operations.purgeExpired),
  };
}
