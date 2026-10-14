import { expect, it } from "vitest";
import { encodeBase64url } from "../../../packages/adapters/src/security/helpers";
import {
  signToken,
  verifyToken,
  type TokenDomain,
} from "../../../packages/adapters/src/security/token";

const secret = "synthetic-token-module-secret-000000";
const bodyDomain: TokenDomain = { prefix: "test.body.v1:", signs: "body" };
const payloadDomain: TokenDomain = {
  prefix: "test.payload.v1:",
  signs: "payload",
};

function b64u(text: string) {
  return encodeBase64url(new TextEncoder().encode(text));
}

it("signToken emits body.signature and verifyToken round-trips the payload", async () => {
  const token = await signToken(bodyDomain, '{"a":1}', secret);
  expect(token).toBe(`${b64u('{"a":1}')}.${token.split(".")[1]}`);
  expect(token.split(".")).toHaveLength(2);
  expect(await verifyToken(bodyDomain, token, secret)).toBe('{"a":1}');
});

it("the signed message follows the domain's format (S2)", async () => {
  // body-mode covers the encoded body; payload-mode covers the decoded text.
  // The two modes must stay distinct so each historical wire format keeps its
  // exact signature bytes.
  const asBody = await signToken(bodyDomain, "{}", secret);
  const asPayload = await signToken(payloadDomain, "{}", secret);
  expect(asBody.split(".")[0]).toBe(asPayload.split(".")[0]);
  expect(asBody.split(".")[1]).not.toBe(asPayload.split(".")[1]);
  expect(await verifyToken(bodyDomain, asBody, secret)).toBe("{}");
  expect(await verifyToken(payloadDomain, asPayload, secret)).toBe("{}");
});

it("tokens are bound to their domain prefix and secret", async () => {
  const token = await signToken(bodyDomain, "{}", secret);
  const otherDomain: TokenDomain = {
    prefix: "test.other.v1:",
    signs: "body",
  };
  expect(await verifyToken(otherDomain, token, secret)).toBe(null);
  expect(await verifyToken(bodyDomain, token, "other-secret")).toBe(null);
});

it("decode is canonical: a non-canonical body is rejected", async () => {
  // "e31" and "e30" both atob-decode to "{}"; only "e30" re-encodes
  // canonically. A lenient decoder would accept the hand-signed "e31" token.
  async function signedOverBody(body: string) {
    const proof = await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      new TextEncoder().encode(bodyDomain.prefix + body),
    );
    return `${body}.${encodeBase64url(new Uint8Array(proof))}`;
  }
  expect(await verifyToken(bodyDomain, await signedOverBody("e30"), secret)).toBe(
    "{}",
  );
  expect(await verifyToken(bodyDomain, await signedOverBody("e31"), secret)).toBe(
    null,
  );
});

it("rejects malformed shapes and non-32-byte signatures", async () => {
  const token = await signToken(bodyDomain, "{}", secret);
  const [body, signature] = token.split(".");
  expect(await verifyToken(bodyDomain, body!, secret)).toBe(null);
  expect(await verifyToken(bodyDomain, `${body}.${signature}.x`, secret)).toBe(
    null,
  );
  expect(await verifyToken(bodyDomain, `.${signature}`, secret)).toBe(null);
  const shortSig = signature!.slice(0, -4);
  expect(await verifyToken(bodyDomain, `${body}.${shortSig}`, secret)).toBe(
    null,
  );
});
