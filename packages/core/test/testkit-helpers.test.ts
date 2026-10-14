import { expect, it } from "vitest";
import {
  createRoutedFetch,
  requestMethod,
  requestUrl,
  urlRoute,
} from "../../testkit/src/fetch-spy";
import { requireFixture } from "../../testkit/src/fixture-value";
import {
  generateSigningKeys,
  googleIdTokenClaims,
  googleTokenResponse,
  signIdToken,
} from "../../testkit/src/google-token";

it("requireFixture returns the value or fails fast", () => {
  expect(requireFixture("synthetic")).toBe("synthetic");
  expect(() => requireFixture(null)).toThrow(
    "Required synthetic fixture value is unavailable",
  );
  expect(() => requireFixture(undefined)).toThrow(
    "Required synthetic fixture value is unavailable",
  );
});

it("googleTokenResponse shares the synthetic token body shape", () => {
  expect(googleTokenResponse({ access_token: "synthetic-fresh" })).toEqual({
    access_token: "synthetic-fresh",
    expires_in: 3600,
    token_type: "Bearer",
  });
});

it("signIdToken produces a verifiable Google-shaped id-token", async () => {
  const { keys } = await generateSigningKeys();
  const claims = googleIdTokenClaims({
    sub: "synthetic-helper-subject",
    aud: "synthetic-helper-client",
    nonce: "synthetic-helper-nonce",
  });
  const signed = await signIdToken({
    claims,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    kid: "synthetic-helper-key",
  });
  expect(signed.jwt.split(".")).toHaveLength(3);
  expect(signed.jwks?.keys).toHaveLength(1);
  expect(claims).toMatchObject({
    iss: "https://accounts.google.com",
    email_verified: true,
    sub: "synthetic-helper-subject",
  });
  const [headerPart, payloadPart] = signed.jwt.split(".");
  const decode = (value: string) => {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))) as Record<
      string,
      unknown
    >;
  };
  expect(decode(headerPart ?? "")).toMatchObject({
    alg: "RS256",
    kid: "synthetic-helper-key",
    typ: "JWT",
  });
  expect(decode(payloadPart ?? "")).toMatchObject(claims);
});

it("createRoutedFetch routes by URL and rejects unexpected destinations", async () => {
  const calls: string[] = [];
  const handler = createRoutedFetch(
    [
      urlRoute("https://example.test/ok", () => Response.json({ ok: true }), "GET"),
    ],
    { calls },
  );
  const matched = await handler("https://example.test/ok");
  expect(await matched.json()).toEqual({ ok: true });
  expect(calls).toEqual(["https://example.test/ok"]);
  expect(requestUrl("https://example.test/ok")).toBe("https://example.test/ok");
  expect(requestMethod("https://example.test/ok")).toBe("GET");
  await expect(handler("https://example.test/missing")).rejects.toThrow(
    "Unexpected synthetic fetch destination",
  );
});
