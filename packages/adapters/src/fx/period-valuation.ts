import {
  type FxConversionPolicy,
  type FxEntry,
  type FxRateQuote,
  fxCalculationVersion,
  fxConversionResultSchema,
  fxRateQuoteSchema,
} from "@invoxim/contracts";
import { convertFxEntry } from "@invoxim/core";
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
function entry(row: OwnedEntry): FxEntry {
  return {
    id: row.id,
    kind: row.kind,
    amountMinor: row.amount_minor,
    currency: row.currency,
    eventDate: row.event_date,
  };
}
export async function fxSnapshotHash(value: unknown): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
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
          entry: entry(row),
          reportingCurrency: reportingCurrency,
          reason: row.reason,
          calculationVersion: fxCalculationVersion,
        }
      : convertFxEntry(entry(row), reportingCurrency, quote, policy),
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
