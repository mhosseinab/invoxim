import {
  type FxConversionPolicy,
  type FxConversionResult,
  type FxConversionSummary,
  type FxEntry,
  type FxRateQuote,
  type FxUnconvertedReason,
  fxCalculationVersion,
  fxConversionPolicySchema,
  fxConversionResultSchema,
  fxConversionSummarySchema,
  fxCurrencySchema,
  fxEntrySchema,
  fxMaxConvertedMinor,
  fxRateQuoteSchema,
  minorDigits,
} from "@invoxim/contracts";
import { convertMinor } from "../money-conversion";
import { FxInputError } from "./types";

function signedMagnitude(entry: FxEntry): bigint {
  return BigInt(entry.amountMinor) * (entry.kind === "refund" ? -1n : 1n);
}

function referenceMinor(
  entry: FxEntry,
  target: string,
  quote: FxRateQuote,
): bigint {
  return convertMinor(
    signedMagnitude(entry),
    minorDigits(entry.currency),
    minorDigits(target),
    quote.rate,
  );
}

/** A supplied quote is a snapshot, never a destination or a fallback instruction. */
export function convertFxEntry(
  input: FxEntry,
  target: string,
  supplied: FxRateQuote | null,
  inputPolicy: FxConversionPolicy,
): FxConversionResult {
  const parsed = fxEntrySchema.safeParse(input);
  const policy = fxConversionPolicySchema.safeParse(inputPolicy);
  if (
    !parsed.success ||
    !policy.success ||
    !fxCurrencySchema.safeParse(target).success
  )
    throw new FxInputError();
  const entry = parsed.data;
  const unconverted = (reason: FxUnconvertedReason): FxConversionResult => ({
    status: "unconverted",
    entry,
    reportingCurrency: target,
    reason,
    calculationVersion: fxCalculationVersion,
  });
  try {
    minorDigits(entry.currency);
    minorDigits(target);
  } catch {
    return unconverted("currency_unsupported");
  }
  if (entry.currency === target)
    return {
      status: "converted",
      entry,
      reportingCurrency: target,
      signedMinor: signedMagnitude(entry).toString(),
      calculationVersion: fxCalculationVersion,
      basis: "identity",
      quote: null,
    };
  if (supplied === null) return unconverted("rate_missing");
  const parsedQuote = fxRateQuoteSchema.safeParse(supplied);
  if (!parsedQuote.success) return unconverted("invalid_quote");
  const quote = parsedQuote.data;
  if (
    quote.fromCurrency !== entry.currency ||
    quote.toCurrency !== target ||
    quote.requestedDate !== entry.eventDate
  )
    return unconverted("quote_mismatch");
  if (quote.source !== policy.data.source)
    return unconverted("source_mismatch");
  if (quote.effectiveDate > entry.eventDate) return unconverted("rate_future");
  // Explicit ISO UTC strings preserve Gregorian years 0001..0099, unlike Date.UTC(year,...).
  const ageDays =
    (Date.parse(`${entry.eventDate}T00:00:00.000Z`) -
      Date.parse(`${quote.effectiveDate}T00:00:00.000Z`)) /
    86400000;
  if (ageDays > policy.data.maxPriorAgeDays) return unconverted("rate_stale");
  const minor = referenceMinor(entry, target, quote);
  const bound = BigInt(fxMaxConvertedMinor);
  if (minor > bound || minor < -bound) return unconverted("magnitude_overflow");
  return {
    status: "converted",
    entry,
    reportingCurrency: target,
    signedMinor: minor.toString(),
    calculationVersion: fxCalculationVersion,
    basis: "reference",
    quote,
  };
}

/** Sum already-rounded valuations. Repeated entry IDs never double-count. */
export function sumFxConversions(
  target: string,
  inputs: readonly FxConversionResult[],
): FxConversionSummary {
  if (!fxCurrencySchema.safeParse(target).success || inputs.length > 1000)
    throw new FxInputError();
  const ids = new Set<string>();
  const unconverted: Extract<FxConversionResult, { status: "unconverted" }>[] =
    [];
  let total = 0n;
  let convertedCount = 0;
  for (const input of inputs) {
    const parsed = fxConversionResultSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.reportingCurrency !== target ||
      ids.has(parsed.data.entry.id)
    )
      throw new FxInputError();
    const result = parsed.data;
    ids.add(result.entry.id);
    if (result.status === "unconverted") {
      unconverted.push(result);
      continue;
    }
    if (
      result.basis === "reference" &&
      result.quote &&
      referenceMinor(result.entry, target, result.quote).toString() !==
        result.signedMinor
    )
      throw new FxInputError();
    total += BigInt(result.signedMinor);
    convertedCount++;
  }
  return fxConversionSummarySchema.parse({
    reportingCurrency: target,
    signedMinor: total.toString(),
    convertedCount,
    unconverted,
    calculationVersion: fxCalculationVersion,
  });
}
