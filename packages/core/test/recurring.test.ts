import type { RecurringPayment } from "@invoxim/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deriveRecurringSuggestion } from "../src/recurring/derive";

const payment = (
  entryId: string,
  eventDate: string,
  amountMinor = "999",
): RecurringPayment => ({
  entryId,
  purchaseId: `purchase-${entryId}`,
  kind: "payment",
  eligible: true,
  installment: false,
  amountMinor,
  currency: "EUR",
  eventDate,
  serviceIdentity: { kind: "service-reference", key: "service-plan-id" },
  pricing: { kind: "unknown", evidence: "unknown" },
});
describe("T20 pure recurring suggestions", () => {
  it("RECUR-01/02 preserves Jan31 month-end anchor and never creates cash", () => {
    const payments = [
      payment("jan", "2027-01-31"),
      payment("feb", "2027-02-28"),
      payment("mar", "2027-03-31"),
    ];
    const original = structuredClone(payments);
    expect(deriveRecurringSuggestion({ payments })).toMatchObject({
      status: "series",
      cadence: "monthly",
      anchorDate: "2027-01-31",
      entryIds: ["jan", "feb", "mar"],
      forecast: {
        estimatedNextDate: "2027-04-30",
        monthlyMinor: "999",
        annualMinor: "11988",
        certainty: "estimate",
      },
    });
    expect(payments).toEqual(original);
  });
  it("refunds and noneligible events never become recurring evidence", () => {
    expect(
      deriveRecurringSuggestion({
        payments: [
          { ...payment("refund", "2027-01-31"), kind: "refund" },
          { ...payment("excluded", "2027-02-28"), eligible: false },
        ],
      }),
    ).toMatchObject({ status: "insufficient", reason: "no_eligible_payments" });
  });
});

it("allows bounded settlement deviations but never fills missing periods", () => {
  expect(
    deriveRecurringSuggestion({
      payments: [
        payment("a", "2027-01-31"),
        payment("b", "2027-02-27"),
        payment("c", "2027-03-30"),
      ],
    }),
  ).toMatchObject({
    status: "series",
    postingToleranceDays: 3,
    forecast: { estimatedNextDate: "2027-04-30" },
  });
  expect(
    deriveRecurringSuggestion({
      payments: [
        payment("a", "2027-01-31"),
        payment("b", "2027-03-31"),
        payment("c", "2027-05-31"),
      ],
    }),
  ).toMatchObject({ status: "insufficient", reason: "unstable_intervals" });
});

it("RECUR-03 needs explicit terms for one annual payment", () => {
  const annual = payment("annual", "2024-02-29", "12001");
  expect(deriveRecurringSuggestion({ payments: [annual] })).toMatchObject({
    status: "insufficient",
    reason: "insufficient_history",
  });
  expect(
    deriveRecurringSuggestion({
      payments: [
        {
          ...annual,
          terms: {
            cadence: "annual",
            anchorDate: "2024-02-29",
            evidence: "explicit-terms",
          },
        },
      ],
    }),
  ).toMatchObject({
    status: "series",
    cadence: "annual",
    forecast: {
      estimatedNextDate: "2025-02-28",
      monthlyMinor: "1000",
      annualMinor: "12001",
    },
  });
  expect(
    deriveRecurringSuggestion({
      payments: [annual, payment("renewal", "2025-02-28", "12001")],
    }),
  ).toMatchObject({
    status: "series",
    cadence: "annual",
    forecast: { estimatedNextDate: "2026-02-28" },
  });
});

it("infers weekly payments independently and discloses52-payment annual convention", () => {
  expect(
    deriveRecurringSuggestion({
      payments: [
        payment("a", "2027-01-07", "100"),
        payment("b", "2027-01-15", "100"),
        payment("c", "2027-01-21", "100"),
      ],
    }),
  ).toMatchObject({
    status: "series",
    cadence: "weekly",
    forecast: {
      estimatedNextDate: "2027-01-28",
      monthlyMinor: "433",
      annualMinor: "5200",
      weeklyPaymentsPerYear: 52,
    },
  });
});

it("leap/month-end forecasts restore original day and handle calendar boundary", () => {
  expect(
    deriveRecurringSuggestion({
      payments: [
        payment("a", "2024-01-31"),
        payment("b", "2024-02-29"),
        payment("c", "2024-03-31"),
      ],
    }),
  ).toMatchObject({ forecast: { estimatedNextDate: "2024-04-30" } });
  const annual = payment("a", "2023-02-28");
  expect(
    deriveRecurringSuggestion({
      payments: [
        {
          ...annual,
          terms: {
            cadence: "annual",
            anchorDate: "2020-02-29",
            evidence: "explicit-terms",
          },
        },
        payment("b", "2024-02-29"),
      ],
    }),
  ).toMatchObject({ forecast: { estimatedNextDate: "2025-02-28" } });
  expect(
    deriveRecurringSuggestion({
      payments: [
        {
          ...payment("end", "9999-12-31"),
          terms: {
            cadence: "monthly",
            anchorDate: "9999-12-31",
            evidence: "explicit-terms",
          },
        },
      ],
    }),
  ).toMatchObject({ status: "series", forecast: { estimatedNextDate: null } });
  expect(
    deriveRecurringSuggestion({
      payments: [
        payment("a", "0001-01-31"),
        payment("b", "0001-02-28"),
        payment("c", "0001-03-31"),
      ],
    }),
  ).toMatchObject({ forecast: { estimatedNextDate: "0001-04-30" } });
});

it("duplicates/installments/zero charges do not inflate frequency evidence", () => {
  const a = payment("a", "2027-01-31"),
    b = payment("b", "2027-02-28");
  expect(deriveRecurringSuggestion({ payments: [a, a, b] })).toMatchObject({
    status: "insufficient",
  });
  expect(() =>
    deriveRecurringSuggestion({ payments: [a, { ...a, amountMinor: "1000" }] }),
  ).toThrow("INVALID_RECURRING_INPUT");
  expect(
    deriveRecurringSuggestion({
      payments: [a, b, { ...payment("c", "2027-03-31"), installment: true }],
    }),
  ).toMatchObject({ status: "insufficient" });
  expect(
    deriveRecurringSuggestion({
      payments: [
        a,
        b,
        { ...payment("c", "2027-03-31"), purchaseId: b.purchaseId },
      ],
    }),
  ).toMatchObject({ status: "insufficient" });
  expect(
    deriveRecurringSuggestion({
      payments: [
        payment("a", "2027-01-31", "0"),
        payment("b", "2027-02-28", "0"),
        payment("c", "2027-03-31", "0"),
      ],
    }),
  ).toMatchObject({ status: "insufficient" });
  expect(
    deriveRecurringSuggestion({
      payments: [
        {
          ...payment("free", "2027-01-31", "0"),
          terms: {
            cadence: "monthly",
            anchorDate: "2027-01-31",
            evidence: "user-confirmed",
          },
        },
      ],
    }),
  ).toMatchObject({
    status: "series",
    forecast: { monthlyMinor: "0", annualMinor: "0" },
  });
});

it.each([
  "missing_service_identity",
  "mixed_service_identity",
  "mixed_currency",
  "unsupported_currency",
] as const)("keeps %s facts out of combined suggestions", (reason) => {
  let payments = [
    payment("a", "2027-01-31"),
    payment("b", "2027-02-28"),
    payment("c", "2027-03-31"),
  ];
  if (reason === "missing_service_identity")
    payments = payments.map((row) => ({ ...row, serviceIdentity: null }));
  if (reason === "mixed_service_identity")
    payments[1] = {
      ...billed(payments[1]),
      serviceIdentity: { kind: "service-reference", key: "other-service" },
    };
  if (reason === "mixed_currency")
    payments[1] = { ...billed(payments[1]), currency: "USD" };
  if (reason === "unsupported_currency")
    payments = payments.map((row) => ({ ...row, currency: "XYZ" }));
  expect(deriveRecurringSuggestion({ payments })).toMatchObject({
    status: "insufficient",
    reason,
  });
});
function billed(row: RecurringPayment | undefined): RecurringPayment {
  if (!row) throw new Error("Missing test payment");
  return row;
}

it("only explicit comparable fixed-charge basis supports strong price changes", () => {
  const payments = [
    payment("a", "2027-01-31", "900"),
    payment("b", "2027-02-28", "1000"),
    payment("c", "2027-03-31", "1100"),
  ];
  expect(deriveRecurringSuggestion({ payments })).toMatchObject({
    comparison: {
      previousEntryId: "b",
      currentEntryId: "c",
      signal: "charged_amount_changed",
      deltaMinor: "100",
      percentHundredths: "1000",
    },
  });
  const fixed = payments.map((row) => ({
    ...row,
    pricing: { kind: "fixed" as const, evidence: "explicit-terms" as const },
    comparableCharge: {
      basisKey: "same-plan-no-tax-no-usage",
      amountMinor: row.amountMinor,
      evidence: "explicit-terms" as const,
    },
  }));
  expect(deriveRecurringSuggestion({ payments: fixed })).toMatchObject({
    comparison: {
      signal: "fixed_price_increase",
      basis: "comparable-charge",
      percentHundredths: "1000",
    },
  });
  const usage = fixed.map((row) => ({
    ...row,
    pricing: {
      kind: "usage-variable" as const,
      evidence: "explicit-terms" as const,
    },
  }));
  expect(deriveRecurringSuggestion({ payments: usage })).toMatchObject({
    comparison: { signal: "usage_variation" },
  });
  const changedBasis = [
    billed(fixed[0]),
    billed(fixed[1]),
    {
      ...billed(fixed[2]),
      comparableCharge: {
        basisKey: "different-tax-or-plan",
        amountMinor: "1100",
        evidence: "explicit-terms" as const,
      },
    },
  ];
  expect(deriveRecurringSuggestion({ payments: changedBasis })).toMatchObject({
    comparison: { signal: "charged_amount_changed", basis: "payment-amount" },
  });
  const unchangedComparable = fixed.map((row) => ({
    ...row,
    comparableCharge: {
      basisKey: "same-plan-no-tax-no-usage",
      amountMinor: "800",
      evidence: "explicit-terms" as const,
    },
  }));
  expect(
    deriveRecurringSuggestion({ payments: unchangedComparable }),
  ).toMatchObject({
    comparison: {
      signal: "stable",
      previousAmountMinor: "800",
      currentAmountMinor: "800",
      deltaMinor: "0",
    },
  });
});

it("exact comparison preserves zero denominator and large originals without float money", () => {
  const term = {
    cadence: "monthly" as const,
    anchorDate: "2027-01-31",
    evidence: "explicit-terms" as const,
  };
  const series = [
    payment("a", "2027-01-31", "0"),
    payment("b", "2027-02-28", "9000000000000"),
  ].map((row) => ({
    ...row,
    terms: term,
    pricing: { kind: "fixed" as const, evidence: "explicit-terms" as const },
    comparableCharge: {
      basisKey: "comparable",
      amountMinor: row.amountMinor,
      evidence: "explicit-terms" as const,
    },
  }));
  expect(deriveRecurringSuggestion({ payments: series })).toMatchObject({
    comparison: {
      deltaMinor: "9000000000000",
      percentHundredths: null,
      signal: "fixed_price_increase",
    },
    forecast: { annualMinor: "108000000000000" },
  });
  expect(
    deriveRecurringSuggestion({
      payments: [
        {
          ...billed(series[0]),
          amountMinor: "9000000000000",
          comparableCharge: {
            basisKey: "comparable",
            amountMinor: "9000000000000",
            evidence: "explicit-terms",
          },
        },
        {
          ...billed(series[1]),
          amountMinor: "1",
          comparableCharge: {
            basisKey: "comparable",
            amountMinor: "1",
            evidence: "explicit-terms",
          },
        },
      ],
    }),
  ).toMatchObject({
    comparison: {
      signal: "fixed_price_decrease",
      deltaMinor: "-8999999999999",
      percentHundredths: "-10000",
    },
  });
});

it.each(["dismissed", "paused", "canceled", "confirmed"] as const)(
  "RECUR-05 preserves explicit %s metadata across evidence replay",
  (state) => {
    const payments = [
      payment("a", "2027-01-31"),
      payment("b", "2027-02-28"),
      payment("c", "2027-03-31"),
    ];
    const original = structuredClone(payments);
    const input = { payments, decision: { state, version: 7 } };
    const result = deriveRecurringSuggestion(input);
    expect(result).toMatchObject({
      state,
      decision: input.decision,
      entryIds: ["a", "b", "c"],
    });
    if (result.status !== "series") throw new Error("Missing derived series");
    expect(result.forecast === null).toBe(state !== "confirmed");
    expect(
      deriveRecurringSuggestion({
        ...input,
        payments: [...payments, billed(payments[0])],
      }),
    ).toEqual(result);
    expect(payments).toEqual(original);
  },
);

it("rejects contradictory terms and deviations outside fixed method tolerance", () => {
  const payments = [
    payment("a", "2027-01-31"),
    payment("b", "2027-02-24"),
    payment("c", "2027-03-31"),
  ];
  expect(deriveRecurringSuggestion({ payments })).toMatchObject({
    status: "insufficient",
    reason: "unstable_intervals",
  });
  const annual = {
    ...payment("a", "2027-01-31"),
    terms: {
      cadence: "annual" as const,
      anchorDate: "2027-01-31",
      evidence: "explicit-terms" as const,
    },
  };
  const monthly = {
    ...payment("b", "2027-02-28"),
    terms: {
      cadence: "monthly" as const,
      anchorDate: "2027-01-31",
      evidence: "explicit-terms" as const,
    },
  };
  expect(
    deriveRecurringSuggestion({ payments: [annual, monthly] }),
  ).toMatchObject({ reason: "terms_conflict" });
});

it("rejects unbounded/extra/noncanonical input without financial writes", () => {
  expect(() =>
    deriveRecurringSuggestion({
      payments: [{ ...payment("a", "2027-01-31"), amountMinor: "-1" }],
    }),
  ).toThrow("INVALID_RECURRING_INPUT");
  const untrustedAuthority = {
    payments: [payment("a", "2027-01-31")],
    userId: "untrusted",
  };
  expect(() => deriveRecurringSuggestion(untrustedAuthority)).toThrow(
    "INVALID_RECURRING_INPUT",
  );
  expect(() =>
    deriveRecurringSuggestion({
      payments: Array.from({ length: 1001 }, (_, index) =>
        payment(String(index), "2027-01-31"),
      ),
    }),
  ).toThrow("INVALID_RECURRING_INPUT");
});

it("property: permutation and exact duplicate replay preserve suggestions and originals", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 900000 }),
      fc.integer({ min: 1, max: 28 }),
      (amount, anchor) => {
        const d = String(anchor).padStart(2, "0");
        const payments = [
          payment("a", `2027-01-${d}`, String(amount)),
          payment("b", `2027-02-${d}`, String(amount)),
          payment("c", `2027-03-${d}`, String(amount)),
        ];
        const original = structuredClone(payments);
        const result = deriveRecurringSuggestion({ payments });
        expect(result).toMatchObject({
          forecast: {
            annualMinor: (BigInt(amount) * 12n).toString(),
            monthlyMinor: String(amount),
            estimatedNextDate: `2027-04-${d}`,
          },
        });
        expect(
          deriveRecurringSuggestion({
            payments: [
              billed(payments[2]),
              billed(payments[0]),
              billed(payments[1]),
              billed(payments[1]),
            ],
          }),
        ).toEqual(result);
        expect(payments).toEqual(original);
      },
    ),
    { seed: 2001, numRuns: 100 },
  );
});
