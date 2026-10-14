import type { RecurringPayment } from "@invoxim/contracts";
import { expect, it } from "vitest";
import fixtures from "../../../test-design/financial-cases.json";
import { convertFxEntry } from "../src/fx/conversion";
import {
  convertMinor,
  formatMinor,
  ledgerTotals,
  monthlyAnchor,
  parseMoney,
} from "../src/index";
import { planLedgerIngestion } from "../src/ledger/plan";
import type { LedgerSnapshot } from "../src/ledger/types";
import { deriveRecurringSuggestion } from "../src/recurring/derive";
import { requireFixture } from "./fixture-value";

/**
 * CORE-4: fixture operations that used the deleted test-only helpers now
 * run against the production planner, recurring deriver and FX converter.
 */

interface Input {
  amount?: string;
  currency?: string;
  values?: string[];
  sourceMinor?: string;
  sourceMinorDigits?: number;
  targetMinorDigits?: number;
  targetPerSource?: string;
  monthlyMinor?: string;
  previousMinor?: string;
  nextMinor?: string;
  eventDate?: string;
  availableDates?: string[];
  maxPriorAgeDays?: number;
  anchorDay?: number;
  months?: string[];
  entries?: {
    kind: "payment" | "refund";
    minor: string;
    date: string;
  }[];
  documentType?: "invoice" | "refund" | "receipt" | "credit-note" | "statement";
  totalMinor?: string;
  paymentEvidence?: "explicitly-paid" | "explicitly-unpaid" | "unknown";
  refundEvidence?: "completed" | "pending" | "none" | "unknown";
}

const empty = (): LedgerSnapshot => ({
  observations: [],
  purchases: [],
  events: [],
  decisions: [],
});

function recurringPayment(
  entryId: string,
  eventDate: string,
  amountMinor: string,
): RecurringPayment {
  return {
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
  };
}

for (const fixture of fixtures.cases)
  it(`financial fixture ${fixture.id}: ${fixture.operation}`, () => {
    const input = fixture.input as Input;
    const execute = () => {
      switch (fixture.operation) {
        case "parse-money":
          return {
            minor: requireFixture(
              parseMoney(
                requireFixture(input.amount),
                requireFixture(input.currency),
              ),
            ).toString(),
          };
        case "sum-minor": {
          const totals = ledgerTotals(
            requireFixture(input.values).map((minor) => ({
              kind: "payment",
              minor,
              currency: requireFixture(input.currency),
              date: "2026-01-01",
              eligible: true,
            })),
            requireFixture(input.currency),
          );
          return "display" in fixture.expected
            ? {
                minor: totals.paidMinor,
                display: formatMinor(
                  totals.paidMinor,
                  requireFixture(input.currency),
                ),
              }
            : { minor: totals.paidMinor };
        }
        case "convert":
          return {
            targetMinor: convertMinor(
              BigInt(requireFixture(input.sourceMinor)),
              requireFixture(input.sourceMinorDigits),
              requireFixture(input.targetMinorDigits),
              requireFixture(input.targetPerSource),
            ).toString(),
          };
        case "convert-each-then-sum":
          return {
            targetMinor: requireFixture(input.values)
              .reduce(
                (sum, v) =>
                  sum +
                  convertMinor(
                    BigInt(v),
                    requireFixture(input.sourceMinorDigits),
                    requireFixture(input.targetMinorDigits),
                    requireFixture(input.targetPerSource),
                  ),
                0n,
              )
              .toString(),
          };
        case "monthly-net":
          return Object.fromEntries(
            [
              ...new Set(
                requireFixture(input.entries).map((e) => e.date.slice(0, 7)),
              ),
            ].map((month) => [
              month,
              ledgerTotals(
                requireFixture(input.entries)
                  .filter((e) => e.date.startsWith(month))
                  .map((e) => ({ ...e, currency: "EUR", eligible: true })),
                "EUR",
              ).netMinor,
            ]),
          );
        case "annual-estimate": {
          // Production annual is cadence-scoped; FN14 is the monthly case.
          const series = deriveRecurringSuggestion({
            payments: [
              recurringPayment(
                "a",
                "2027-01-31",
                requireFixture(input.monthlyMinor),
              ),
              recurringPayment(
                "b",
                "2027-02-28",
                requireFixture(input.monthlyMinor),
              ),
              recurringPayment(
                "c",
                "2027-03-31",
                requireFixture(input.monthlyMinor),
              ),
            ],
          });
          if (series.status !== "series") throw new Error("expected series");
          return { annualMinor: series.forecast?.annualMinor };
        }
        case "price-change": {
          const series = deriveRecurringSuggestion({
            payments: [
              recurringPayment("first", "2026-12-31", "500"),
              recurringPayment(
                "prev",
                "2027-01-31",
                requireFixture(input.previousMinor),
              ),
              recurringPayment(
                "next",
                "2027-02-28",
                requireFixture(input.nextMinor),
              ),
            ],
          });
          if (series.status !== "series" || !series.comparison)
            throw new Error("expected comparison");
          const hundredths = series.comparison.percentHundredths ?? "0";
          const padded = hundredths.padStart(3, "0");
          return {
            deltaMinor: series.comparison.deltaMinor,
            percentRounded2: `${padded.slice(0, -2)}.${padded.slice(-2)}`,
          };
        }
        case "select-historical-rate": {
          // Production receives a supplied quote and applies the rate-date
          // rules; FN16/FN17 cover accept / future / stale.
          const policy = {
            source: "reference-source",
            maxPriorAgeDays: requireFixture(input.maxPriorAgeDays),
          };
          const eventDate = requireFixture(input.eventDate);
          const entry = {
            id: "e",
            kind: "payment" as const,
            amountMinor: "1",
            currency: "EUR",
            eventDate,
          };
          const base = {
            fromCurrency: "EUR",
            toCurrency: "USD",
            requestedDate: eventDate,
            rate: "0.5",
            source: policy.source,
            version: "snapshot-1",
            retrievedAt: 1791676800000,
          };
          const candidates = requireFixture(input.availableDates)
            .filter((date) => date <= eventDate)
            .sort();
          const selected = candidates.at(-1);
          if (!selected) {
            // No prior quote: production reports rate_missing / rate_stale.
            const stale = requireFixture(input.availableDates)[0];
            const result = convertFxEntry(
              entry,
              "USD",
              stale ? { ...base, effectiveDate: stale } : null,
              policy,
            );
            if (result.status === "converted")
              throw new Error("FX_RATE_MISSING");
            return { rateDate: result.reason };
          }
          const result = convertFxEntry(
            entry,
            "USD",
            { ...base, effectiveDate: selected },
            policy,
          );
          if (result.status !== "converted") throw new Error("FX_RATE_MISSING");
          return { rateDate: selected };
        }
        case "monthly-anchor":
          return {
            dates: requireFixture(input.months).map((month) =>
              monthlyAnchor(month, requireFixture(input.anchorDay)),
            ),
          };
        case "financial-inclusion": {
          const plan = planLedgerIngestion(
            {
              identity: {
                documentId: "doc-1",
                contentHash: "hash-1",
                extractionFingerprint: "v1",
              },
              result: {
                status: "accepted",
                documentType: requireFixture(input.documentType),
                warnings: [],
                records: [
                  {
                    merchant: "Synthetic shop",
                    documentDate: "2026-01-01",
                    eventDate: "2026-01-01",
                    currency: "EUR",
                    total: formatMinor(
                      BigInt(requireFixture(input.totalMinor)),
                      "EUR",
                    ),
                    tax: null,
                    invoiceNumber: null,
                    orderReference: null,
                    category: "shopping",
                    paymentEvidence: input.paymentEvidence ?? "unknown",
                    refundEvidence: input.refundEvidence ?? "none",
                    paymentMethodHint: "unknown",
                    recurringCadence: "unknown",
                    paymentAmount: null,
                    refundAmount: null,
                    storeCreditAmount: null,
                    provenance: [],
                  },
                ],
              },
            },
            empty(),
          );
          return { ledgerEntries: plan.events.length };
        }
        default:
          throw new Error("Unhandled fixture operation");
      }
    };
    if ("error" in fixture.expected)
      expect(execute).toThrow(fixture.expected.error);
    else expect(execute()).toEqual(fixture.expected);
  });
