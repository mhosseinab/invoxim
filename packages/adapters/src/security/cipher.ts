import { hasControlCharacters } from "@invoxim/contracts";
import type { TenantContext } from "@invoxim/core";
import { decodeBase64url, encodeBase64url } from "./helpers";
import type {
  CipherBinding,
  CredentialCipher,
  Keyring,
  SecretPayloads,
  SecretPurpose,
} from "./types";
export { decodeBase64url, encodeBase64url };
export class CredentialError extends Error {
  constructor(
    readonly code:
      | "INVALID_SECRET"
      | "SECRET_UNAVAILABLE"
      | "INVALID_KEYRING"
      | "INVALID_OAUTH_STATE",
  ) {
    super(code);
    this.name = "CredentialError";
  }
}

export function readEnvelopeVersion(envelope: string): number {
  try {
    if (typeof envelope !== "string" || envelope.length > 40000)
      throw new CredentialError("SECRET_UNAVAILABLE");
    const value: unknown = JSON.parse(envelope);
    if (
      typeof value === "object" &&
      value !== null &&
      "keyVersion" in value &&
      typeof value.keyVersion === "number" &&
      Number.isSafeInteger(value.keyVersion) &&
      value.keyVersion > 0
    )
      return value.keyVersion;
  } catch {
    /* Return a stable error without ciphertext or parsed data. */
  }
  throw new CredentialError("SECRET_UNAVAILABLE");
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CredentialError("INVALID_SECRET");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    hasControlCharacters(value)
  )
    throw new CredentialError("INVALID_SECRET");
  return value;
}
function payload<P extends SecretPurpose>(
  purpose: P,
  value: unknown,
): SecretPayloads[P] {
  const input = record(value);
  let output: SecretPayloads[SecretPurpose];
  if (purpose === "byok-key") {
    if (Object.keys(input).some((k) => k !== "key"))
      throw new CredentialError("INVALID_SECRET");
    output = { key: text(input.key, 4096) };
  } else if (purpose === "oauth-pkce") {
    if (Object.keys(input).some((k) => k !== "verifier"))
      throw new CredentialError("INVALID_SECRET");
    const verifier = text(input.verifier, 128);
    if (verifier.length < 43 || !/^[A-Za-z0-9._~-]+$/.test(verifier))
      throw new CredentialError("INVALID_SECRET");
    output = { verifier };
  } else if (purpose === "archive-upload-session") {
    if (
      Object.keys(input).some(
        (field) => !["url", "fileId", "sha256"].includes(field),
      )
    )
      throw new CredentialError("INVALID_SECRET");
    const url = text(input.url, 4096);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new CredentialError("INVALID_SECRET");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    )
      throw new CredentialError("INVALID_SECRET");
    const fileId = text(input.fileId, 128);
    const sha256 = text(input.sha256, 64);
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(fileId) ||
      !/^[0-9a-f]{64}$/.test(sha256)
    )
      throw new CredentialError("INVALID_SECRET");
    output = { url, fileId, sha256 };
  } else if (
    purpose === "mailbox-credentials" ||
    purpose === "storage-credentials"
  ) {
    if (
      Object.keys(input).some(
        (k) => !["accessToken", "refreshToken", "expiresAt"].includes(k),
      )
    )
      throw new CredentialError("INVALID_SECRET");
    const credentials: SecretPayloads["mailbox-credentials"] = {};
    if (input.accessToken !== undefined)
      credentials.accessToken = text(input.accessToken, 8192);
    if (input.refreshToken !== undefined)
      credentials.refreshToken = text(input.refreshToken, 8192);
    if (input.expiresAt !== undefined) {
      if (
        typeof input.expiresAt !== "number" ||
        !Number.isSafeInteger(input.expiresAt) ||
        input.expiresAt < 0
      )
        throw new CredentialError("INVALID_SECRET");
      credentials.expiresAt = input.expiresAt;
    }
    if (!credentials.accessToken && !credentials.refreshToken)
      throw new CredentialError("INVALID_SECRET");
    output = credentials;
  } else throw new CredentialError("INVALID_SECRET");
  // The discriminant above validates and constructs only the selected purpose's fields.
  return output as SecretPayloads[P];
}
function aad(
  context: TenantContext,
  binding: CipherBinding,
  keyVersion: number,
): Uint8Array<ArrayBuffer> {
  text(context.userId, 256);
  text(binding.entityId, 256);
  return new Uint8Array(
    new TextEncoder().encode(
      JSON.stringify([
        1,
        context.userId,
        binding.entityId,
        binding.purpose,
        keyVersion,
      ]),
    ),
  );
}
export function createCredentialCipher(keyring: Keyring): CredentialCipher {
  const keys = new Map<number, Promise<CryptoKey>>();
  try {
    if (
      !Number.isSafeInteger(keyring.activeVersion) ||
      keyring.activeVersion < 1 ||
      Object.keys(keyring.keys).length > 8
    )
      throw new CredentialError("INVALID_KEYRING");
    for (const [version, encoded] of Object.entries(keyring.keys)) {
      const number = Number(version);
      const bytes = decodeBase64url(encoded);
      if (
        !Number.isSafeInteger(number) ||
        number < 1 ||
        String(number) !== version ||
        bytes.byteLength !== 32
      )
        throw new CredentialError("INVALID_KEYRING");
      keys.set(
        number,
        crypto.subtle.importKey(
          "raw",
          bytes,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    }
    if (!keys.has(keyring.activeVersion))
      throw new CredentialError("INVALID_KEYRING");
  } catch {
    throw new CredentialError("INVALID_KEYRING");
  }
  const activeVersion = keyring.activeVersion;
  return {
    activeVersion,
    async seal(context, binding, value) {
      const validated = payload(binding.purpose, value);
      const plaintext = new TextEncoder().encode(JSON.stringify(validated));
      if (plaintext.byteLength > 19984)
        throw new CredentialError("INVALID_SECRET");
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const activeKey = keys.get(activeVersion);
      if (!activeKey) throw new CredentialError("INVALID_KEYRING");
      const encrypted = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: aad(context, binding, activeVersion),
          tagLength: 128,
        },
        await activeKey,
        plaintext,
      );
      return JSON.stringify({
        schemaVersion: 1,
        keyVersion: activeVersion,
        nonce: encodeBase64url(iv),
        ciphertext: encodeBase64url(new Uint8Array(encrypted)),
      });
    },
    async open(context, binding, envelope) {
      try {
        if (typeof envelope !== "string" || envelope.length > 40000)
          throw new CredentialError("SECRET_UNAVAILABLE");
        const parsed = record(JSON.parse(envelope) as unknown);
        if (
          Object.keys(parsed).some(
            (k) =>
              !["schemaVersion", "keyVersion", "nonce", "ciphertext"].includes(
                k,
              ),
          ) ||
          parsed.schemaVersion !== 1 ||
          typeof parsed.keyVersion !== "number" ||
          !Number.isSafeInteger(parsed.keyVersion)
        )
          throw new CredentialError("SECRET_UNAVAILABLE");
        const key = keys.get(parsed.keyVersion);
        if (!key) throw new CredentialError("SECRET_UNAVAILABLE");
        const iv = decodeBase64url(parsed.nonce);
        const ciphertext = decodeBase64url(parsed.ciphertext);
        if (
          iv.byteLength !== 12 ||
          ciphertext.byteLength < 16 ||
          ciphertext.byteLength > 20000
        )
          throw new CredentialError("SECRET_UNAVAILABLE");
        const decoded = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: aad(context, binding, parsed.keyVersion),
            tagLength: 128,
          },
          await key,
          ciphertext,
        );
        return payload(
          binding.purpose,
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
              decoded,
            ),
          ) as unknown,
        );
      } catch {
        throw new CredentialError("SECRET_UNAVAILABLE");
      }
    },
  };
}
