import type { TenantContext } from "@invoxim/core";
import { CredentialError, readEnvelopeVersion } from "./cipher";
import { redactSecurityFailures } from "./errors";
import type {
  CredentialCipher,
  CredentialMetadata,
  CredentialSnapshot,
  CredentialTarget,
  ProviderCredentials,
  SecretPayloads,
  SecretPurpose,
} from "./types";

interface StoredCredential {
  ciphertext: string | null;
  key_version: number | null;
  version: number;
  generation: number;
  kind: string;
  state: string;
}
function checkTarget(target: CredentialTarget) {
  if (
    !["connection", "byok"].includes(target.kind) ||
    typeof target.id !== "string" ||
    target.id.length === 0 ||
    target.id.length > 256 ||
    !Number.isSafeInteger(target.generation) ||
    target.generation < 1 ||
    (target.kind === "byok" && target.id !== "primary")
  )
    throw new CredentialError("INVALID_SECRET");
}
function purpose(
  row: StoredCredential,
  target: CredentialTarget,
): Exclude<SecretPurpose, "oauth-pkce" | "archive-upload-session"> {
  if (target.kind === "byok") return "byok-key";
  if (row.kind === "mailbox") return "mailbox-credentials";
  if (row.kind === "storage") return "storage-credentials";
  throw new CredentialError("SECRET_UNAVAILABLE");
}
function checkVersion(version: number) {
  if (!Number.isSafeInteger(version) || version < 0)
    throw new CredentialError("INVALID_SECRET");
}
export function createCredentialVault(
  db: D1Database,
  cipher: CredentialCipher,
) {
  async function stored(
    context: TenantContext,
    target: CredentialTarget,
  ): Promise<StoredCredential | null> {
    checkTarget(target);
    if (target.kind === "connection")
      return db
        .prepare(
          "SELECT credential_ciphertext AS ciphertext,credential_key_version AS key_version,credential_version AS version,generation,kind,state FROM connections WHERE user_id=? AND id=? AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')",
        )
        .bind(context.userId, target.id, context.userId)
        .first<StoredCredential>();
    return db
      .prepare(
        "SELECT encrypted_key AS ciphertext,key_version,credential_version AS version,generation,'byok' AS kind,status AS state FROM ai_settings WHERE user_id=? AND id=? AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')",
      )
      .bind(context.userId, target.id, context.userId)
      .first<StoredCredential>();
  }
  async function read(
    context: TenantContext,
    target: CredentialTarget,
    expectedVersion?: number,
  ): Promise<CredentialSnapshot | null> {
    const row = await stored(context, target);
    if (
      !row ||
      row.generation !== target.generation ||
      (expectedVersion !== undefined && row.version !== expectedVersion) ||
      !["connected", "active"].includes(row.state) ||
      row.ciphertext === null
    )
      return null;
    if (
      row.key_version === null ||
      row.key_version !== readEnvelopeVersion(row.ciphertext)
    )
      throw new CredentialError("SECRET_UNAVAILABLE");
    const secret = await cipher.open(
      context,
      { entityId: target.id, purpose: purpose(row, target) },
      row.ciphertext,
    );
    const latest = await stored(context, target);
    if (
      !latest ||
      latest.generation !== row.generation ||
      latest.version !== row.version ||
      latest.ciphertext !== row.ciphertext ||
      !["connected", "active"].includes(latest.state)
    )
      return null;
    if ("verifier" in secret) throw new CredentialError("SECRET_UNAVAILABLE");
    return {
      version: row.version,
      keyVersion: row.key_version,
      generation: row.generation,
      secret,
    };
  }
  async function write(
    context: TenantContext,
    target: CredentialTarget,
    expectedVersion: number,
    secret: ProviderCredentials | { key: string },
  ): Promise<boolean> {
    checkTarget(target);
    checkVersion(expectedVersion);
    const row = await stored(context, target);
    if (target.kind === "byok" && !row) {
      if (expectedVersion !== 0 || target.generation !== 1) return false;
      if (!("key" in secret)) throw new CredentialError("INVALID_SECRET");
      const envelope = await cipher.seal(
        context,
        { entityId: target.id, purpose: "byok-key" },
        secret,
      );
      const result = await db
        .prepare(
          "INSERT INTO ai_settings(user_id,id,encrypted_key,key_version,credential_version,generation) SELECT ?,?,?,?,1,1 WHERE EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active') ON CONFLICT(user_id) DO NOTHING",
        )
        .bind(
          context.userId,
          target.id,
          envelope,
          cipher.activeVersion,
          context.userId,
        )
        .run();
      return result.meta.changes === 1;
    }
    if (
      !row ||
      row.generation !== target.generation ||
      row.version !== expectedVersion ||
      (row.key_version !== null && row.key_version > cipher.activeVersion) ||
      !["connected", "active"].includes(row.state)
    )
      return false;
    let retainedSecret = secret;
    if (
      target.kind === "connection" &&
      row.ciphertext !== null &&
      !("key" in secret) &&
      secret.refreshToken === undefined
    ) {
      const previous = await read(context, target, expectedVersion);
      if (!previous || "key" in previous.secret) return false;
      if (previous.secret.refreshToken !== undefined)
        retainedSecret = {
          ...secret,
          refreshToken: previous.secret.refreshToken,
        };
    }
    const selectedPurpose = purpose(row, target);
    if (
      selectedPurpose === "byok-key"
        ? !("key" in retainedSecret)
        : "key" in retainedSecret
    )
      throw new CredentialError("INVALID_SECRET");
    const envelope = await cipher.seal(
      context,
      { entityId: target.id, purpose: selectedPurpose },
      retainedSecret as SecretPayloads[typeof selectedPurpose],
    );
    const sql =
      target.kind === "connection"
        ? "UPDATE connections SET credential_ciphertext=?,credential_key_version=?,credential_version=credential_version+1 WHERE user_id=? AND id=? AND generation=? AND credential_version=? AND state='connected' AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')"
        : "UPDATE ai_settings SET encrypted_key=?,key_version=?,credential_version=credential_version+1 WHERE user_id=? AND id=? AND generation=? AND credential_version=? AND status='active' AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')";
    return (
      (
        await db
          .prepare(sql)
          .bind(
            envelope,
            cipher.activeVersion,
            context.userId,
            target.id,
            target.generation,
            expectedVersion,
            context.userId,
          )
          .run()
      ).meta.changes === 1
    );
  }
  const operations = {
    read,
    save: write,
    async metadata(
      context: TenantContext,
      target: CredentialTarget,
    ): Promise<CredentialMetadata | null> {
      const row = await stored(context, target);
      if (!row) return null;
      return {
        configured:
          row.ciphertext !== null &&
          ["connected", "active"].includes(row.state),
        version: row.version,
        keyVersion: row.key_version,
        generation: row.generation,
      };
    },
    async refresh(
      context: TenantContext,
      target: CredentialTarget,
      expectedVersion: number,
      response: ProviderCredentials,
    ): Promise<boolean> {
      if (target.kind !== "connection")
        throw new CredentialError("INVALID_SECRET");
      checkVersion(expectedVersion);
      const current = await read(context, target, expectedVersion);
      if (!current || current.version !== expectedVersion) return false;
      if ("key" in current.secret) throw new CredentialError("INVALID_SECRET");
      const merged: ProviderCredentials = { ...current.secret };
      if (response.accessToken !== undefined)
        merged.accessToken = response.accessToken;
      if (response.refreshToken !== undefined)
        merged.refreshToken = response.refreshToken;
      if (response.expiresAt !== undefined)
        merged.expiresAt = response.expiresAt;
      return write(context, target, expectedVersion, merged);
    },
    async rotate(
      context: TenantContext,
      target: CredentialTarget,
      expectedVersion: number,
    ): Promise<boolean> {
      const current = await read(context, target, expectedVersion);
      if (!current || current.version !== expectedVersion) return false;
      return write(context, target, expectedVersion, current.secret);
    },
    async clear(
      context: TenantContext,
      target: CredentialTarget,
      expectedVersion: number,
    ): Promise<boolean> {
      checkTarget(target);
      checkVersion(expectedVersion);
      const sql =
        target.kind === "connection"
          ? "UPDATE connections SET credential_ciphertext=NULL,credential_key_version=NULL,credential_version=credential_version+1,generation=generation+1,state='disconnected',scheduling_state='paused' WHERE user_id=? AND id=? AND generation=? AND credential_version=? AND state='connected' AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')"
          : "UPDATE ai_settings SET encrypted_key=NULL,key_version=NULL,credential_version=credential_version+1,generation=generation+1,status='deleted' WHERE user_id=? AND id=? AND generation=? AND credential_version=? AND status='active' AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')";
      return (
        (
          await db
            .prepare(sql)
            .bind(
              context.userId,
              target.id,
              target.generation,
              expectedVersion,
              context.userId,
            )
            .run()
        ).meta.changes === 1
      );
    },
  };
  return {
    read: redactSecurityFailures(operations.read),
    save: redactSecurityFailures(operations.save),
    metadata: redactSecurityFailures(operations.metadata),
    refresh: redactSecurityFailures(operations.refresh),
    rotate: redactSecurityFailures(operations.rotate),
    clear: redactSecurityFailures(operations.clear),
  };
}
