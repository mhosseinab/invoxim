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
export function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    year > 0 &&
    month > 0 &&
    month <= 12 &&
    day > 0 &&
    day <=
      ([31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
        month - 1
      ] ?? 0)
  );
}
export function calendarDate(value: string): string {
  if (!validCalendarDate(value)) throw new Error("INVALID_DATE");
  return value;
}
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
