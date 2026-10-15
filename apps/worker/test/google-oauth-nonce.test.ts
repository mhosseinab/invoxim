import { expect, it } from "vitest";
import { createGoogleOAuthClient } from "../../../packages/adapters/src/mailbox/google-oauth";
import {
  generateSigningKeys,
  googleIdTokenClaims,
  signIdToken,
} from "../../../packages/testkit/src/google-token";

class SyntheticOAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const clientId = "synthetic-google-nonce-client";

let pair: CryptoKeyPair | undefined;
async function signed(
  nonce: string | undefined,
  extra: Record<string, unknown> = {},
) {
  pair ??= (await generateSigningKeys()).keys;
  return signIdToken({
    claims: googleIdTokenClaims({
      aud: clientId,
      sub: "synthetic-nonce-subject",
      email: "nonce-subject@example.invalid",
      ...(nonce === undefined ? {} : { nonce }),
      ...extra,
    }),
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    kid: "synthetic-nonce-kid",
  });
}
function client(jwks: unknown) {
  return createGoogleOAuthClient({
    clientId,
    clientSecret: "synthetic-google-nonce-secret",
    scopes: ["openid", "email"],
    json: async () => jwks,
    fail: (code) => new SyntheticOAuthError(code),
    owns: (error) => error instanceof SyntheticOAuthError,
  });
}

it.each([
  ["token carries another nonce", "attacker-chosen-nonce"],
  ["token carries no nonce", undefined],
])(
  "D2 authorization-code verification with expected nonce '' is rejected (%s)",
  async (_label, tokenNonce) => {
    const token = await signed(tokenNonce);
    await expect(
      client(token.jwks).verifyIdToken(token.jwt, ""),
    ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  },
);

it("D2 authorization-code verification rejects a token without the expected nonce claim", async () => {
  const token = await signed(undefined);
  await expect(
    client(token.jwks).verifyIdToken(token.jwt, "synthetic-bound-nonce"),
  ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
});

it("D2 the bound nonce verifies, and refresh verification (null) keeps every other claim check", async () => {
  const token = await signed("synthetic-bound-nonce");
  await expect(
    client(token.jwks).verifyIdToken(token.jwt, "synthetic-bound-nonce"),
  ).resolves.toMatchObject({ sub: "synthetic-nonce-subject" });
  const refreshed = await signed(undefined);
  await expect(
    client(refreshed.jwks).verifyIdToken(refreshed.jwt, null),
  ).resolves.toMatchObject({ sub: "synthetic-nonce-subject" });
  const foreign = await signed(undefined, { aud: "another-client" });
  await expect(
    client(refreshed.jwks).verifyIdToken(foreign.jwt, null),
  ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
});
