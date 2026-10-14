import {
  type FxConversionPolicy,
  type FxConversionResult,
  type FxConversionSummary,
  type FxEntry,
  type FxRateQuote,
  fxCalculationVersion,
  fxConversionPolicySchema,
  fxCurrencySchema,
  fxRateQuoteSchema,
  hasControlCharacters,
  validCalendarDate,
} from "@invoxim/contracts";
import {
  fxRateAgeDays,
  type PublicReferenceRateReader,
  sumFxConversions,
  type TenantContext,
} from "@invoxim/core";
import { z } from "zod";
import {
  mapFxEntry,
  type OwnedEntry,
  ownedEntryColumns,
} from "./period-valuation";
import { createFxValuationRepository } from "./repository";

const identifier = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !hasControlCharacters(value));
const inputSchema = z
  .strictObject({
    expectedProfileVersion: z.number().int().min(1).max(2147483646),
    reportingCurrency: fxCurrencySchema,
    fromDate: z.string().refine(validCalendarDate),
    toDate: z.string().refine(validCalendarDate),
    purchaseId: identifier.optional(),
    cursor: z.string().min(1).max(32768).optional(),
    limit: z.number().int().min(1).max(20),
  })
  .refine((input) => input.fromDate <= input.toDate);
const cursorSchema = z.strictObject({
  entryId: identifier,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export interface FxReportingPageInput {
  expectedProfileVersion: number;
  reportingCurrency: string;
  fromDate: string;
  toDate: string;
  purchaseId?: string;
  cursor?: string;
  limit: number;
}
export type FxReportingRow =
  | { status: "pending"; entry: FxEntry; entryVersion: number }
  | {
      status: "valued";
      entry: FxEntry;
      entryVersion: number;
      result: FxConversionResult;
    };
export type FxReportingPage =
  | { status: "stale" }
  | {
      status: "current";
      entries: FxReportingRow[];
      /** This subtotal covers only returned entries, never the entire filtered period. */
      pageSummary: FxConversionSummary;
      pendingCount: number;
      nextCursor: string | null;
    };
export type FxRevaluationPage =
  | { status: "stale" }
  | { status: "current"; processed: number; nextCursor: string | null };
async function fingerprint(value: unknown): Promise<string> {
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
function encodeCursor(entryId: string, key: string): string {
  return btoa(
    String.fromCharCode(
      ...new TextEncoder().encode(
        JSON.stringify({ entryId, fingerprint: key }),
      ),
    ),
  );
}
function decodeCursor(value: string, key: string): string {
  try {
    const cursor = cursorSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
        ),
      ),
    );
    if (cursor.fingerprint !== key) throw new Error("INVALID_FX_INPUT");
    return cursor.entryId;
  } catch {
    throw new Error("INVALID_FX_INPUT");
  }
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_FX_INPUT")
      throw error;
    throw new Error("FX_SERVICE_UNAVAILABLE");
  }
}
/** Bounded application seam: provider choice belongs to the Worker composition root. */
export function createFxReportingService(
  db: D1Database,
  options: {
    policy: FxConversionPolicy;
    reader: PublicReferenceRateReader | null;
  },
) {
  const parsedPolicy = fxConversionPolicySchema.safeParse(options.policy);
  if (!parsedPolicy.success) throw new Error("INVALID_FX_INPUT");
  const policy = parsedPolicy.data;
  const repository = createFxValuationRepository(db, { policy });
  const owned = `SELECT ${ownedEntryColumns()} FROM ledger_entries e JOIN profiles p ON p.user_id=e.user_id WHERE e.user_id=? AND e.eligible=1 AND p.status='active' AND p.version=? AND p.reporting_currency=?`;
  async function profileCurrent(
    context: TenantContext,
    input: FxReportingPageInput,
  ): Promise<boolean> {
    return (
      (await db
        .prepare(
          "SELECT 1 AS live FROM profiles WHERE user_id=? AND status='active' AND version=? AND reporting_currency=?",
        )
        .bind(
          context.userId,
          input.expectedProfileVersion,
          input.reportingCurrency,
        )
        .first()) !== null
    );
  }
  async function select(
    context: TenantContext,
    value: FxReportingPageInput,
    maximum: number,
  ) {
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success || parsed.data.limit > maximum)
      throw new Error("INVALID_FX_INPUT");
    const { purchaseId, cursor, ...required } = parsed.data;
    const input: FxReportingPageInput = {
      ...required,
      ...(purchaseId === undefined ? {} : { purchaseId }),
      ...(cursor === undefined ? {} : { cursor }),
    };
    const key = await fingerprint([
      context.userId,
      input.expectedProfileVersion,
      input.reportingCurrency,
      input.fromDate,
      input.toDate,
      input.purchaseId ?? null,
      policy.source,
      policy.maxPriorAgeDays,
      fxCalculationVersion,
    ]);
    const after = input.cursor ? decodeCursor(input.cursor, key) : "";
    if (!(await profileCurrent(context, input))) return null;
    const rows = (
      await db
        .prepare(
          `${owned} AND e.event_date>=? AND e.event_date<=? AND e.id>? ${input.purchaseId ? "AND e.purchase_id=?" : ""} ORDER BY e.id LIMIT ?`,
        )
        .bind(
          context.userId,
          input.expectedProfileVersion,
          input.reportingCurrency,
          input.fromDate,
          input.toDate,
          after,
          ...(input.purchaseId ? [input.purchaseId] : []),
          input.limit + 1,
        )
        .all<OwnedEntry>()
    ).results;
    const selected = rows.slice(0, input.limit);
    const last = selected.at(-1);
    return {
      input,
      rows: selected,
      nextCursor:
        rows.length > input.limit && last ? encodeCursor(last.id, key) : null,
    };
  }
  async function stillCurrent(
    context: TenantContext,
    input: FxReportingPageInput,
    rows: OwnedEntry[],
  ): Promise<boolean> {
    const changed = rows.map(() => "(id=? AND version=?)").join(" OR ");
    const result = await db
      .prepare(
        `SELECT 1 AS live FROM profiles p WHERE p.user_id=? AND p.status='active' AND p.version=? AND p.reporting_currency=? ${rows.length ? `AND (SELECT COUNT(*) FROM ledger_entries WHERE user_id=p.user_id AND eligible=1 AND (${changed}))=?` : ""}`,
      )
      .bind(
        context.userId,
        input.expectedProfileVersion,
        input.reportingCurrency,
        ...rows.flatMap((row) => [row.id, row.version]),
        ...(rows.length ? [rows.length] : []),
      )
      .first();
    return result !== null;
  }
  async function readPage(
    context: TenantContext,
    value: FxReportingPageInput,
  ): Promise<FxReportingPage> {
    const selected = await select(context, value, 20);
    if (!selected) return { status: "stale" };
    const entries: FxReportingRow[] = [];
    const results: FxConversionResult[] = [];
    for (const row of selected.rows) {
      const original = mapFxEntry(row);
      const valuation = await repository.get(context, {
        entryId: row.id,
        expectedProfileVersion: selected.input.expectedProfileVersion,
        reportingCurrency: selected.input.reportingCurrency,
      });
      if (valuation.status === "valued") {
        entries.push({
          status: "valued",
          entry: original,
          entryVersion: row.version,
          result: valuation.result,
        });
        results.push(valuation.result);
      } else
        entries.push({
          status: "pending",
          entry: original,
          entryVersion: row.version,
        });
    }
    if (!(await stillCurrent(context, selected.input, selected.rows)))
      return { status: "stale" };
    return {
      status: "current",
      entries,
      pageSummary: sumFxConversions(selected.input.reportingCurrency, results),
      pendingCount: entries.filter((row) => row.status === "pending").length,
      nextCursor: selected.nextCursor,
    };
  }
  async function cachedQuote(
    original: FxEntry,
    target: string,
  ): Promise<FxRateQuote | null> {
    const rows = (
      await db
        .prepare(
          "SELECT source,from_currency,to_currency,requested_date,effective_date,rate,retrieved_at,source_version FROM fx_rates WHERE source=? AND from_currency=? AND to_currency=? AND requested_date=? AND effective_date<=? ORDER BY effective_date DESC,retrieved_at,id LIMIT 1",
        )
        .bind(
          policy.source,
          original.currency,
          target,
          original.eventDate,
          original.eventDate,
        )
        .all<{
          source: string;
          from_currency: string;
          to_currency: string;
          requested_date: string;
          effective_date: string;
          rate: string;
          retrieved_at: number;
          source_version: string;
        }>()
    ).results;
    const row = rows[0];
    if (!row) return null;
    const quote = fxRateQuoteSchema.parse({
      source: row.source,
      fromCurrency: row.from_currency,
      toCurrency: row.to_currency,
      requestedDate: row.requested_date,
      effectiveDate: row.effective_date,
      rate: row.rate,
      retrievedAt: row.retrieved_at,
      version: row.source_version,
    });
    // C5: the staleness rule is the core conversion rule, not a second copy.
    return fxRateAgeDays(original.eventDate, quote.effectiveDate) <=
      policy.maxPriorAgeDays
      ? quote
      : null;
  }
  async function revaluePage(
    context: TenantContext,
    value: FxReportingPageInput,
  ): Promise<FxRevaluationPage> {
    const selected = await select(context, value, 3);
    if (!selected) return { status: "stale" };
    for (const row of selected.rows) {
      const key = {
        entryId: row.id,
        expectedProfileVersion: selected.input.expectedProfileVersion,
        reportingCurrency: selected.input.reportingCurrency,
      };
      const prior = await repository.get(context, key);
      if (prior.status === "valued" && prior.result.status === "converted")
        continue;
      const current = await db
        .prepare(`${owned} AND e.id=? AND e.version=?`)
        .bind(
          context.userId,
          key.expectedProfileVersion,
          key.reportingCurrency,
          row.id,
          row.version,
        )
        .first<OwnedEntry>();
      if (!current) return { status: "stale" };
      const original = mapFxEntry(current);
      let quote: FxRateQuote | null = null;
      if (original.currency !== key.reportingCurrency) {
        quote = await cachedQuote(original, key.reportingCurrency);
        if (!quote && options.reader) {
          if (!(await stillCurrent(context, selected.input, [row])))
            return { status: "stale" };
          // Provider failures propagate safely; no missing-rate fallback or destination switch.
          quote = await options.reader.lookup({
            fromCurrency: original.currency,
            toCurrency: key.reportingCurrency,
            requestedDate: original.eventDate,
          });
        }
      }
      const written = await repository.put(context, {
        ...key,
        expectedEntryVersion: row.version,
        expectedValuationVersion:
          prior.status === "valued" ? prior.valuationVersion : 0,
        quote,
      });
      if (written.status !== "stored") return { status: "stale" };
    }
    if (!(await stillCurrent(context, selected.input, selected.rows)))
      return { status: "stale" };
    return {
      status: "current",
      processed: selected.rows.length,
      nextCursor: selected.nextCursor,
    };
  }
  return {
    readPage: (context: TenantContext, input: FxReportingPageInput) =>
      safe(() => readPage(context, input)),
    revaluePage: (context: TenantContext, input: FxReportingPageInput) =>
      safe(() => revaluePage(context, input)),
  };
}
