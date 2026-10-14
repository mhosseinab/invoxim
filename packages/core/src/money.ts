import { MINOR_BOUND, minorDigits } from "@invoxim/contracts";

export const ENTRY_MINOR_BOUND = MINOR_BOUND;
export function parseMoney(
  amount: string | null,
  currency: string,
): bigint | null {
  const digits = minorDigits(currency);
  if (amount === null) return null;
  if (!/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,3})?$/.test(amount))
    throw new Error("INVALID_AMOUNT");
  const [whole, fraction = ""] = amount.split(".");
  if (whole === undefined) throw new Error("INVALID_AMOUNT");
  if (fraction.length > digits) throw new Error("EXCESS_MINOR_DIGITS");
  const minor =
    BigInt(whole) * 10n ** BigInt(digits) +
    BigInt(fraction.padEnd(digits, "0") || "0");
  if (minor > ENTRY_MINOR_BOUND) throw new Error("AMOUNT_OUT_OF_RANGE");
  return minor;
}
export function parseMinor(value: string, bounded = true): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 100)
    throw new Error("INVALID_AMOUNT");
  const minor = BigInt(value);
  if (bounded && minor > ENTRY_MINOR_BOUND)
    throw new Error("AMOUNT_OUT_OF_RANGE");
  return minor;
}
export function formatMinor(value: string | bigint, currency: string): string {
  const digits = minorDigits(currency);
  let minor: bigint;
  if (typeof value === "bigint") minor = value;
  else {
    const negative = value.startsWith("-");
    minor =
      parseMinor(negative ? value.slice(1) : value, false) *
      (negative ? -1n : 1n);
  }
  const sign = minor < 0n ? "-" : "";
  const magnitude = minor < 0n ? -minor : minor;
  const scale = 10n ** BigInt(digits);
  return (
    sign +
    (magnitude / scale).toString() +
    (digits ? `.${(magnitude % scale).toString().padStart(digits, "0")}` : "")
  );
}
