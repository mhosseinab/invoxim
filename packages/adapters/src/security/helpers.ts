import { hasControlCharacters } from "@invoxim/contracts";
import { z } from "zod";

/**
 * Shared security primitives (D12, S7, S8, D13). Later cards migrate
 * drive/mailbox/ai/corrections call sites onto these; this module is the
 * single definition so the same-body twins (`key`/`signingKey`,
 * `digest`/`hash`, `noticeText`/`policyText`) collapse onto one name each.
 */

/** Unpadded base64url (S7). The strict decode below is the only decoder. */
export function encodeBase64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Strict base64url decode: canonical round-trip required, no padding. */
export function decodeBase64url(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 40000 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw new Error("decode");
  let decoded: string;
  try {
    decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new Error("decode");
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (encodeBase64url(bytes) !== value) throw new Error("decode");
  return bytes;
}

/** SHA-256 lowercase hex of UTF-8 text or raw bytes. Collapses `digest`/`hash`. */
export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** OAuth state digest (D12). Same output as the former per-module stateHash. */
export function stateHash(state: string): Promise<string> {
  return sha256Hex(state);
}

/** RFC 7636 verifier: 64 random bytes as unpadded base64url (D12, S3). */
export function pkceVerifier(): string {
  return encodeBase64url(crypto.getRandomValues(new Uint8Array(64)));
}

/** HMAC-SHA-256 import. Collapses `key`/`signingKey`. */
export function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Bounded non-empty policy/notice text. Collapses `noticeText`/`policyText`. */
export function noticeText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0 && !hasControlCharacters(value));
}

/**
 * Error boundary: rethrow errors the caller already owns, wrap the rest.
 * The `safe()` twins differ only in the wrap/keep pair.
 */
export async function safe<T>(
  operation: () => Promise<T>,
  wrap: (cause: unknown) => Error,
  keep: (cause: unknown) => boolean,
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (keep(cause)) throw cause;
    throw wrap(cause);
  }
}

/** Race `promise` against `signal`; `timeout` builds the abort error. */
export async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeout: () => Error,
): Promise<T> {
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(timeout());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([promise, stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Opaque pagination cursor as base64url JSON. */
export function encodeCursorValue(value: unknown): string {
  return encodeBase64url(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeCursorValue(value: string): unknown {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      decodeBase64url(value),
    ),
  );
}
