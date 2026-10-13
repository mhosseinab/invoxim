import { expect, it } from "vitest";
import fixtures from "../../../test-design/financial-cases.json";
import type { VerifiedFinancialFact } from "../src/index";
import {
  annualEstimate,
  convertMinor,
  financialEntries,
  formatMinor,
  historicalRateDate,
  ledgerTotals,
  monthlyAnchor,
  parseMoney,
  priceChange,
} from "../src/index";
import { requireFixture } from "./fixture-value";

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
  documentType?: VerifiedFinancialFact["documentType"];
  totalMinor?: string;
  paymentEvidence?: VerifiedFinancialFact["paymentEvidence"];
  refundEvidence?: VerifiedFinancialFact["refundEvidence"];
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
        case "annual-estimate":
          return {
            annualMinor: annualEstimate(
              BigInt(requireFixture(input.monthlyMinor)),
            ).toString(),
          };
        case "price-change":
          return priceChange(
            BigInt(requireFixture(input.previousMinor)),
            BigInt(requireFixture(input.nextMinor)),
          );
        case "select-historical-rate":
          return {
            rateDate: historicalRateDate(
              requireFixture(input.eventDate),
              requireFixture(input.availableDates),
              requireFixture(input.maxPriorAgeDays),
            ),
          };
        case "monthly-anchor":
          return {
            dates: requireFixture(input.months).map((month) =>
              monthlyAnchor(month, requireFixture(input.anchorDay)),
            ),
          };
        case "financial-inclusion":
          return {
            ledgerEntries: financialEntries({
              verified: true,
              documentType: requireFixture(input.documentType),
              total: formatMinor(requireFixture(input.totalMinor), "EUR"),
              currency: "EUR",
              date: "2026-01-01",
              paymentEvidence: input.paymentEvidence ?? "unknown",
              refundEvidence: input.refundEvidence ?? "none",
              paymentAmount: null,
              refundAmount: null,
              paymentMethodHint: "unknown",
            }).entries.length,
          };
        default:
          throw new Error("Unhandled fixture operation");
      }
    };
    if ("error" in fixture.expected)
      expect(execute).toThrow(fixture.expected.error);
    else expect(execute()).toEqual(fixture.expected);
  });
