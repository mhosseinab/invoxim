import { z } from "zod";

/** Reviewed SIX subset, published 2026-09-17; unsupported codes fail closed. */
export const currencyMinorDigits = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  CHF: 2,
  JPY: 0,
  KWD: 3,
} as const;
export function minorDigits(currency: string): number {
  if (!Object.hasOwn(currencyMinorDigits, currency))
    throw new Error("UNSUPPORTED_CURRENCY");
  return currencyMinorDigits[currency as keyof typeof currencyMinorDigits];
}
/** Maximum absolute minor-unit amount accepted in money fields. */
export const MINOR_BOUND = 9_000_000_000_000n;
/**
 * One supported-currency schema: only registry codes pass.
 * Replaces the four variants that disagreed (ext#4).
 */
export const supportedCurrency = z.enum(
  Object.keys(currencyMinorDigits) as [string, ...string[]],
);
/**
 * ISO-style 3-letter code that MAY be outside the reviewed registry.
 * Domain inputs use this so they can report `currency_unsupported`
 * instead of failing parse (fx/recurring tests use XYZ).
 */
export const currencyCode = z.string().regex(/^[A-Z]{3}$/);
/**
 * FX rate decimal string: up to 13 integer digits and up to 18 fraction
 * digits, matching `core/money-conversion.ts`. Previously contracts allowed
 * only 12 integer digits (ext#5).
 */
export const fxRateDecimal = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,12})(?:\.[0-9]{1,18})?$/)
  .pipe(z.string().refine((value) => BigInt(value.replace(".", "")) > 0n));
/** Gregorian leap rule shared with `core/calendar-anchor`. */
export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** One month-length table for calendar validation and monthly anchors. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return MONTH_DAYS[month - 1] ?? 0;
}
export function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
  return year > 0 && month > 0 && month <= 12 && day > 0 && day <= daysInMonth(year, month);
}
export function calendarDate(value: string): string {
  if (!validCalendarDate(value)) throw new Error("INVALID_DATE");
  return value;
}

/** ISO calendar-date string. Replaces the 5 copy-pasted refinements. */
export const dateSchema = z.string().refine(validCalendarDate);
/**
 * Optimistic-concurrency generation / revision counter.
 * Replaces the 5 copy-pasted `min(1).max(MAX_SAFE_INTEGER)` schemas.
 */
export const generationSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);
/** Owned connection identifier. Replaces the 3 copy-pasted schemas. */
export const connectionIdSchema = z.string().min(1).max(120);

/**
 * Versioned credential keyring: active key encrypts; older keys decrypt.
 * Replaces the 4 copy-pasted schemas in adapters (drive, mailbox, outlook, ai).
 */
export const keyringSchema = z.strictObject({
  activeVersion: z.number().int().positive().max(2147483647),
  keys: z.record(z.string().regex(/^[1-9][0-9]*$/), z.string().min(1).max(100)),
});

const oauthTokenText = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);
/** OAuth token-endpoint response. Replaces the 2 copy-pasted provider schemas. */
export const oauthTokenResponseSchema = z.object({
  access_token: oauthTokenText,
  refresh_token: oauthTokenText.optional(),
  expires_in: z.number().int().min(1).max(86400),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  scope: z.string().max(4096).optional(),
  id_token: z.string().min(1).max(16384).optional(),
});

/** Shared mailbox/storage connection-start request shape. */
export const connectionStartRequestSchema = z.strictObject({
  connectionId: connectionIdSchema.optional(),
});
/** Shared mailbox/storage connection-start response shape. */
export const connectionStartResponseSchema = z.strictObject({
  authorizationUrl: z.url().max(4096),
});
export function validTimezone(value: string): boolean {
  if (value.length === 0 || value.length > 80 || /^[+-]/.test(value))
    return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** ASCII controls and DEL are forbidden in opaque identifiers/secret fields. */
export function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
