import { expect, it } from "vitest";
import {
  allowedEmailSet,
  isAllowedEmail,
} from "../../../packages/adapters/src/auth/configuration";
import { decodeBase64url } from "../../../packages/adapters/src/security/cipher";
import {
  abortable,
  decodeCursorValue,
  encodeBase64url,
  encodeCursorValue,
  noticeText,
  pkceVerifier,
  safe,
  sha256Hex,
  signingKey,
  stateHash,
} from "../../../packages/adapters/src/security/helpers";

it("stateHash is the SHA-256 hex digest of the state string", async () => {
  expect(await stateHash("")).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  expect(await stateHash("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

it("pkceVerifier is 64 random bytes as unpadded base64url", () => {
  const first = pkceVerifier();
  const second = pkceVerifier();
  expect(first).toMatch(/^[A-Za-z0-9_-]{86}$/);
  expect(second).toMatch(/^[A-Za-z0-9_-]{86}$/);
  expect(first).not.toBe(second);
});

it("decodeBase64url round-trips and rejects malformed input", () => {
  const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);
  const encoded = encodeBase64url(bytes);
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  expect([...decodeBase64url(encoded)]).toEqual([...bytes]);
  expect(() => decodeBase64url("has+padding")).toThrow();
  expect(() => decodeBase64url("")).toThrow();
  expect(() => decodeBase64url("!!!!")).toThrow();
  expect(() => decodeBase64url(42)).toThrow();
});

it("sha256Hex covers string and byte inputs with one name", async () => {
  expect(await sha256Hex("abc")).toBe(await stateHash("abc"));
  expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
    await stateHash("abc"),
  );
});

it("signingKey is the collapsed HMAC import used by token domains", async () => {
  const key = await signingKey("a".repeat(32));
  expect(key.type).toBe("secret");
  expect((key.algorithm as { name: string }).name).toBe("HMAC");
});

it("noticeText is the single policy-text schema (not policyText)", () => {
  const schema = noticeText(12);
  expect(schema.safeParse("hello").success).toBe(true);
  expect(schema.safeParse("").success).toBe(false);
  expect(schema.safeParse("   ").success).toBe(false);
  expect(schema.safeParse("x".repeat(13)).success).toBe(false);
  expect(schema.safeParse("bad\u0000").success).toBe(false);
});

it("safe rethrows kept errors and wraps the rest", async () => {
  class Known extends Error {}
  class Wrapped extends Error {}
  const kept = new Known("kept");
  await expect(
    safe(
      async () => {
        throw kept;
      },
      () => new Wrapped("wrapped"),
      (cause) => cause instanceof Known,
    ),
  ).rejects.toBe(kept);
  await expect(
    safe(
      async () => {
        throw new Error("opaque");
      },
      () => new Wrapped("wrapped"),
      (cause) => cause instanceof Known,
    ),
  ).rejects.toMatchObject({ message: "wrapped" });
  await expect(safe(async () => 7, () => new Wrapped("w"), () => false)).resolves.toBe(
    7,
  );
});

it("abortable races the promise against the signal", async () => {
  class Timeout extends Error {}
  await expect(
    abortable(Promise.resolve(1), new AbortController().signal, () => new Timeout("timeout")),
  ).resolves.toBe(1);
  const controller = new AbortController();
  const pending = abortable(
    new Promise(() => {}),
    controller.signal,
    () => new Timeout("timeout"),
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ message: "timeout" });
});

it("cursor encode/decode round-trips JSON values", () => {
  const value = { date: "2026-10-14", id: "p1" };
  const cursor = encodeCursorValue(value);
  expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeCursorValue(cursor)).toEqual(value);
  expect(() => decodeCursorValue("!!!")).toThrow();
});

it("isAllowedEmail is the single allowed-email rule", () => {
  const allowed = allowedEmailSet(["Login@Example.Invalid", "b@x.test"]);
  expect(allowed).toEqual(new Set(["login@example.invalid", "b@x.test"]));
  expect(isAllowedEmail("login@example.invalid", allowed)).toBe(true);
  expect(isAllowedEmail("LOGIN@EXAMPLE.INVALID", allowed)).toBe(true);
  expect(isAllowedEmail("other@example.invalid", allowed)).toBe(false);
  expect(isAllowedEmail(undefined, allowed)).toBe(false);
  expect(isAllowedEmail(42, allowed)).toBe(false);
});
