import {
  type RecurringAutomaticPreviewInput,
  type RecurringCreateInput,
  type RecurringDecisionInput,
  type RecurringPayment,
  type RecurringResult,
  recurringAutomaticPreviewSchema,
  recurringCreateSchema,
  recurringDecisionInputSchema,
  recurringPageLimit,
} from "@invoxim/contracts";
import { deriveRecurringSuggestion, type TenantContext } from "@invoxim/core";
import { z } from "zod";

const rowSchema = z.object({
  id: z.string(),
  purchase_id: z.string(),
  amount_minor: z.string(),
  currency: z.string(),
  event_date: z.string(),
  version: z.number(),
  purchase_version: z.number(),
  installment: z.number(),
});
const linkedRowSchema = rowSchema.extend({
  selected_entry_version: z.number(),
  selected_purchase_version: z.number(),
  current_eligible: z.number(),
});
const seriesSchema = z.object({
  id: z.string(),
  identity_kind: z.enum(["user-confirmed", "service-reference"]),
  identity_key: z.string(),
  currency: z.string(),
  cadence: z.enum(["weekly", "monthly", "annual"]),
  anchor_date: z.string(),
  state: z.enum(["suggestion", "confirmed", "dismissed", "paused", "canceled"]),
  pricing_kind: z.enum(["unknown", "fixed", "usage-variable"]),
  selected_entry_count: z.number().int().min(1).max(20),
  version: z.number(),
});
type PaymentRow = z.infer<typeof rowSchema>;
export type RecurringSeriesMetadata = z.infer<typeof seriesSchema>;
export type RecurringSeriesRead =
  | { status: "missing" }
  | {
      status: "stale";
      series: RecurringSeriesMetadata;
      entryIds: string[];
      reason: "evidence_changed";
    }
  | {
      status: "current";
      series: RecurringSeriesMetadata;
      projection: RecurringResult;
    };
export type RecurringWriteResult =
  | { status: "stored"; version: number }
  | { status: "conflict" }
  | { status: "invalid_evidence"; reason: string };
export interface RecurringListInput {
  limit: number;
  after?: string;
}
export type RecurringListPage =
  | { status: "stale" }
  | {
      status: "current";
      records: Exclude<RecurringSeriesRead, { status: "missing" }>[];
      nextCursor: string | null;
    };
const joins =
  "ledger_entries e JOIN purchases p ON p.user_id=e.user_id AND p.id=e.purchase_id JOIN profiles owner ON owner.user_id=e.user_id";
// Canonical cash eligibility plus active purchase inclusion, never invoice-derived payments.
// Recurring eligibility (C15): this SQL pre-filters rows for ownership/lifecycle
// (active profile, active record, no pending delete/recompute) that the pure TS
// derivation never sees. The `installment` flag below folds in partially_paid and
// multi-payment; core/recurring/derive.ts re-checks kind/eligible/installment and
// multi-payment so the pure function stays correct without this pre-filter.
const eligible =
  "e.eligible=1 AND e.kind='payment' AND owner.status='active' AND p.record_status='active' AND p.lifecycle_delete_connection_id IS NULL AND p.lifecycle_recompute_connection_id IS NULL";
const installment =
  "CASE WHEN p.payment_state='partially_paid' OR (SELECT COUNT(*) FROM ledger_entries cash WHERE cash.user_id=e.user_id AND cash.purchase_id=e.purchase_id AND cash.eligible=1 AND cash.kind='payment')>1 THEN 1 ELSE 0 END";
const paymentColumns = `e.id,e.purchase_id,CAST(e.amount_minor AS TEXT) AS amount_minor,e.currency,e.event_date,e.version,p.version AS purchase_version,${installment} AS installment`;
const seriesColumns =
  "id,identity_kind,identity_key,currency,cadence,anchor_date,state,pricing_kind,selected_entry_count,version";
function payments(
  rows: PaymentRow[],
  series?: RecurringSeriesMetadata,
): RecurringPayment[] {
  return rows.map((row) => ({
    entryId: row.id,
    purchaseId: row.purchase_id,
    kind: "payment",
    eligible: true,
    installment: row.installment === 1,
    amountMinor: row.amount_minor,
    currency: row.currency,
    eventDate: row.event_date,
    serviceIdentity: series
      ? { kind: series.identity_kind, key: series.identity_key }
      : null,
    ...(series
      ? {
          terms: {
            cadence: series.cadence,
            anchorDate: series.anchor_date,
            evidence: "user-confirmed" as const,
          },
        }
      : {}),
    pricing: { kind: "unknown", evidence: "unknown" },
  }));
}
function validId(value: string): void {
  if (!recurringCreateSchema.shape.id.safeParse(value).success)
    throw new Error("INVALID_RECURRING_INPUT");
}
function parse<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) throw new Error("INVALID_RECURRING_INPUT");
  return result.data;
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_RECURRING_INPUT")
      throw error;
    throw new Error("RECURRING_SERVICE_UNAVAILABLE");
  }
}
export function createRecurringService(
  db: D1Database,
  options: { clock?: () => number } = {},
) {
  function now() {
    const value = (options.clock ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("INVALID_RECURRING_INPUT");
    return value;
  }
  async function selected(
    context: TenantContext,
    entries: RecurringCreateInput["entries"],
  ) {
    const result = await db
      .prepare(
        `SELECT ${paymentColumns} FROM ${joins} WHERE e.user_id=? AND ${eligible} AND e.id IN (${entries.map(() => "?").join(",")}) ORDER BY e.event_date,e.id`,
      )
      .bind(context.userId, ...entries.map((entry) => entry.entryId))
      .all();
    const rows = z.array(rowSchema).parse(result.results);
    if (
      rows.length !== entries.length ||
      rows.some(
        (row) =>
          !entries.some(
            (entry) =>
              entry.entryId === row.id && entry.expectedVersion === row.version,
          ),
      )
    )
      return null;
    return rows;
  }
  async function createUserSeries(
    context: TenantContext,
    value: RecurringCreateInput,
  ): Promise<RecurringWriteResult> {
    const input = parse(recurringCreateSchema.safeParse(value));
    const rows = await selected(context, input.entries);
    if (!rows) return { status: "conflict" };
    if (rows.some((row) => row.installment === 1))
      return {
        status: "invalid_evidence",
        reason: "installment_or_multiple_payments",
      };
    const first = rows[0];
    if (!first) return { status: "conflict" };
    const series: RecurringSeriesMetadata = {
      id: input.id,
      identity_kind: "user-confirmed",
      identity_key: input.identityKey,
      currency: first.currency,
      cadence: input.cadence,
      anchor_date: input.anchorDate,
      state: "suggestion",
      pricing_kind: "unknown",
      selected_entry_count: rows.length,
      version: 1,
    };
    const projection = deriveRecurringSuggestion({
      payments: payments(rows, series),
    });
    if (projection.status === "insufficient")
      return { status: "invalid_evidence", reason: projection.reason };
    const nonce = crypto.randomUUID();
    const versions = rows
      .map(() => "(e.id=? AND e.version=? AND p.version=?)")
      .join(" OR ");
    const guard = `(SELECT COUNT(*) FROM ${joins} WHERE e.user_id=? AND ${eligible} AND (${versions}))=?`;
    const statements = [
      db
        .prepare(
          `INSERT INTO recurring_series(user_id,id,identity_kind,identity_key,currency,cadence,anchor_date,state,pricing_kind,selected_entry_count,version,mutation_id,updated_at) SELECT ?,?,'user-confirmed',?,?,?,?,'suggestion','unknown',?,1,?,? WHERE ${guard} ON CONFLICT(user_id,id) DO NOTHING`,
        )
        .bind(
          context.userId,
          input.id,
          input.identityKey,
          first.currency,
          input.cadence,
          input.anchorDate,
          rows.length,
          nonce,
          now(),
          context.userId,
          ...rows.flatMap((row) => [row.id, row.version, row.purchase_version]),
          rows.length,
        ),
    ];
    for (const row of rows)
      statements.push(
        db
          .prepare(
            "INSERT INTO recurring_entries(user_id,series_id,entry_id,selected_entry_version,selected_purchase_version) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM recurring_series WHERE user_id=? AND id=? AND mutation_id=?)",
          )
          .bind(
            context.userId,
            input.id,
            row.id,
            row.version,
            row.purchase_version,
            context.userId,
            input.id,
            nonce,
          ),
      );
    const stored = await db.batch(statements);
    return stored[0]?.meta.changes === 1
      ? { status: "stored", version: 1 }
      : { status: "conflict" };
  }
  async function read(
    context: TenantContext,
    id: string,
  ): Promise<RecurringSeriesRead> {
    validId(id);
    const [seriesResult, entriesResult] = await db.batch([
      db
        .prepare(
          `SELECT ${seriesColumns} FROM recurring_series WHERE user_id=? AND id=? AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')`,
        )
        .bind(context.userId, id, context.userId),
      db
        .prepare(
          `SELECT ${paymentColumns},r.selected_entry_version,r.selected_purchase_version,CASE WHEN ${eligible} THEN 1 ELSE 0 END AS current_eligible FROM recurring_entries r JOIN ledger_entries e ON e.user_id=r.user_id AND e.id=r.entry_id JOIN purchases p ON p.user_id=e.user_id AND p.id=e.purchase_id JOIN profiles owner ON owner.user_id=e.user_id WHERE r.user_id=? AND r.series_id=? ORDER BY e.event_date,e.id LIMIT 21`,
        )
        .bind(context.userId, id),
    ]);
    const raw = seriesResult?.results[0];
    if (!raw) return { status: "missing" };
    const series = seriesSchema.parse(raw);
    const rows = z.array(linkedRowSchema).parse(entriesResult?.results ?? []);
    if (
      rows.length !== series.selected_entry_count ||
      rows.length > 20 ||
      rows.some(
        (row) =>
          row.version !== row.selected_entry_version ||
          row.purchase_version !== row.selected_purchase_version ||
          row.current_eligible !== 1 ||
          row.installment !== 0 ||
          row.currency !== series.currency,
      )
    )
      return {
        status: "stale",
        series,
        entryIds: rows.map((row) => row.id),
        reason: "evidence_changed",
      };
    return {
      status: "current",
      series,
      projection: deriveRecurringSuggestion({
        payments: payments(rows, series),
        ...(series.state === "suggestion"
          ? {}
          : { decision: { state: series.state, version: series.version } }),
      }),
    };
  }
  async function decide(
    context: TenantContext,
    id: string,
    value: RecurringDecisionInput,
  ): Promise<RecurringWriteResult> {
    validId(id);
    const input = parse(recurringDecisionInputSchema.safeParse(value));
    if (input.expectedVersion === 2147483646) return { status: "conflict" };
    const evidenceGuard =
      input.state === "confirmed"
        ? `AND (SELECT COUNT(*) FROM recurring_entries r WHERE r.user_id=recurring_series.user_id AND r.series_id=recurring_series.id)=selected_entry_count AND NOT EXISTS(SELECT 1 FROM recurring_entries r JOIN ledger_entries e ON e.user_id=r.user_id AND e.id=r.entry_id JOIN purchases p ON p.user_id=e.user_id AND p.id=e.purchase_id JOIN profiles owner ON owner.user_id=e.user_id WHERE r.user_id=recurring_series.user_id AND r.series_id=recurring_series.id AND (e.version!=r.selected_entry_version OR p.version!=r.selected_purchase_version OR NOT (${eligible}) OR (${installment})!=0 OR e.currency!=recurring_series.currency))`
        : "";
    const result = await db
      .prepare(
        `UPDATE recurring_series SET state=?,version=version+1,mutation_id=?,updated_at=? WHERE user_id=? AND id=? AND version=? AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active') ${evidenceGuard}`,
      )
      .bind(
        input.state,
        crypto.randomUUID(),
        now(),
        context.userId,
        id,
        input.expectedVersion,
        context.userId,
      )
      .run();
    return result.meta.changes === 1
      ? { status: "stored", version: input.expectedVersion + 1 }
      : { status: "conflict" };
  }
  async function previewAutomatic(
    context: TenantContext,
    value: RecurringAutomaticPreviewInput,
  ) {
    const input = parse(recurringAutomaticPreviewSchema.safeParse(value));
    const rows = await selected(context, input.entries);
    if (!rows) return { status: "conflict" as const };
    return deriveRecurringSuggestion({ payments: payments(rows) });
  }
  async function list(
    context: TenantContext,
    value: RecurringListInput,
  ): Promise<RecurringListPage> {
    const input = parse(
      z
        .strictObject({
          limit: z.number().int().min(1).max(recurringPageLimit),
          after: recurringCreateSchema.shape.id.optional(),
        })
        .safeParse(value),
    );
    const active = () =>
      db
        .prepare(
          "SELECT 1 AS current FROM profiles WHERE user_id=? AND status='active'",
        )
        .bind(context.userId)
        .first();
    if (!(await active())) return { status: "stale" };
    const ids = (
      await db
        .prepare(
          "SELECT id FROM recurring_series WHERE user_id=? AND id>? ORDER BY id LIMIT ?",
        )
        .bind(context.userId, input.after ?? "", input.limit + 1)
        .all<{ id: string }>()
    ).results;
    const records: Exclude<RecurringSeriesRead, { status: "missing" }>[] = [];
    for (const item of ids.slice(0, input.limit)) {
      const record = await read(context, item.id);
      if (record.status === "missing") return { status: "stale" };
      records.push(record);
    }
    if (!(await active())) return { status: "stale" };
    return {
      status: "current",
      records,
      nextCursor:
        ids.length > input.limit ? (ids.at(input.limit - 1)?.id ?? null) : null,
    };
  }
  return {
    list: (context: TenantContext, input: RecurringListInput) =>
      safe(() => list(context, input)),
    createUserSeries: (context: TenantContext, input: RecurringCreateInput) =>
      safe(() => createUserSeries(context, input)),
    read: (context: TenantContext, id: string) => safe(() => read(context, id)),
    decide: (
      context: TenantContext,
      id: string,
      input: RecurringDecisionInput,
    ) => safe(() => decide(context, id, input)),
    previewAutomatic: (
      context: TenantContext,
      input: RecurringAutomaticPreviewInput,
    ) => safe(() => previewAutomatic(context, input)),
  };
}
