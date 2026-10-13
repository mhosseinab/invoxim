import {
  type FxEntry,
  type FxRateQuote,
  fxConversionResultSchema,
  fxEntrySchema,
  fxRateQuoteSchema,
} from "@invoxim/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { convertFxEntry, sumFxConversions } from "../src/fx/conversion";

const policy = { source: "reference-source", maxPriorAgeDays: 2 };
const entry: FxEntry = {
  id: "payment",
  kind: "payment",
  amountMinor: "1",
  currency: "EUR",
  eventDate: "2026-10-11",
};
const quote: FxRateQuote = {
  fromCurrency: "EUR",
  toCurrency: "USD",
  requestedDate: entry.eventDate,
  effectiveDate: "2026-10-09",
  rate: "0.5",
  source: policy.source,
  version: "snapshot-1",
  retrievedAt: 1791676800000,
};

describe("historical FX", () => {
  it("FX-01/03 rounds an eligible Friday reference for Sunday's half-minor payment", () => {
    expect(convertFxEntry(entry, "USD", quote, policy)).toMatchObject({
      status: "converted",
      signedMinor: "1",
      basis: "reference",
      quote,
    });
  });
  it("keeps unsupported same-currency values unconverted", () => {
    expect(
      convertFxEntry({ ...entry, currency: "XYZ" }, "XYZ", null, policy),
    ).toMatchObject({ status: "unconverted", reason: "currency_unsupported" });
  });
});

it.each([
  ["JPY", "EUR", "123", "0.006", "74"],
  ["KWD", "USD", "1250", "3.2", "400"],
  ["EUR", "JPY", "100", "150.5", "151"],
  ["EUR", "KWD", "1", "0.05", "1"],
])("uses %s to %s currency precision", (from, to, amount, rate, expected) => {
  expect(
    convertFxEntry(
      { ...entry, currency: from, amountMinor: amount },
      to,
      { ...quote, fromCurrency: from, toCurrency: to, rate },
      policy,
    ),
  ).toMatchObject({ status: "converted", signedMinor: expected });
});

it.each([
  [null, "rate_missing"],
  [{ ...quote, effectiveDate: "2026-10-12" }, "rate_future"],
  [{ ...quote, effectiveDate: "2026-10-08" }, "rate_stale"],
  [{ ...quote, source: "other-source" }, "source_mismatch"],
  [{ ...quote, requestedDate: "2026-10-10" }, "quote_mismatch"],
  [{ ...quote, fromCurrency: "GBP" }, "quote_mismatch"],
  [{ ...quote, toCurrency: "GBP" }, "quote_mismatch"],
  [{ ...quote, rate: "0" }, "invalid_quote"],
  [{ ...quote, rate: "-1" }, "invalid_quote"],
  [{ ...quote, rate: "1e2" }, "invalid_quote"],
  [{ ...quote, retrievedAt: Number.MAX_SAFE_INTEGER + 1 }, "invalid_quote"],
])(
  "does not invent conversion from an unsuitable quote %j",
  (supplied, reason) => {
    expect(convertFxEntry(entry, "USD", supplied, policy)).toMatchObject({
      status: "unconverted",
      reason,
      entry,
    });
  },
);

it("FX-03 sums separately rounded payments and refunds, including exact zero", () => {
  const payment = convertFxEntry(entry, "USD", quote, policy);
  const second = convertFxEntry(
    { ...entry, id: "second" },
    "USD",
    quote,
    policy,
  );
  const refund = convertFxEntry(
    { ...entry, id: "refund", kind: "refund" },
    "USD",
    quote,
    policy,
  );
  expect(sumFxConversions("USD", [payment, second]).signedMinor).toBe("2");
  expect(refund).toMatchObject({ signedMinor: "-1" });
  expect(sumFxConversions("USD", [payment, refund]).signedMinor).toBe("0");
  expect(
    convertFxEntry(
      { ...entry, amountMinor: "0", kind: "refund" },
      "USD",
      quote,
      policy,
    ),
  ).toMatchObject({ signedMinor: "0" });
});

it("FX-04 uses refund date's own snapshot without rewriting January payment", () => {
  const january = {
    ...entry,
    currency: "USD",
    amountMinor: "10000",
    eventDate: "2026-01-31",
  };
  const february = {
    ...january,
    id: "refund",
    kind: "refund" as const,
    amountMinor: "1000",
    eventDate: "2026-02-02",
  };
  const rate = (date: string, value: string): FxRateQuote => ({
    ...quote,
    fromCurrency: "USD",
    toCurrency: "EUR",
    requestedDate: date,
    effectiveDate: date,
    rate: value,
  });
  const paid = convertFxEntry(
    january,
    "EUR",
    rate(january.eventDate, "0.9"),
    policy,
  );
  const refunded = convertFxEntry(
    february,
    "EUR",
    rate(february.eventDate, "0.8"),
    policy,
  );
  expect(paid).toMatchObject({ signedMinor: "9000", entry: january });
  expect(refunded).toMatchObject({ signedMinor: "-800", entry: february });
  expect(sumFxConversions("EUR", [paid, refunded]).signedMinor).toBe("8200");
});

it("FX-05 separates reporting targets and snapshots without modifying originals", () => {
  const original = structuredClone(entry);
  const snapshot = structuredClone(quote);
  const dollars = convertFxEntry(entry, "USD", quote, policy);
  const pounds = convertFxEntry(
    entry,
    "GBP",
    { ...quote, toCurrency: "GBP", rate: "2" },
    policy,
  );
  expect(dollars).toMatchObject({
    signedMinor: "1",
    calculationVersion: "fx-v1",
  });
  expect(pounds).toMatchObject({ signedMinor: "2", reportingCurrency: "GBP" });
  expect(entry).toEqual(original);
  expect(quote).toEqual(snapshot);
  expect(convertFxEntry(entry, "EUR", quote, policy)).toMatchObject({
    basis: "identity",
    quote: null,
    signedMinor: "1",
  });
  expect(() => sumFxConversions("USD", [dollars, pounds])).toThrow(
    "INVALID_FX_INPUT",
  );
});

it.each([
  ["0099-12-31", "0100-01-01", 1],
  ["0001-01-01", "0001-01-02", 1],
  ["2000-02-28", "2000-03-01", 2],
  ["1900-02-28", "1900-03-01", 1],
  ["9999-12-30", "9999-12-31", 1],
])("computes exact Gregorian age from %s to %s", (effective, event, age) => {
  const row = { ...entry, eventDate: event };
  const rate = { ...quote, requestedDate: event, effectiveDate: effective };
  expect(
    convertFxEntry(row, "USD", rate, { ...policy, maxPriorAgeDays: age }),
  ).toMatchObject({ status: "converted" });
  expect(
    convertFxEntry(row, "USD", rate, { ...policy, maxPriorAgeDays: age - 1 }),
  ).toMatchObject({ reason: "rate_stale" });
});

it("rejects malformed canonical boundaries rather than throwing BigInt syntax errors", () => {
  for (const amountMinor of ["-1", "01", "1.0", "9000000000001"]) {
    expect(fxEntrySchema.safeParse({ ...entry, amountMinor }).success).toBe(
      false,
    );
    expect(() =>
      convertFxEntry({ ...entry, amountMinor }, "USD", quote, policy),
    ).toThrow("INVALID_FX_INPUT");
  }
  for (const eventDate of ["0000-01-01", "1900-02-29", "2026-04-31"])
    expect(() =>
      convertFxEntry({ ...entry, eventDate }, "USD", quote, policy),
    ).toThrow("INVALID_FX_INPUT");
  for (const rate of [
    "0",
    "0.000",
    "-0.1",
    "NaN",
    "01",
    "1.1234567890123456789",
  ])
    expect(fxRateQuoteSchema.safeParse({ ...quote, rate }).success).toBe(false);
  expect(() =>
    fxConversionResultSchema.safeParse({
      ...convertFxEntry(entry, "USD", quote, policy),
      signedMinor: "invalid",
    }),
  ).not.toThrow();
  expect(() =>
    sumFxConversions("USD", [
      {
        ...convertFxEntry(entry, "USD", quote, policy),
        signedMinor: "2",
      } as ReturnType<typeof convertFxEntry>,
    ]),
  ).toThrow("INVALID_FX_INPUT");
  expect(() =>
    convertFxEntry(entry, "USD", quote, { ...policy, maxPriorAgeDays: 32 }),
  ).toThrow("INVALID_FX_INPUT");
});

it("bounds individual conversion but sums exact values beyond SQLite and JS integer limits", () => {
  const large = { ...entry, amountMinor: "9000000000000" };
  expect(
    convertFxEntry(large, "USD", { ...quote, rate: "999999999999" }, policy),
  ).toMatchObject({ reason: "magnitude_overflow", entry: large });
  const rows = Array.from({ length: 1000 }, (_, index) =>
    convertFxEntry(
      { ...large, id: String(index) },
      "USD",
      { ...quote, rate: "1000000" },
      policy,
    ),
  );
  expect(sumFxConversions("USD", rows)).toMatchObject({
    signedMinor: "9000000000000000000000",
    convertedCount: 1000,
  });
  expect(() =>
    sumFxConversions("USD", [
      ...rows,
      rows[0] as ReturnType<typeof convertFxEntry>,
    ]),
  ).toThrow("INVALID_FX_INPUT");
  expect(() =>
    sumFxConversions("USD", [
      rows[0] as ReturnType<typeof convertFxEntry>,
      rows[0] as ReturnType<typeof convertFxEntry>,
    ]),
  ).toThrow("INVALID_FX_INPUT");
  const missing = convertFxEntry(
    { ...entry, id: "missing" },
    "USD",
    null,
    policy,
  );
  expect(
    sumFxConversions("USD", [
      rows[0] as ReturnType<typeof convertFxEntry>,
      missing,
    ]),
  ).toMatchObject({
    signedMinor: "9000000000000000000",
    convertedCount: 1,
    unconverted: [missing],
  });
});

it("property: half-rate hand oracle and refund reflection preserve per-entry rounding", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 900000 }), (amount) => {
      const expected = String(Math.ceil(amount / 2)); // bounded integer hand oracle, no floating money conversion
      const row = { ...entry, amountMinor: String(amount) };
      expect(convertFxEntry(row, "USD", quote, policy)).toMatchObject({
        signedMinor: expected,
      });
      expect(
        convertFxEntry({ ...row, kind: "refund" }, "USD", quote, policy),
      ).toMatchObject({ signedMinor: amount === 0 ? "0" : `-${expected}` });
    }),
    { seed: 1903, numRuns: 200 },
  );
});

it.each(["EUR", "USD", "GBP", "CHF", "JPY", "KWD"])(
  "supported %s identity needs no invented quote",
  (currency) => {
    const source = { ...entry, currency, amountMinor: "9000000000000" };
    expect(convertFxEntry(source, currency, null, policy)).toMatchObject({
      status: "converted",
      basis: "identity",
      quote: null,
      signedMinor: "9000000000000",
    });
    expect(
      convertFxEntry({ ...source, kind: "refund" }, currency, null, policy),
    ).toMatchObject({ signedMinor: "-9000000000000" });
  },
);

it("supports explicit same-day and 31-day policies, without choosing a default", () => {
  const row = { ...entry, eventDate: "2026-10-31" };
  const rate = {
    ...quote,
    requestedDate: row.eventDate,
    effectiveDate: "2026-09-30",
  };
  expect(
    convertFxEntry(row, "USD", rate, { ...policy, maxPriorAgeDays: 31 }),
  ).toMatchObject({ status: "converted" });
  expect(
    convertFxEntry(row, "USD", rate, { ...policy, maxPriorAgeDays: 30 }),
  ).toMatchObject({ reason: "rate_stale" });
  expect(
    convertFxEntry(
      row,
      "USD",
      { ...rate, effectiveDate: row.eventDate },
      { ...policy, maxPriorAgeDays: 0 },
    ),
  ).toMatchObject({ status: "converted" });
  const identity = convertFxEntry(entry, "EUR", null, policy);
  expect(
    fxConversionResultSchema.safeParse({
      ...identity,
      basis: "reference",
      quote: { ...quote, toCurrency: "EUR" },
    }).success,
  ).toBe(false);
});
