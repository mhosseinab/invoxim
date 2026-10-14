/**
 * One SHA-256 hex encoder for the core package (SW-1, ext#15). Collapses
 * extractor/archive/engine digest twins so stored contentHash and run-identity
 * digests stay byte-identical.
 */
export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const data =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
