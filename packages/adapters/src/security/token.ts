import { decodeBase64url, encodeBase64url, signingKey } from "./helpers";

/**
 * One HMAC-SHA-256 token format for the three signing domains (S2).
 *
 * Every domain shares the one server secret and its own prefix so a token
 * minted for one purpose cannot substitute for another. `signs` keeps each
 * historical signed message byte-identical: the onboarding review domain
 * signs its decoded JSON payload, the fx period and workspace mutation
 * domains sign the encoded body (the workspace prefix is empty by format).
 */
export interface TokenDomain {
  readonly prefix: string;
  readonly signs: "body" | "payload";
}

function coveredText(
  domain: TokenDomain,
  body: string,
  payload: string,
): string {
  return domain.prefix + (domain.signs === "payload" ? payload : body);
}

/**
 * Sign `payload` as `body.signature`, both unpadded base64url. The body
 * carries the UTF-8 payload; the signature covers `prefix` plus the domain's
 * historical signed text.
 */
export async function signToken(
  domain: TokenDomain,
  payload: string,
  secret: string,
): Promise<string> {
  const body = encodeBase64url(new TextEncoder().encode(payload));
  const proof = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    new TextEncoder().encode(coveredText(domain, body, payload)),
  );
  return `${body}.${encodeBase64url(new Uint8Array(proof))}`;
}

/**
 * Verify `body.signature` and return the payload text, or null. Both parts
 * decode canonically (round-trip required); the signature must be 32 bytes.
 */
export async function verifyToken(
  domain: TokenDomain,
  token: string,
  secret: string,
): Promise<string | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [body, proof] = parts;
    const bodyBytes = decodeBase64url(body);
    const proofBytes = decodeBase64url(proof);
    if (proofBytes.length !== 32) return null;
    // Keep any BOM (ignoreBOM:true) so the decode is injective: stripping it
    // would let a BOM'd re-encoding of a payload-signed token re-verify.
    const payload = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bodyBytes);
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret),
      proofBytes,
      new TextEncoder().encode(coveredText(domain, body, payload)),
    );
    return valid ? payload : null;
  } catch {
    return null;
  }
}
