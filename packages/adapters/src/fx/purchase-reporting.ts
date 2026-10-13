import type {
  FxConversionPolicy,
  FxEntry,
  FxPeriodSummary,
} from "@invoxim/contracts";
import {
  fxCalculationVersion,
  fxConversionPolicySchema,
  fxCurrencySchema,
  fxEntrySchema,
  fxPeriodSummarySchema,
  purchaseFiltersSchema,
  purchaseViewSchema,
} from "@invoxim/contracts";
import type { TenantContext } from "@invoxim/core";
import { z } from "zod";
import { conditions, matchesPeriod } from "../purchase-views";
import type { FxReportReadSnapshot } from "./period";
import {
  decodeFxValuation,
  fxSnapshotHash,
  type ValuationRow,
} from "./period-valuation";
import type { FxValuationRead } from "./repository";

export interface FxPurchaseReportingEntry {
  purchaseId: string;
  entry: FxEntry;
  entryVersion: number;
  valuation: FxValuationRead;
}
export interface FxPurchaseReportingResult {
  purchases: Array<{ purchaseId: string; summary: FxPeriodSummary }>;
  entries: FxPurchaseReportingEntry[];
  /** Selected purchases only; a period total requires a complete export selection. */
  summary: FxPeriodSummary;
}
interface Accumulator {
  paid: bigint;
  refunded: bigint;
  converted: bigint;
  pending: bigint;
  unconverted: bigint;
  reasons: FxPeriodSummary["reasons"];
}
function accumulator(): Accumulator {
  return {
    paid: 0n,
    refunded: 0n,
    converted: 0n,
    pending: 0n,
    unconverted: 0n,
    reasons: {},
  };
}
function include(sum: Accumulator, valuation: FxValuationRead): void {
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
function summary(sum: Accumulator): FxPeriodSummary {
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
const idsSchema = z.array(purchaseViewSchema.shape.id).max(500);
/** Requires an internal beginRead snapshot and a caller-owned final assertion. */
export function createFxPurchaseReportingReader(
  db: D1Database,
  options: { policy: FxConversionPolicy },
) {
  const checkedPolicy = fxConversionPolicySchema.safeParse(options.policy);
  if (!checkedPolicy.success) throw new Error("INVALID_FX_INPUT");
  const policy = checkedPolicy.data;
  const policyHash = fxSnapshotHash([
    policy.source,
    policy.maxPriorAgeDays,
    fxCalculationVersion,
  ]);
  async function read(
    context: TenantContext,
    snapshot: FxReportReadSnapshot,
    purchaseIds: readonly string[],
  ): Promise<FxPurchaseReportingResult> {
    const checkedIds = idsSchema.safeParse(purchaseIds);
    const currency = fxCurrencySchema.safeParse(snapshot?.reportingCurrency);
    const checkedFilters = purchaseFiltersSchema.safeParse(snapshot?.filters);
    if (!checkedIds.success || !currency.success || !checkedFilters.success)
      throw new Error("INVALID_FX_INPUT");
    const ids = checkedIds.data;
    if (new Set(ids).size !== ids.length) throw new Error("INVALID_FX_INPUT");
    const filters = checkedFilters.data;
    const where = conditions(context, filters);
    const rows = (
      await db
        .prepare(
          `SELECT e.purchase_id AS purchaseId,e.id,e.kind,CAST(e.amount_minor AS TEXT) AS amount_minor,e.currency,e.event_date,e.version,profile.version AS profile_version,profile.reporting_currency AS profile_currency,v.version AS valuation_version,v.status,v.signed_minor,v.basis,v.reason,v.rate_id,r.source,r.from_currency,r.to_currency,r.requested_date,r.effective_date,r.rate,r.retrieved_at,r.source_version FROM ledger_entries e JOIN purchases p ON p.user_id=e.user_id AND p.id=e.purchase_id JOIN profiles profile ON profile.user_id=e.user_id LEFT JOIN entry_valuations v ON v.user_id=e.user_id AND v.entry_id=e.id AND v.profile_version=profile.version AND v.entry_version=e.version AND v.reporting_currency=profile.reporting_currency AND v.calculation_version=? AND v.policy_hash=? AND v.policy_source=? AND v.max_prior_age_days=? AND v.original_kind=e.kind AND v.original_minor=e.amount_minor AND v.original_currency=e.currency AND v.original_event_date=e.event_date LEFT JOIN fx_rates r ON r.id=v.rate_id WHERE ${where.sql} AND profile.reporting_currency=? AND p.id IN (SELECT value FROM json_each(?)) AND e.eligible=1 AND e.event_date BETWEEN ? AND ?${filters.currency ? " AND e.currency=?" : ""} ORDER BY e.id LIMIT 2001`,
        )
        .bind(
          fxCalculationVersion,
          await policyHash,
          policy.source,
          policy.maxPriorAgeDays,
          ...where.values,
          currency.data,
          JSON.stringify(ids),
          filters.from ?? "0001-01-01",
          filters.to ?? "9999-12-31",
          ...(filters.currency ? [filters.currency] : []),
        )
        .all<ValuationRow & { purchaseId: string }>()
    ).results;
    // Admission precedes decoding/reduction: never publish a truncated subtotal.
    if (rows.length > 2000) throw new Error("FX_REPORT_READ_LIMIT");
    const sums = new Map(ids.map((id) => [id, accumulator()]));
    const total = accumulator();
    const entries: FxPurchaseReportingEntry[] = [];
    for (const row of rows) {
      const owned = sums.get(row.purchaseId);
      if (!owned) throw new Error("FX_REPORT_UNAVAILABLE");
      const entry = fxEntrySchema.parse({
        id: row.id,
        kind: row.kind,
        amountMinor: row.amount_minor,
        currency: row.currency,
        eventDate: row.event_date,
      });
      const entryVersion = z.number().int().positive().parse(row.version);
      if (
        !matchesPeriod(
          { date: entry.eventDate, currency: entry.currency },
          filters,
        )
      )
        throw new Error("FX_REPORT_UNAVAILABLE");
      const valuation = await decodeFxValuation(row, currency.data, policy);
      include(owned, valuation);
      include(total, valuation);
      entries.push({
        purchaseId: row.purchaseId,
        entry,
        entryVersion,
        valuation,
      });
    }
    return {
      purchases: ids.map((id) => ({
        purchaseId: id,
        summary: summary(sums.get(id) ?? accumulator()),
      })),
      entries,
      summary: summary(total),
    };
  }
  return {
    async read(
      context: TenantContext,
      snapshot: FxReportReadSnapshot,
      purchaseIds: readonly string[],
    ): Promise<FxPurchaseReportingResult> {
      try {
        return await read(context, snapshot, purchaseIds);
      } catch (error) {
        if (
          error instanceof Error &&
          ["INVALID_FX_INPUT", "FX_REPORT_READ_LIMIT"].includes(error.message)
        )
          throw error;
        throw new Error("FX_REPORT_UNAVAILABLE");
      }
    },
  };
}
