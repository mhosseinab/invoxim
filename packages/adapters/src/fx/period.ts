import {
  type FxConversionPolicy,
  type FxPeriodSummary,
  fxCalculationVersion,
  fxConversionPolicySchema,
  fxPeriodSummarySchema,
  hasControlCharacters,
  type PurchaseFilters,
  purchaseFiltersSchema,
} from "@invoxim/contracts";
import type { TenantContext } from "@invoxim/core";
import { z } from "zod";
import { conditions } from "../purchase-views";
import {
  decodeFxValuation,
  fxSnapshotHash,
  type ValuationRow,
} from "./period-valuation";

/** Root implements purpose-specific authenticated tokens with its existing auth secret. */
export interface FxPeriodSigning {
  sign(payload: string): Promise<string>;
  verify(token: string): Promise<string | null>;
}
export interface FxPeriodInput {
  filters: PurchaseFilters;
  /** Trusted current session binding supplied by composition, never request authority. */
  actorKey: string;
  continuation?: string;
  stamp?: string;
}
/** Internal fence only: callers must never treat these fields as authority. */
export interface FxReportReadSnapshot {
  readonly stamp: string;
  readonly reportingCurrency: string;
  readonly filters: PurchaseFilters;
  readonly actorKey: string;
}
export interface FxReportReadInput {
  filters: PurchaseFilters;
  actorKey: string;
  stamp: string;
}
export type FxReportReadResult =
  | { status: "stale" }
  | { status: "current"; snapshot: FxReportReadSnapshot };
export type { FxPeriodSummary } from "@invoxim/contracts";
export type FxPeriodResult =
  | { status: "stale" }
  | { status: "in_progress"; stamp: string; continuation: string }
  | {
      status: "complete";
      stamp: string;
      summaryScope: "period";
      reportingCurrency: string;
      summary: FxPeriodSummary;
    };
const identifier = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !hasControlCharacters(v));
const token = z.string().min(1).max(16384);
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(100);
const profileSchema = z.strictObject({
  version: z.number().int().min(1).max(2147483646),
  currency: z.string().regex(/^[A-Z]{3}$/),
  timezone: z.string().min(1).max(120),
  revision: decimal.refine(
    (v) => BigInt(v) > 0n && BigInt(v) <= 9007199254740991n,
  ),
});
const stampSchema = z.strictObject({
  purpose: z.literal("fx-period-stamp-v1"),
  tenant: identifier,
  actor: identifier,
  filters: purchaseFiltersSchema,
  profile: profileSchema,
  policy: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const summarySchema = fxPeriodSummarySchema;
const continuationSchema = z.strictObject({
  purpose: z.literal("fx-period-continuation-v1"),
  stamp: token,
  after: identifier,
  summary: summarySchema,
});
const inputSchema = z.strictObject({
  filters: purchaseFiltersSchema,
  actorKey: identifier,
  stamp: token.optional(),
  continuation: token.optional(),
});
const reportReadInputSchema = z.strictObject({
  filters: purchaseFiltersSchema,
  actorKey: identifier,
  stamp: token,
});
const reportReadSnapshotSchema = z.strictObject({
  ...reportReadInputSchema.shape,
  reportingCurrency: profileSchema.shape.currency,
});
function canonicalFilters(filters: PurchaseFilters): PurchaseFilters {
  return Object.fromEntries(
    Object.entries(filters)
      .filter(([, v]) => v !== undefined && v !== "")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
function emptySummary(): FxPeriodSummary {
  return {
    paidMinor: "0",
    refundedMinor: "0",
    netMinor: "0",
    convertedCount: "0",
    pendingCount: "0",
    unconvertedCount: "0",
    reasons: {},
  };
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function createFxPeriodService(
  db: D1Database,
  options: {
    policy: FxConversionPolicy;
    signing: FxPeriodSigning;
    remainingStatements: () => number;
    clock?: () => number;
  },
) {
  const policy = fxConversionPolicySchema.parse(options.policy);
  const policyHash = fxSnapshotHash([
    policy.source,
    policy.maxPriorAgeDays,
    fxCalculationVersion,
  ]);
  const clock = options.clock ?? Date.now;
  async function profile(context: TenantContext) {
    const row = await db
      .prepare(
        "SELECT version,reporting_currency AS currency,timezone,CAST(reporting_revision AS TEXT) AS revision FROM profiles WHERE user_id=? AND status='active'",
      )
      .bind(context.userId)
      .first();
    return row ? profileSchema.parse(row) : null;
  }
  async function unpack<T>(value: string, schema: z.ZodType<T>): Promise<T> {
    try {
      const payload = await options.signing.verify(token.parse(value));
      if (payload === null || payload.length > 12288) throw new Error();
      return schema.parse(JSON.parse(payload));
    } catch {
      throw new Error("INVALID_FX_INPUT");
    }
  }
  async function pack(value: unknown) {
    const payload = JSON.stringify(value);
    if (payload.length > 12288) throw new Error("INVALID_FX_INPUT");
    return token.parse(await options.signing.sign(payload));
  }
  function currentTime(): number {
    const now = clock();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - 900000
    )
      throw new Error("INVALID_FX_INPUT");
    return now;
  }
  async function validateStamp(
    context: TenantContext,
    filters: PurchaseFilters,
    actorKey: string,
    stamp: string | undefined,
    now: number,
  ) {
    const expected = stamp ? await unpack(stamp, stampSchema) : null;
    const key = await policyHash;
    if (
      expected &&
      (expected.tenant !== context.userId ||
        expected.actor !== actorKey ||
        !same(canonicalFilters(expected.filters), filters) ||
        expected.policy !== key ||
        expected.expiresAt <= now)
    )
      throw new Error("INVALID_FX_INPUT");
    return { expected, key };
  }
  async function beginRead(
    context: TenantContext,
    value: FxReportReadInput,
  ): Promise<FxReportReadResult> {
    const checked = reportReadInputSchema.safeParse(value);
    if (!checked.success) throw new Error("INVALID_FX_INPUT");
    const input = checked.data;
    const filters = canonicalFilters(input.filters);
    const { expected } = await validateStamp(
      context,
      filters,
      input.actorKey,
      input.stamp,
      currentTime(),
    );
    if (!expected) throw new Error("INVALID_FX_INPUT");
    if (options.remainingStatements() < 1)
      throw new Error("FX_PERIOD_READ_LIMIT");
    const current = await profile(context);
    if (!current || !same(expected.profile, current))
      return { status: "stale" };
    return {
      status: "current",
      snapshot: {
        stamp: input.stamp,
        reportingCurrency: expected.profile.currency,
        filters: canonicalFilters(expected.filters),
        actorKey: expected.actor,
      },
    };
  }
  async function assertCurrent(
    context: TenantContext,
    value: FxReportReadSnapshot,
  ): Promise<boolean> {
    const checked = reportReadSnapshotSchema.safeParse(value);
    if (!checked.success) throw new Error("INVALID_FX_INPUT");
    const snapshot = checked.data;
    const { expected } = await validateStamp(
      context,
      canonicalFilters(snapshot.filters),
      snapshot.actorKey,
      snapshot.stamp,
      currentTime(),
    );
    if (!expected || snapshot.reportingCurrency !== expected.profile.currency)
      throw new Error("INVALID_FX_INPUT");
    if (options.remainingStatements() < 1)
      throw new Error("FX_PERIOD_READ_LIMIT");
    const current = await profile(context);
    return current !== null && same(expected.profile, current);
  }
  function rethrow(error: unknown): never {
    if (
      error instanceof Error &&
      ["INVALID_FX_INPUT", "FX_PERIOD_READ_LIMIT"].includes(error.message)
    )
      throw error;
    throw new Error("FX_PERIOD_UNAVAILABLE");
  }
  async function read(
    context: TenantContext,
    value: FxPeriodInput,
  ): Promise<FxPeriodResult> {
    const checked = inputSchema.safeParse(value);
    if (!checked.success) throw new Error("INVALID_FX_INPUT");
    const input = checked.data,
      filters = canonicalFilters(input.filters),
      now = currentTime();
    let state = emptySummary(),
      after = "",
      stamp = input.stamp;
    if (input.continuation) {
      const continuation = await unpack(input.continuation, continuationSchema);
      if (stamp && stamp !== continuation.stamp)
        throw new Error("INVALID_FX_INPUT");
      stamp = continuation.stamp;
      state = continuation.summary;
      after = continuation.after;
    }
    const { expected, key } = await validateStamp(
      context,
      filters,
      input.actorKey,
      stamp,
      now,
    );
    if (options.remainingStatements() < 3)
      throw new Error("FX_PERIOD_READ_LIMIT");
    const initial = await profile(context);
    if (!initial || (expected && !same(expected.profile, initial)))
      return { status: "stale" };
    const reportStamp =
      stamp ??
      (await pack({
        purpose: "fx-period-stamp-v1",
        tenant: context.userId,
        actor: input.actorKey,
        filters,
        profile: initial,
        policy: key,
        expiresAt: now + 900000,
      }));
    const where = conditions(context, filters);
    let complete = false;
    // At most 512 events and two bulk reads per invocation, with a final fence reserved.
    for (
      let chunk = 0;
      chunk < 2 && options.remainingStatements() > 1;
      chunk++
    ) {
      const rows = (
        await db
          .prepare(
            `SELECT e.id,e.kind,CAST(e.amount_minor AS TEXT) AS amount_minor,e.currency,e.event_date,e.version,profile.version AS profile_version,profile.reporting_currency AS profile_currency,v.version AS valuation_version,v.status,v.signed_minor,v.basis,v.reason,v.rate_id,r.source,r.from_currency,r.to_currency,r.requested_date,r.effective_date,r.rate,r.retrieved_at,r.source_version FROM ledger_entries e JOIN purchases p ON p.user_id=e.user_id AND p.id=e.purchase_id JOIN profiles profile ON profile.user_id=e.user_id LEFT JOIN entry_valuations v ON v.user_id=e.user_id AND v.entry_id=e.id AND v.profile_version=profile.version AND v.entry_version=e.version AND v.reporting_currency=profile.reporting_currency AND v.calculation_version=? AND v.policy_hash=? AND v.policy_source=? AND v.max_prior_age_days=? AND v.original_kind=e.kind AND v.original_minor=e.amount_minor AND v.original_currency=e.currency AND v.original_event_date=e.event_date LEFT JOIN fx_rates r ON r.id=v.rate_id WHERE ${where.sql} AND e.eligible=1 AND e.id>? AND e.event_date BETWEEN ? AND ?${filters.currency ? " AND e.currency=?" : ""} ORDER BY e.id LIMIT 256`,
          )
          .bind(
            fxCalculationVersion,
            key,
            policy.source,
            policy.maxPriorAgeDays,
            ...where.values,
            after,
            filters.from ?? "0001-01-01",
            filters.to ?? "9999-12-31",
            ...(filters.currency ? [filters.currency] : []),
          )
          .all<ValuationRow>()
      ).results;
      const values = await Promise.all(
        rows.map((row) => decodeFxValuation(row, initial.currency, policy)),
      );
      let paid = BigInt(state.paidMinor),
        refunded = BigInt(state.refundedMinor),
        converted = BigInt(state.convertedCount),
        pending = BigInt(state.pendingCount),
        unconverted = BigInt(state.unconvertedCount);
      const reasons = { ...state.reasons };
      for (const valuation of values) {
        if (valuation.status !== "valued") {
          pending++;
          continue;
        }
        if (valuation.result.status === "unconverted") {
          unconverted++;
          const reason = valuation.result.reason;
          reasons[reason] = (BigInt(reasons[reason] ?? "0") + 1n).toString();
          continue;
        }
        converted++;
        const minor = BigInt(valuation.result.signedMinor);
        if (valuation.result.entry.kind === "payment") paid += minor;
        else refunded -= minor;
      }
      state = summarySchema.parse({
        paidMinor: paid.toString(),
        refundedMinor: refunded.toString(),
        netMinor: (paid - refunded).toString(),
        convertedCount: converted.toString(),
        pendingCount: pending.toString(),
        unconvertedCount: unconverted.toString(),
        reasons,
      });
      const last = rows.at(-1);
      if (last) after = last.id;
      if (rows.length < 256) {
        complete = true;
        break;
      }
    }
    const final = await profile(context);
    if (!final || !same(initial, final)) return { status: "stale" };
    if (complete)
      return {
        status: "complete",
        stamp: reportStamp,
        summaryScope: "period",
        reportingCurrency: initial.currency,
        summary: state,
      };
    if (!after) throw new Error("FX_PERIOD_READ_LIMIT");
    return {
      status: "in_progress",
      stamp: reportStamp,
      continuation: await pack({
        purpose: "fx-period-continuation-v1",
        stamp: reportStamp,
        after,
        summary: state,
      }),
    };
  }
  return {
    async read(
      context: TenantContext,
      input: FxPeriodInput,
    ): Promise<FxPeriodResult> {
      try {
        return await read(context, input);
      } catch (error) {
        rethrow(error);
      }
    },
    async beginRead(
      context: TenantContext,
      input: FxReportReadInput,
    ): Promise<FxReportReadResult> {
      try {
        return await beginRead(context, input);
      } catch (error) {
        rethrow(error);
      }
    },
    async assertCurrent(
      context: TenantContext,
      snapshot: FxReportReadSnapshot,
    ): Promise<boolean> {
      try {
        return await assertCurrent(context, snapshot);
      } catch (error) {
        rethrow(error);
      }
    },
  };
}
