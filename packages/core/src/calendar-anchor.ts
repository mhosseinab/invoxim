import { calendarDate, daysInMonth } from "@invoxim/contracts";

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
