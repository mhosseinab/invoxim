import type { FxPeriodSigning } from "./period";

const domain = "invoxim.fx.period.v1:";
function encode(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("INVALID_FX_INPUT");
  const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++)
    bytes[index] = raw.charCodeAt(index);
  if (encode(bytes) !== value) throw new Error("INVALID_FX_INPUT");
  return bytes;
}
/** Same existing server auth secret; a separate signature domain prevents token substitution. */
export function createFxPeriodSigning(secret: string): FxPeriodSigning {
  const key = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return {
    async sign(payload) {
      const bytes = new TextEncoder().encode(payload);
      if (bytes.length > 12200) throw new Error("INVALID_FX_INPUT");
      const body = encode(bytes);
      const signature = await crypto.subtle.sign(
        "HMAC",
        await key,
        new TextEncoder().encode(domain + body),
      );
      return `${body}.${encode(new Uint8Array(signature))}`;
    },
    async verify(token) {
      try {
        if (token.length > 16384) return null;
        const parts = token.split(".");
        if (parts.length !== 2) return null;
        const [body, signature] = parts;
        if (!body || !signature) return null;
        const bytes = decode(body),
          proof = decode(signature);
        if (bytes.length > 12200 || proof.length !== 32) return null;
        if (
          !(await crypto.subtle.verify(
            "HMAC",
            await key,
            proof,
            new TextEncoder().encode(domain + body),
          ))
        )
          return null;
        return new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(bytes);
      } catch {
        return null;
      }
    },
  };
}
