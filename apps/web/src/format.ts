import { formatMinor } from "@invoxim/core";

/**
 * Display money as `CUR12.34`. Unknown currencies fall back to raw minor units
 * so a corrupt amount never blanks the row.
 */
export function amount(minor: string, currency: string): string {
  try {
    return `${currency} ${formatMinor(minor, currency)}`;
  } catch {
    return `${currency} ${minor} minor units`;
  }
}

/** Decimal string for editable money inputs (`12.34`), no currency prefix. */
export function amountInput(minor: string, currency: string): string {
  return formatMinor(minor, currency);
}

/** Calendar date from a `YYYY-MM-DD` value, shown in UTC (`12 Oct 2025`). */
export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

/**
 * Instant or day-range endpoint as `11 Oct 2025, 22:00`. Defaults to UTC;
 * pass a IANA zone to render in that zone. Unparseable values say so.
 */
export function formatDateTime(value: string, timeZone = "UTC"): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
      }).format(date);
}

/** Instant in the viewer's own locale and timezone (`11 Oct 2025, 22:00`). */
export function formatLocalDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Short calendar day in the viewer's own locale (`12 Oct 2025`). */
export function formatLocalDate(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
