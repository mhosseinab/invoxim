import {
  type FxConversionPolicy,
  type FxEntry,
  type FxPeriodSummary,
  type FxRateQuote,
  fxCalculationVersion,
  fxConversionResultSchema,
  fxEntrySchema,
  fxPeriodSummarySchema,
  fxRateQuoteSchema,
} from "@invoxim/contracts";
import { convertFxEntry, ENTRY_MINOR_BOUND } from "@invoxim/core";
import { hashJsonValue } from "../hash";
import type { FxValuationRead } from "./repository";
export interface OwnedEntry {
  id: string;
  kind: "payment" | "refund";
  amount_minor: string;
  currency: string;
  event_date: string;
  version: number;
}
export interface ValuationRow extends OwnedEntry {
  profile_version: number;
  profile_currency: string;
  valuation_version: number | null;
  status: "converted" | "unconverted" | null;
  signed_minor: string | null;
  basis: "identity" | "reference" | null;
  reason: string | null;
  rate_id: string | null;
  source: string | null;
  from_currency: string | null;
  to_currency: string | null;
  requested_date: string | null;
  effective_date: string | null;
  rate: string | null;
  retrieved_at: number | null;
  source_version: string | null;
}
/** Single ledger-entry row mapper for every FX valuation read (C12). */
export function mapFxEntry(row: OwnedEntry): FxEntry {
  return {
    id: row.id,
    kind: row.kind,
    amountMinor: row.amount_minor,
    currency: row.currency,
    eventDate: row.event_date,
  };
}
/** Map and Zod-validate a D1 ledger-entry row at the service boundary (PIPE-8). */
export function parseFxEntry(row: OwnedEntry): FxEntry {
  return fxEntrySchema.parse(mapFxEntry(row));
}
/** Bind a text minor-unit amount to the integer original_minor column. */
export function minorBinding(value: string): number {
  const minor = Number(value);
  if (
    !Number.isSafeInteger(minor) ||
    minor < 0 ||
    BigInt(minor) > ENTRY_MINOR_BOUND
  )
    throw new Error("INVALID_FX_INPUT");
  return minor;
}
/** One policy-hash recipe for every valuation read and write (C4). */
export function fxPolicyHash(policy: FxConversionPolicy): Promise<string> {
  return fxSnapshotHash([
    policy.source,
    policy.maxPriorAgeDays,
    fxCalculationVersion,
  ]);
}
/** Bind values matching `valuationJoin`'s four placeholders. */
export function valuationPolicyBinds(
  policy: FxConversionPolicy,
  key: string,
): [string, string, string, number] {
  return [fxCalculationVersion, key, policy.source, policy.maxPriorAgeDays];
}
export function ownedEntryColumns(entryAlias = "e"): string {
  return `${entryAlias}.id,${entryAlias}.kind,CAST(${entryAlias}.amount_minor AS TEXT) AS amount_minor,${entryAlias}.currency,${entryAlias}.event_date,${entryAlias}.version`;
}
export function profileColumns(profileAlias: string): string {
  return `${profileAlias}.version AS profile_version,${profileAlias}.reporting_currency AS profile_currency`;
}
export const valuationColumns =
  "v.version AS valuation_version,v.status,v.signed_minor,v.basis,v.reason,v.rate_id,r.source,r.from_currency,r.to_currency,r.requested_date,r.effective_date,r.rate,r.retrieved_at,r.source_version";
/**
 * One valuation JOIN for every FX read (C4, ext#14). The four `?` placeholders
 * bind `valuationPolicyBinds(policy, key)` in the same order.
 */
export function valuationJoin(profileAlias: string, entryAlias = "e"): string {
  return `LEFT JOIN entry_valuations v ON v.user_id=${entryAlias}.user_id AND v.entry_id=${entryAlias}.id AND v.profile_version=${profileAlias}.version AND v.entry_version=${entryAlias}.version AND v.reporting_currency=${profileAlias}.reporting_currency AND v.calculation_version=? AND v.policy_hash=? AND v.policy_source=? AND v.max_prior_age_days=? AND v.original_kind=${entryAlias}.kind AND v.original_minor=${entryAlias}.amount_minor AND v.original_currency=${entryAlias}.currency AND v.original_event_date=${entryAlias}.event_date LEFT JOIN fx_rates r ON r.id=v.rate_id`;
}
export async function fxSnapshotHash(value: unknown): Promise<string> {
  return hashJsonValue(value);
}
export function fxQuoteIdentity(quote: FxRateQuote): unknown[] {
  return [
    quote.source,
    quote.fromCurrency,
    quote.toCurrency,
    quote.requestedDate,
    quote.effectiveDate,
    quote.rate,
    quote.version,
  ];
}
export async function decodeFxValuation(
  row: ValuationRow,
  reportingCurrency: string,
  policy: FxConversionPolicy,
): Promise<FxValuationRead> {
  if (row.valuation_version === null) return { status: "pending" };
  let quote: FxRateQuote | null = null;
  if (row.rate_id !== null) {
    const q = fxRateQuoteSchema.safeParse({
      source: row.source,
      fromCurrency: row.from_currency,
      toCurrency: row.to_currency,
      requestedDate: row.requested_date,
      effectiveDate: row.effective_date,
      rate: row.rate,
      version: row.source_version,
      retrievedAt: row.retrieved_at,
    });
    if (!q.success) throw new Error("CORRUPT_FX_VALUATION");
    quote = q.data;
    if ((await fxSnapshotHash(fxQuoteIdentity(quote))) !== row.rate_id)
      throw new Error("CORRUPT_FX_VALUATION");
  }
  const persisted = fxConversionResultSchema.safeParse(
    row.status === "unconverted" && quote === null
      ? {
          status: "unconverted",
          entry: mapFxEntry(row),
          reportingCurrency: reportingCurrency,
          reason: row.reason,
          calculationVersion: fxCalculationVersion,
        }
      : convertFxEntry(mapFxEntry(row), reportingCurrency, quote, policy),
  );
  if (!persisted.success) throw new Error("CORRUPT_FX_VALUATION");
  const result = persisted.data;
  if (
    result.status !== row.status ||
    (result.status === "converted" &&
      (result.signedMinor !== row.signed_minor ||
        result.basis !== row.basis)) ||
    (result.status === "unconverted" && result.reason !== row.reason)
  )
    throw new Error("CORRUPT_FX_VALUATION");
  return {
    status: "valued",
    valuationVersion: row.valuation_version,
    result,
  };
}

export interface PeriodTotals {
  paid: bigint;
  refunded: bigint;
  converted: bigint;
  pending: bigint;
  unconverted: bigint;
  reasons: Record<string, string>;
}
/** One period-totals reducer for every FX period export (C3). */
export function emptyPeriodTotals(): PeriodTotals {
  return {
    paid: 0n,
    refunded: 0n,
    converted: 0n,
    pending: 0n,
    unconverted: 0n,
    reasons: {},
  };
}
export function periodTotalsFromSummary(
  summary: FxPeriodSummary,
): PeriodTotals {
  return {
    paid: BigInt(summary.paidMinor),
    refunded: BigInt(summary.refundedMinor),
    converted: BigInt(summary.convertedCount),
    pending: BigInt(summary.pendingCount),
    unconverted: BigInt(summary.unconvertedCount),
    reasons: { ...summary.reasons },
  };
}
export function includePeriodValuation(
  sum: PeriodTotals,
  valuation: FxValuationRead,
): void {
  if (valuation.status !== "valued") {
    sum.pending++;
    return;
  }
  const result = valuation.result;
  if (result.status === "unconverted") {
    sum.unconverted++;
    sum.reasons[result.reason] = (
      BigInt(sum.reasons[result.reason] ?? "0") + 1n
    ).toString();
    return;
  }
  sum.converted++;
  const minor = BigInt(result.signedMinor);
  if (result.entry.kind === "payment") sum.paid += minor;
  else sum.refunded -= minor;
}
export function finalizePeriodTotals(sum: PeriodTotals): FxPeriodSummary {
  return fxPeriodSummarySchema.parse({
    paidMinor: sum.paid.toString(),
    refundedMinor: sum.refunded.toString(),
    netMinor: (sum.paid - sum.refunded).toString(),
    convertedCount: sum.converted.toString(),
    pendingCount: sum.pending.toString(),
    unconvertedCount: sum.unconverted.toString(),
    reasons: sum.reasons,
  });
}
