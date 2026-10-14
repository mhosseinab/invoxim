import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDriveAuthorization } from "../../../packages/adapters/src/drive/authorization";
import { DRIVE_AUTHORIZATION_SCOPES } from "../../../packages/adapters/src/drive/configuration";
import { createGmailAuthorization } from "../../../packages/adapters/src/mailbox/gmail";
import {
  GOOGLE_JWKS_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
  generateSigningKeys,
  googleIdTokenClaims,
  googleTokenResponse,
  signIdToken,
} from "../../../packages/testkit/src/google-token";

/**
 * INT-2 / D2: Gmail mailbox and Drive storage authorization both verify a
 * Google ID token for the same Google identity. They must accept and reject
 * exactly the same tokens; a token one verifier accepts and the other rejects
 * is a security divergence.
 */
const clientId = "synthetic-parity.apps.googleusercontent.com";
const nonce = "synthetic-parity-nonce-0123456789";
const sub = "synthetic-parity-subject";
const email = "parity-owner@example.invalid";
const callback =
  "https://synthetic.example/api/oauth/storage/google-drive/callback";
const mailScopes =
  "openid email profile https://www.googleapis.com/auth/gmail.readonly";
let keys: CryptoKeyPair;
beforeAll(async () => {
  keys = (await generateSigningKeys()).keys;
});
afterEach(() => vi.restoreAllMocks());

interface Fixture {
  claims?: Record<string, unknown>;
  duplicateKey?: boolean;
  keysUnavailable?: boolean;
}
async function mockGoogle(scope: string, fixture: Fixture) {
  const claims = googleIdTokenClaims({
    aud: clientId,
    sub,
    email,
    nonce,
    ...fixture.claims,
  });
  const signed = await signIdToken({
    claims,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    kid: "synthetic-parity-key",
  });
  const key = signed.jwks?.keys[0];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === GOOGLE_TOKEN_ENDPOINT)
      return Response.json(
        googleTokenResponse({
          refresh_token: "synthetic-parity-refresh",
          scope,
          id_token: signed.jwt,
        }),
      );
    if (url === GOOGLE_JWKS_ENDPOINT && fixture.keysUnavailable)
      return Response.json({ error: "synthetic-outage" }, { status: 503 });
    if (url === GOOGLE_JWKS_ENDPOINT)
      return Response.json({
        keys: fixture.duplicateKey ? [key, key] : [key],
      });
    if (url === GOOGLE_USERINFO_ENDPOINT)
      return Response.json({
        sub: claims.sub,
        email,
        email_verified: true,
      });
    throw new Error("Synthetic transport rejected unexpected destination");
  });
}
const verifiers = {
  gmail: async (fixture: Fixture) => {
    await mockGoogle(mailScopes, fixture);
    return createGmailAuthorization({
      clientId,
      clientSecret: "synthetic-parity-secret",
    }).exchange({
      code: "synthetic-parity-code",
      verifier: "v".repeat(43),
      nonce,
      callback,
    });
  },
  drive: async (fixture: Fixture) => {
    await mockGoogle(DRIVE_AUTHORIZATION_SCOPES.join(" "), fixture);
    return createDriveAuthorization({
      clientId,
      clientSecret: "synthetic-parity-secret",
      callback,
    }).exchange({
      code: "synthetic-parity-code",
      verifier: "v".repeat(43),
      nonce,
      callback,
    });
  },
};
const now = () => Math.floor(Date.now() / 1000);

describe("INT-2 D2 one Google ID-token verifier for mailbox and Drive", () => {
  it.each(["gmail", "drive"] as const)(
    "%s accepts the same well-formed signed identity",
    async (name) => {
      await expect(verifiers[name]({})).resolves.toMatchObject({
        identity: { subject: sub, address: email },
      });
    },
  );
  it.each([
    ["foreign authorized party", { claims: { azp: "other.apps.example" } }],
    ["multi-audience token", { claims: { aud: [clientId, "other-client"] } }],
    ["issued in the future", { claims: { iat: now() + 3600 } }],
    ["expiry before issue", { claims: { iat: now(), exp: now() - 1 } }],
    ["non-printable subject", { claims: { sub: "synthetic parity\tsubject" } }],
    ["ambiguous duplicate key id", { duplicateKey: true }],
    ["missing issued-at", { claims: { iat: undefined } }],
  ] as const)("%s is rejected by both verifiers", async (_name, fixture) => {
    const outcomes: Record<string, string> = {};
    for (const name of ["gmail", "drive"] as const) {
      try {
        await verifiers[name](fixture);
        outcomes[name] = "accepted";
      } catch (error) {
        outcomes[name] = (error as { code?: string }).code ?? "thrown";
      }
      vi.restoreAllMocks();
    }
    expect(outcomes).toEqual({
      gmail: "ACCOUNT_MISMATCH",
      drive: "ACCOUNT_MISMATCH",
    });
  });
  it.each(["gmail", "drive"] as const)(
    "%s reports an unavailable key set as a transient failure, not a mismatch",
    async (name) => {
      await expect(
        verifiers[name]({ keysUnavailable: true }),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    },
  );
});
