import {
  type FxConversionPolicy,
  type FxConversionResult,
  type FxRateQuote,
  fxCalculationVersion,
  fxConversionPolicySchema,
  fxCurrencySchema,
  fxRateQuoteSchema,
  hasControlCharacters,
} from "@invoxim/contracts";
import { convertFxEntry, type TenantContext } from "@invoxim/core";
import {
  decodeFxValuation,
  fxPolicyHash,
  fxQuoteIdentity,
  fxSnapshotHash,
  mapFxEntry,
  minorBinding,
  type OwnedEntry,
  ownedEntryColumns,
  profileColumns,
  type ValuationRow,
  valuationColumns,
  valuationJoin,
  valuationPolicyBinds,
} from "./period-valuation";
export interface FxValuationKey {
  readonly entryId: string;
  readonly expectedProfileVersion: number;
  readonly reportingCurrency: string;
}
export interface FxValuationWrite extends FxValuationKey {
  readonly expectedEntryVersion: number;
  readonly expectedValuationVersion: number;
  readonly quote: FxRateQuote | null;
}
export type FxValuationRead =
  | { readonly status: "missing" }
  | { readonly status: "pending" }
  | {
      readonly status: "valued";
      readonly valuationVersion: number;
      readonly result: FxConversionResult;
    };
export type FxValuationWriteResult =
  | { readonly status: "stale" }
  | { readonly status: "conflict" }
  | {
      readonly status: "stored";
      readonly valuationVersion: number;
      readonly result: FxConversionResult;
    };
function version(value: number, zero = false): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= (zero ? 0 : 1) &&
    value <= 2147483646
  );
}
function validateKey(input: FxValuationKey): void {
  if (
    !input ||
    typeof input.entryId !== "string" ||
    input.entryId.length < 1 ||
    input.entryId.length > 4096 ||
    hasControlCharacters(input.entryId) ||
    !version(input.expectedProfileVersion) ||
    !fxCurrencySchema.safeParse(input.reportingCurrency).success
  )
    throw new Error("INVALID_FX_INPUT");
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_FX_INPUT")
      throw error;
    throw new Error("FX_STORAGE_UNAVAILABLE");
  }
}
export function createFxValuationRepository(
  db: D1Database,
  options: { policy: FxConversionPolicy; clock?: () => number },
) {
  const parsed = fxConversionPolicySchema.safeParse(options.policy);
  if (!parsed.success) throw new Error("INVALID_FX_INPUT");
  const policy = parsed.data,
    policyHash = fxPolicyHash(policy),
    clock = options.clock ?? Date.now;
  const owned = `SELECT ${ownedEntryColumns()} FROM ledger_entries e JOIN profiles p ON p.user_id=e.user_id WHERE e.user_id=? AND e.id=? AND e.eligible=1 AND p.status='active' AND p.version=? AND p.reporting_currency=?`;
  async function get(
    context: TenantContext,
    input: FxValuationKey,
  ): Promise<FxValuationRead> {
    validateKey(input);
    const row = await db
      .prepare(
        `SELECT ${ownedEntryColumns()},${profileColumns("p")},${valuationColumns} FROM ledger_entries e JOIN profiles p ON p.user_id=e.user_id ${valuationJoin("p")} WHERE e.user_id=? AND e.id=? AND e.eligible=1 AND p.status='active'`,
      )
      .bind(
        ...valuationPolicyBinds(policy, await policyHash),
        context.userId,
        input.entryId,
      )
      .first<ValuationRow>();
    if (!row) return { status: "missing" };
    if (
      row.profile_version !== input.expectedProfileVersion ||
      row.profile_currency !== input.reportingCurrency
    )
      return { status: "pending" };
    if (row.valuation_version === null) return { status: "pending" };
    return decodeFxValuation(row, input.reportingCurrency, policy);
  }
  async function put(
    context: TenantContext,
    input: FxValuationWrite,
  ): Promise<FxValuationWriteResult> {
    validateKey(input);
    if (
      !version(input.expectedEntryVersion) ||
      !version(input.expectedValuationVersion, true) ||
      input.expectedValuationVersion === 2147483646
    )
      throw new Error("INVALID_FX_INPUT");
    const row = await db
      .prepare(`${owned} AND e.version=?`)
      .bind(
        context.userId,
        input.entryId,
        input.expectedProfileVersion,
        input.reportingCurrency,
        input.expectedEntryVersion,
      )
      .first<OwnedEntry>();
    if (!row) return { status: "stale" };
    const result = convertFxEntry(
      mapFxEntry(row),
      input.reportingCurrency,
      input.quote,
      policy,
    );
    const checked = fxRateQuoteSchema.safeParse(input.quote);
    // Persist only selected public quotes related to this owned event. Other unsuitable inputs retain a closed reason, never raw input.
    const quote =
      result.status === "converted"
        ? result.quote
        : checked.success &&
            checked.data.source === policy.source &&
            checked.data.fromCurrency === row.currency &&
            checked.data.toCurrency === input.reportingCurrency &&
            checked.data.requestedDate === row.event_date
          ? checked.data
          : null;
    const rateId = quote ? await fxSnapshotHash(fxQuoteIdentity(quote)) : null;
    const policyKey = await policyHash;
    const keyValues = [
      context.userId,
      input.entryId,
      input.reportingCurrency,
      input.expectedProfileVersion,
      input.expectedEntryVersion,
      fxCalculationVersion,
      policyKey,
    ];
    const keyWhere =
      "user_id=? AND entry_id=? AND reporting_currency=? AND profile_version=? AND entry_version=? AND calculation_version=? AND policy_hash=?";
    const current = await db
      .prepare(`SELECT version FROM entry_valuations WHERE ${keyWhere}`)
      .bind(...keyValues)
      .first<{ version: number }>();
    if ((current?.version ?? 0) !== input.expectedValuationVersion)
      return { status: "conflict" };
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("INVALID_FX_INPUT");
    const guard = `EXISTS(${owned} AND e.version=? AND e.kind=? AND e.amount_minor=? AND e.currency=? AND e.event_date=?) AND COALESCE((SELECT version FROM entry_valuations WHERE ${keyWhere}),0)=?`;
    const guardValues = [
      context.userId,
      input.entryId,
      input.expectedProfileVersion,
      input.reportingCurrency,
      input.expectedEntryVersion,
      row.kind,
      minorBinding(row.amount_minor),
      row.currency,
      row.event_date,
      ...keyValues,
      input.expectedValuationVersion,
    ];
    const statements: D1PreparedStatement[] = [];
    if (quote)
      statements.push(
        db
          .prepare(
            `INSERT INTO fx_rates(id,source,from_currency,to_currency,requested_date,effective_date,rate,retrieved_at,source_version) SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT DO NOTHING`,
          )
          .bind(
            rateId,
            quote.source,
            quote.fromCurrency,
            quote.toCurrency,
            quote.requestedDate,
            quote.effectiveDate,
            quote.rate,
            quote.retrievedAt,
            quote.version,
            ...guardValues,
          ),
      );
    const ratePresent =
      rateId === null ? "1" : "EXISTS(SELECT 1 FROM fx_rates WHERE id=?)";
    statements.push(
      db
        .prepare(
          `INSERT INTO entry_valuations(user_id,entry_id,reporting_currency,profile_version,entry_version,calculation_version,policy_hash,policy_source,max_prior_age_days,original_kind,original_minor,original_currency,original_event_date,status,signed_minor,basis,reason,rate_id,version,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard} AND ${ratePresent} ON CONFLICT(user_id,entry_id,reporting_currency,profile_version,entry_version,calculation_version,policy_hash) DO UPDATE SET status=excluded.status,signed_minor=excluded.signed_minor,basis=excluded.basis,reason=excluded.reason,rate_id=excluded.rate_id,version=excluded.version,updated_at=excluded.updated_at WHERE entry_valuations.version=? RETURNING 1 AS applied`,
        )
        .bind(
          ...keyValues,
          policy.source,
          policy.maxPriorAgeDays,
          row.kind,
          minorBinding(row.amount_minor),
          row.currency,
          row.event_date,
          result.status,
          result.status === "converted" ? result.signedMinor : null,
          result.status === "converted" ? result.basis : null,
          result.status === "unconverted" ? result.reason : null,
          rateId,
          input.expectedValuationVersion + 1,
          now,
          ...guardValues,
          ...(rateId ? [rateId] : []),
          input.expectedValuationVersion,
        ),
    );
    const committed = await db.batch(statements);
    if (committed.at(-1)?.results.length !== 1) {
      const state = await db
        .prepare(`SELECT ${guard} AS live,${ratePresent} AS rate_present`)
        .bind(...guardValues, ...(rateId ? [rateId] : []))
        .first<{ live: number; rate_present: number }>();
      return {
        status:
          state?.live === 1 && state.rate_present === 0 ? "conflict" : "stale",
      };
    }
    const value = await get(context, input);
    return value.status === "valued"
      ? {
          status: "stored",
          valuationVersion: value.valuationVersion,
          result: value.result,
        }
      : { status: "stale" };
  }
  return {
    get: (context: TenantContext, input: FxValuationKey) =>
      safe(() => get(context, input)),
    put: (context: TenantContext, input: FxValuationWrite) =>
      safe(() => put(context, input)),
  };
}
