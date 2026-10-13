import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  annualEstimate,
  calendarDate,
  convertMinor,
  formatMinor,
  historicalRateDate,
  ledgerTotals,
  monthlyAnchor,
  parseMoney,
  priceChange,
  timestampDate,
} from "../src/index";
import { requireFixture } from "./fixture-value";

describe("MONEY-01..07 exact domain arithmetic", () => {
  it("MONEY-01 decimal 0.10 + 0.20 is exactly 30; null is unknown", () => {
    expect(
      requireFixture(parseMoney("0.10", "EUR")) +
        requireFixture(parseMoney("0.20", "EUR")),
    ).toBe(30n);
    expect(parseMoney(null, "EUR")).toBeNull();
    expect(parseMoney("0", "EUR")).toBe(0n);
  });
  it("MONEY-02 precision, currency, magnitude and canonical signs reject", () => {
    for (const [a, c, e] of [
      ["1.001", "EUR", "EXCESS_MINOR_DIGITS"],
      ["1", "ABC", "UNSUPPORTED_CURRENCY"],
      ["90000000000.01", "EUR", "AMOUNT_OUT_OF_RANGE"],
      ["-1", "EUR", "INVALID_AMOUNT"],
      ["01", "EUR", "INVALID_AMOUNT"],
    ])
      expect(() => parseMoney(requireFixture(a), requireFixture(c))).toThrow(e);
  });
  it("MONEY-05 refunds stay in their event period; invoices/pending not ledger", () => {
    const entries = [
      {
        kind: "payment" as const,
        minor: "10000",
        currency: "EUR",
        date: "2026-01-31",
        eligible: true,
      },
      {
        kind: "refund" as const,
        minor: "2500",
        currency: "EUR",
        date: "2026-02-02",
        eligible: true,
      },
      {
        kind: "refund" as const,
        minor: "999",
        currency: "EUR",
        date: "2026-02-02",
        eligible: false,
      },
    ];
    expect(
      ledgerTotals(entries, "EUR", {
        startDate: "2026-02-01",
        endExclusive: "2026-03-01",
      }),
    ).toEqual({ paidMinor: "0", refundedMinor: "2500", netMinor: "-2500" });
    expect(() =>
      ledgerTotals([{ ...requireFixture(entries[0]), currency: "USD" }], "EUR"),
    ).toThrow("CURRENCY_MISMATCH");
  });
  it("MONEY-07 calendar dates never guess ambiguity or normalize invalid days", () => {
    for (const date of ["03/04/2026", "2026-02-29", "2026-13-01", "0000-01-01"])
      expect(() => calendarDate(date)).toThrow("INVALID_DATE");
    expect(calendarDate("2024-02-29")).toBe("2024-02-29");
    expect(timestampDate("2026-10-01T00:30:00Z", "America/Los_Angeles")).toBe(
      "2026-09-30",
    );
    expect(calendarDate("2026-10-01")).toBe("2026-10-01");
  });
  it("MONEY-04 exact large sums beyond safe JS Number", () => {
    expect(
      ledgerTotals(
        Array.from({ length: 1001 }, () => ({
          kind: "payment" as const,
          minor: "9000000000000",
          currency: "EUR",
          date: "2026-01-01",
          eligible: true,
        })),
        "EUR",
      ).paidMinor,
    ).toBe("9009000000000000");
  });
  it("calendar recurrence: preserve anchored month, never create forecast ledger", () => {
    expect(monthlyAnchor("2027-02", 31)).toBe("2027-02-28");
    expect(monthlyAnchor("2027-03", 31)).toBe("2027-03-31");
    expect(annualEstimate(999n)).toBe(11988n);
    expect(priceChange(999n, 1199n)).toEqual({
      deltaMinor: "200",
      percentRounded2: "20.02",
    });
  });
  it("FX: entrywise signed rounding and no future/stale FX", () => {
    expect(convertMinor(1n, 2, 2, "0.5") + convertMinor(1n, 2, 2, "0.5")).toBe(
      2n,
    );
    expect(convertMinor(-1n, 2, 2, "0.5")).toBe(-1n);
    expect(
      historicalRateDate("2026-10-11", ["2026-10-09", "2026-10-12"], 7),
    ).toBe("2026-10-09");
    expect(() =>
      historicalRateDate("2026-10-11", ["2026-09-30", "2026-10-12"], 7),
    ).toThrow("FX_RATE_MISSING");
  });
  it("fixed-seed decimal round trip independent integer oracle (500 runs)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 9000000000000n }), (minor) => {
        const whole = minor / 100n;
        const fraction = (minor % 100n).toString().padStart(2, "0");
        expect(parseMoney(`${whole}.${fraction}`, "EUR")).toBe(minor);
        expect(formatMinor(minor, "EUR")).toBe(`${whole}.${fraction}`);
      }),
      { seed: 20261011, numRuns: 500 },
    );
  });
  it("fixed-seed sign symmetry exact half rounding (500 runs)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 9000000000000n }), (minor) => {
        const oracle = (minor + 1n) / 2n;
        expect(convertMinor(minor, 2, 2, "0.5")).toBe(oracle);
        expect(convertMinor(-minor, 2, 2, "0.5")).toBe(-oracle);
      }),
      { seed: 20261012, numRuns: 500 },
    );
  });
});
it("fixed-seed ledger ordering preserves exact sums (500 runs)", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          kind: fc.constantFrom("payment" as const, "refund" as const),
          minor: fc.bigInt({ min: 0n, max: 9000000000000n }),
        }),
        { maxLength: 100 },
      ),
      (records) => {
        const entries = records.map((r) => ({
          ...r,
          minor: r.minor.toString(),
          currency: "EUR",
          date: "2026-01-01",
          eligible: true,
        }));
        const paid = records
          .filter((r) => r.kind === "payment")
          .reduce((sum, r) => sum + r.minor, 0n);
        const refunded = records
          .filter((r) => r.kind === "refund")
          .reduce((sum, r) => sum + r.minor, 0n);
        const oracle = {
          paidMinor: paid.toString(),
          refundedMinor: refunded.toString(),
          netMinor: (paid - refunded).toString(),
        };
        expect(ledgerTotals(entries, "EUR")).toEqual(oracle);
        expect(ledgerTotals([...entries].reverse(), "EUR")).toEqual(oracle);
      },
    ),
    { seed: 20261013, numRuns: 500 },
  );
});
