import { expect, it } from "vitest";
import { preferencesRequestSchema } from "../src/auth";
import { purchaseChangesSchema } from "../src/corrections";
import { fxEntrySchema, fxRateQuoteSchema } from "../src/fx";
import { processingDisclosureQuerySchema } from "../src/onboarding";
import {
  currencyTotalsSchema,
  purchaseFiltersSchema,
  purchaseViewSchema,
} from "../src/purchases";

// ---------------------------------------------------------------------------
// ext#5 — FX-rate integer-digit count must match core (money-conversion.ts:15).
// Core accepts up to 13 integer digits: /^(0|[1-9][0-9]{0,12})(\.[0-9]{1,18})?$/
// Contracts accepts only 12: {0,11} after the leading digit (fx.ts:62).
// Decision: 13 integer digits, matching core. This test pins the rule.
// ---------------------------------------------------------------------------

const thirteenDigitRate = "1234567890123.5"; // 13 integer digits
const fourteenDigitRate = "12345678901234.5"; // 14 integer digits

function rateQuote(rate: string) {
  return {
    fromCurrency: "EUR",
    toCurrency: "USD",
    requestedDate: "2026-01-15",
    effectiveDate: "2026-01-15",
    rate,
    source: "test",
    version: "v1",
    retrievedAt: 0,
  };
}

it("CON-1 FX rate accepts 13 integer digits (match core) and rejects 14", () => {
  expect(
    fxRateQuoteSchema.safeParse(rateQuote(thirteenDigitRate)).success,
  ).toBe(true);
  expect(
    fxRateQuoteSchema.safeParse(rateQuote(fourteenDigitRate)).success,
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// ext#4 — four supportedCurrency variants disagree.
// Registry codes are required for API/reporting fields (purchase filters,
// totals, reportingCurrency, purchase changes). Domain entry/payment currency
// accepts any /^[A-Z]{3}$/ (`currencyCode`) so FX/recurring can return
// `currency_unsupported` / `unsupported_currency` instead of failing parse.
// ---------------------------------------------------------------------------

it("CON-1 API/reporting currency fields reject codes outside the registry", () => {
  for (const parse of [
    () => purchaseFiltersSchema.safeParse({ currency: "XYZ" }),
    () =>
      currencyTotalsSchema.safeParse({
        currency: "XYZ",
        paidMinor: "0",
        refundedMinor: "0",
        netMinor: "0",
      }),
    () =>
      preferencesRequestSchema.safeParse({
        version: 1,
        timezone: "UTC",
        reportingCurrency: "XYZ",
      }),
    () =>
      processingDisclosureQuerySchema.safeParse({
        connectionId: "c1",
        reportingCurrency: "XYZ",
      }),
    () => purchaseChangesSchema.safeParse({ currency: "XYZ" }),
  ])
    expect(parse().success).toBe(false);
});

it("CON-1 fx entry accepts ISO-like currencyCode so domain can report currency_unsupported", () => {
  expect(
    fxEntrySchema.safeParse({
      id: "e1",
      kind: "payment",
      amountMinor: "1",
      currency: "XYZ",
      eventDate: "2026-01-15",
    }).success,
  ).toBe(true);
});

it("CON-1 registry currencies remain accepted", () => {
  expect(purchaseFiltersSchema.safeParse({ currency: "EUR" }).success).toBe(
    true,
  );
  expect(
    preferencesRequestSchema.safeParse({
      version: 1,
      timezone: "UTC",
      reportingCurrency: "JPY",
    }).success,
  ).toBe(true);
  expect(
    fxEntrySchema.safeParse({
      id: "e1",
      kind: "payment",
      amountMinor: "1",
      currency: "CHF",
      eventDate: "2026-01-15",
    }).success,
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// MINOR_BOUND — the 9000000000000 literal is copy-pasted 4×
// (purchases.ts:17, presentation.ts:142, onboarding.ts:18, fx.ts:26).
// One exported constant is the single source of truth. Bound is 9e12 minor units.
// ---------------------------------------------------------------------------

const purchaseViewBase = {
  id: "p1",
  merchant: "Cafe",
  date: "2026-01-15",
  invoiceReference: null,
  orderReference: null,
  category: "other" as const,
  currency: "EUR",
  paymentState: "unknown" as const,
  version: 1,
  evidenceCount: 0,
  reviewReasons: [],
  lifecycle: [],
  period: [],
};

it("CON-1 purchase view document total rejects MINOR_BOUND+1 and accepts MINOR_BOUND", () => {
  expect(
    purchaseViewSchema.safeParse({
      ...purchaseViewBase,
      documentTotalMinor: "9000000000001",
    }).success,
  ).toBe(false);
  expect(
    purchaseViewSchema.safeParse({
      ...purchaseViewBase,
      documentTotalMinor: "9000000000000",
    }).success,
  ).toBe(true);
});

it("CON-1 fx entry amount rejects MINOR_BOUND+1 and accepts MINOR_BOUND", () => {
  const entry = {
    id: "e1",
    kind: "payment" as const,
    currency: "EUR",
    eventDate: "2026-01-15",
  };
  expect(
    fxEntrySchema.safeParse({ ...entry, amountMinor: "9000000000001" }).success,
  ).toBe(false);
  expect(
    fxEntrySchema.safeParse({ ...entry, amountMinor: "9000000000000" }).success,
  ).toBe(true);
});
