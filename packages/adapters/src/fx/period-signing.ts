import { signToken, type TokenDomain, verifyToken } from "../security/token";
import type { FxPeriodSigning } from "./period";

/** Historical fx period domain: signs the encoded body (S2). */
const fxDomain: TokenDomain = {
  prefix: "invoxim.fx.period.v1:",
  signs: "body",
};
const MAX_PAYLOAD_BYTES = 12200;
const MAX_TOKEN_LENGTH = 16384;
/** Same existing server auth secret; a separate signature domain prevents token substitution. */
export function createFxPeriodSigning(secret: string): FxPeriodSigning {
  return {
    async sign(payload) {
      const bytes = new TextEncoder().encode(payload);
      if (bytes.length > MAX_PAYLOAD_BYTES) throw new Error("INVALID_FX_INPUT");
      return signToken(fxDomain, payload, secret);
    },
    async verify(token) {
      if (token.length > MAX_TOKEN_LENGTH) return null;
      const payload = await verifyToken(fxDomain, token, secret);
      if (payload === null) return null;
      return new TextEncoder().encode(payload).length > MAX_PAYLOAD_BYTES
        ? null
        : payload;
    },
  };
}
