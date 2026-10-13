import { calendarDate } from "@invoxim/contracts";

function daysInMonth(year: number, month: number): number {
  return (
    [
      31,
      year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ][month - 1] ?? 0
  );
}
export function monthlyAnchor(month: string, day: number): string {
  if (
    !/^\d{4}-\d{2}$/.test(month) ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31
  )
    throw new Error("INVALID_DATE");
  calendarDate(`${month}-01`);
  const [year = 0, m = 0] = month.split("-").map(Number);
  return (
    month +
    "-" +
    Math.min(day, daysInMonth(year, m)).toString().padStart(2, "0")
  );
}
