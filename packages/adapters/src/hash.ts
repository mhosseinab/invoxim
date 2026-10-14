/**
 * One SHA-256 hex encoder and one discovery source key for the adapters
 * package (SW-1, C13, S6, G10, ext#15). Every prior inline `digest`/`hash`/
 * `fingerprint` twin collapses onto these names so stored fingerprints stay
 * byte-identical.
 */

/** SHA-256 lowercase hex of UTF-8 text or raw bytes. */
export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const data =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** SHA-256 hex of `JSON.stringify(value)`. Collapses hashOnboardingValue ≡ hashAiValue (S6). */
export async function hashJsonValue(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(value));
}

/**
 * Discovery source dedupe key (G10): `source:<sha256 of
 * [userId, connectionId, messageId]>:<generation>`.
 */
export async function sourceKey(
  userId: string,
  connectionId: string,
  messageId: string,
  generation: number,
): Promise<string> {
  return `source:${await hashJsonValue([
    userId,
    connectionId,
    messageId,
  ])}:${generation}`;
}
