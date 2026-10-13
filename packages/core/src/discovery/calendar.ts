import { validCalendarDate, validTimezone } from "@invoxim/contracts";
import type { DiscoveryPlan, DiscoveryRange } from "./types";
import { DiscoveryError } from "./types";

function formatter(timezone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}
function wallTime(value: number, format: Intl.DateTimeFormat) {
  const parts = Object.fromEntries(
    format
      .formatToParts(new Date(value))
      .map((part) => [part.type, part.value]),
  );
  return (
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    ) + new Date(value).getUTCMilliseconds()
  );
}
/** Compatible calendar disambiguation: earlier repeated time, later skipped time. */
function instant(wall: number, format: Intl.DateTimeFormat) {
  const offsets = new Set(
    [-172800000, 0, 172800000].map(
      (delta) => wallTime(wall + delta, format) - (wall + delta),
    ),
  );
  const candidates = [...offsets]
    .map((offset) => wall - offset)
    .sort((a, b) => a - b);
  const exact = candidates.find((value) => wallTime(value, format) === wall);
  if (exact !== undefined) return exact;
  const later = candidates
    .filter((value) => wallTime(value, format) > wall)
    .sort((a, b) => wallTime(a, format) - wallTime(b, format))[0];
  if (later === undefined) throw new DiscoveryError("INVALID_RANGE");
  return later;
}
export function planDiscoveryRange(input: {
  cutoffMs: number;
  startMs?: number;
  timezone: string;
}): DiscoveryPlan {
  try {
    if (
      !validTimezone(input.timezone) ||
      !Number.isSafeInteger(input.cutoffMs) ||
      input.cutoffMs < 0 ||
      input.cutoffMs > Date.parse("2100-01-01T00:00:00Z")
    )
      throw new DiscoveryError("INVALID_RANGE");
    const format = formatter(input.timezone);
    const cutoffWall = new Date(wallTime(input.cutoffMs, format));
    const year = cutoffWall.getUTCFullYear() - 1;
    const month = cutoffWall.getUTCMonth();
    const day = Math.min(
      cutoffWall.getUTCDate(),
      new Date(Date.UTC(year, month + 1, 0)).getUTCDate(),
    );
    const defaultStart = instant(
      Date.UTC(
        year,
        month,
        day,
        cutoffWall.getUTCHours(),
        cutoffWall.getUTCMinutes(),
        cutoffWall.getUTCSeconds(),
        cutoffWall.getUTCMilliseconds(),
      ),
      format,
    );
    const startMs = input.startMs ?? defaultStart;
    if (
      !Number.isSafeInteger(startMs) ||
      startMs < 0 ||
      startMs >= input.cutoffMs
    )
      throw new DiscoveryError("INVALID_RANGE");
    const recentWall = new Date(cutoffWall);
    recentWall.setUTCDate(recentWall.getUTCDate() - 30);
    const recentStart = Math.max(
      startMs,
      instant(recentWall.getTime(), format),
    );
    const range: DiscoveryRange = {
      startMs,
      cutoffMs: input.cutoffMs,
      timezone: input.timezone,
    };
    return {
      range,
      recent: { ...range, startMs: recentStart },
      older:
        recentStart === startMs ? null : { ...range, cutoffMs: recentStart },
    };
  } catch (cause) {
    if (cause instanceof DiscoveryError) throw cause;
    throw new DiscoveryError("INVALID_RANGE");
  }
}

/** Date-only boundaries use the same calendar disambiguation as discovery slices. */
export function calendarBoundary(date: string, timezone: string): number {
  if (
    !validCalendarDate(date) ||
    date < "1970-01-01" ||
    date > "2100-01-01" ||
    !validTimezone(timezone)
  )
    throw new DiscoveryError("INVALID_RANGE");
  const wall = Date.parse(`${date}T00:00:00Z`);
  return instant(wall, formatter(timezone));
}
