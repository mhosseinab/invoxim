import type {
  CurrencyTotals,
  PurchaseFilters,
  PurchaseListRequest,
  PurchaseView,
} from "@invoxim/contracts";
import {
  purchaseCoverageSchema,
  purchaseDetailSchema,
  purchaseExportSnapshotSchema,
  purchaseFiltersSchema,
  purchaseListRequestSchema,
  purchaseListResponseSchema,
  purchaseReviewRequestSchema,
  purchaseReviewsSchema,
  purchaseSummarySchema,
  purchaseViewSchema,
  validCalendarDate,
} from "@invoxim/contracts";
import type { TenantContext } from "@invoxim/core";
import { parseMinor } from "@invoxim/core";
import { z } from "zod";
import { hashJsonValue } from "../hash";
import { activeProfile } from "../pipeline/repository-guards";

export class PurchaseViewError extends Error {
  constructor(public readonly code: "invalid_request" | "read_limit") {
    super(code);
  }
}
interface EventRow {
  id: string;
  kind: "payment" | "refund";
  minor: string;
  currency: string;
  date: string;
  dateBasis: string;
  eligible: number;
  observationId: string | null;
  origin: "source" | "user-confirmed";
  version: number;
}
interface Row {
  id: string;
  merchant: string;
  date: string;
  invoiceReference: string | null;
  orderReference: string | null;
  category: string;
  currency: string | null;
  documentTotalMinor: string | null;
  paymentState: "unknown" | "unpaid" | "partially_paid" | "paid";
  version: number;
  origin: "source" | "user-supplied";
  recordStatus: "active" | "excluded" | "merged";
  evidenceCount: number;
  reviews: string;
  events: string;
}
const eventSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["payment", "refund"]),
  minor: z.string().regex(/^(0|[1-9][0-9]*)$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  date: z.string(),
  dateBasis: z.string(),
  eligible: z.number().int().min(0).max(1),
  observationId: z.string().nullable(),
  origin: z.enum(["source", "user-confirmed"]),
  version: z.number().int().positive(),
});
const eventsSchema = z.array(eventSchema).max(1000);
const cursorSchema = z.strictObject({
  date: z.string().refine(validCalendarDate),
  id: purchaseViewSchema.shape.id,
  filter: z.string().max(64),
});
export function checkedFilters(input: PurchaseFilters) {
  const result = purchaseFiltersSchema.safeParse(input);
  if (!result.success) throw new PurchaseViewError("invalid_request");
  return result.data;
}
export function conditions(tenant: TenantContext, filter: PurchaseFilters) {
  const sql = [
    "p.user_id=?",
    "p.record_status!='merged'",
    "p.lifecycle_delete_connection_id IS NULL",
    activeProfile("p"),
  ];
  const values: (string | number)[] = [tenant.userId];
  if (filter.q) {
    const pattern = `%${filter.q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
    sql.push(
      "(LOWER(p.merchant_raw) LIKE ? ESCAPE '\\' OR LOWER(p.invoice_ref) LIKE ? ESCAPE '\\' OR LOWER(p.order_ref) LIKE ? ESCAPE '\\')",
    );
    values.push(pattern, pattern, pattern);
  }
  for (const [key, column] of [
    ["category", "category"],
    ["currency", "currency"],
    ["paymentState", "payment_state"],
  ] as const) {
    if (filter[key]) {
      sql.push(`p.${column}=?`);
      values.push(filter[key]);
    }
  }
  if (filter.mailbox) {
    sql.push(
      "(EXISTS(SELECT 1 FROM purchase_evidence pe JOIN observations o ON o.user_id=pe.user_id AND o.id=pe.observation_id JOIN documents d ON d.user_id=o.user_id AND d.id=o.document_id JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id WHERE pe.user_id=p.user_id AND pe.purchase_id=p.id AND s.connection_id=?) OR EXISTS(SELECT 1 FROM manual_purchase_evidence me JOIN documents d ON d.user_id=me.user_id AND d.id=me.document_id JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id WHERE me.user_id=p.user_id AND me.purchase_id=p.id AND s.connection_id=?))",
    );
    values.push(filter.mailbox, filter.mailbox);
  }
  if (filter.reviewState)
    sql.push(
      `${filter.reviewState === "clear" ? "NOT " : ""}EXISTS(SELECT 1 FROM review_items r WHERE r.user_id=p.user_id AND r.purchase_id=p.id AND r.status='open')`,
    );
  if (filter.from || filter.to) {
    const from = filter.from ?? "0001-01-01",
      to = filter.to ?? "9999-12-31";
    sql.push(
      "(p.document_date BETWEEN ? AND ? OR EXISTS(SELECT 1 FROM ledger_entries event WHERE event.user_id=p.user_id AND event.purchase_id=p.id AND event.event_date BETWEEN ? AND ?))",
    );
    values.push(from, to, from, to);
  }
  return { sql: sql.join(" AND "), values };
}
const metadataProjection = `p.id,p.merchant_raw AS merchant,p.document_date AS date,p.invoice_ref AS invoiceReference,p.order_ref AS orderReference,p.category,p.currency,CAST(p.total_minor AS TEXT) AS documentTotalMinor,p.payment_state AS paymentState,p.version,p.origin,p.record_status AS recordStatus,
 ((SELECT COUNT(*) FROM purchase_evidence pe WHERE pe.user_id=p.user_id AND pe.purchase_id=p.id)+(SELECT COUNT(*) FROM manual_purchase_evidence me WHERE me.user_id=p.user_id AND me.purchase_id=p.id)) AS evidenceCount,
 (SELECT json_group_array(reason) FROM (SELECT DISTINCT r.reason FROM review_items r WHERE r.user_id=p.user_id AND r.purchase_id=p.id AND r.status='open' ORDER BY r.reason)) AS reviews`;
const projection = `${metadataProjection},
 (SELECT json_group_array(json_object('id',e.id,'kind',e.kind,'minor',CAST(e.amount_minor AS TEXT),'currency',e.currency,'date',e.event_date,'dateBasis',e.date_basis,'eligible',e.eligible,'observationId',e.observation_id,'origin',e.origin,'version',e.version)) FROM (SELECT id,kind,amount_minor,currency,event_date,date_basis,eligible,observation_id,origin,version FROM ledger_entries entry WHERE entry.user_id=p.user_id AND entry.purchase_id=p.id ORDER BY entry.event_date,entry.id LIMIT 1001) e) AS events`;
export function matchesPeriod(
  event: Pick<EventRow, "date" | "currency">,
  filter?: PurchaseFilters,
) {
  return (
    (!filter?.from || event.date >= filter.from) &&
    (!filter?.to || event.date <= filter.to) &&
    (!filter?.currency || event.currency === filter.currency)
  );
}
function perCurrencyTotals(
  entries: Iterable<Pick<EventRow, "kind" | "minor" | "currency">>,
): CurrencyTotals[] {
  const sums = new Map<string, { paid: bigint; refunded: bigint }>();
  for (const entry of entries) {
    const sum = sums.get(entry.currency) ?? { paid: 0n, refunded: 0n };
    const amount = parseMinor(entry.minor);
    if (entry.kind === "payment") sum.paid += amount;
    else sum.refunded += amount;
    sums.set(entry.currency, sum);
  }
  return [...sums]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, value]) => ({
      currency,
      paidMinor: value.paid.toString(),
      refundedMinor: value.refunded.toString(),
      netMinor: (value.paid - value.refunded).toString(),
    }));
}
function totals(
  events: EventRow[],
  filter?: PurchaseFilters,
): CurrencyTotals[] {
  return perCurrencyTotals(
    events.filter((event) => event.eligible && matchesPeriod(event, filter)),
  );
}
function rowEvents(row: Row) {
  const parsed = eventsSchema.safeParse(JSON.parse(row.events));
  if (!parsed.success) throw new PurchaseViewError("read_limit");
  return parsed.data;
}
function display(row: Row, filter: PurchaseFilters): PurchaseView {
  const events = rowEvents(row);
  return purchaseViewSchema.parse({
    id: row.id,
    merchant: row.merchant,
    date: row.date,
    invoiceReference: row.invoiceReference,
    orderReference: row.orderReference,
    category: row.category,
    currency: row.currency,
    documentTotalMinor: row.documentTotalMinor,
    paymentState: row.paymentState,
    version: row.version,
    origin: row.origin,
    recordStatus: row.recordStatus,
    evidenceCount: row.evidenceCount,
    reviewReasons: z.array(z.string()).parse(JSON.parse(row.reviews)),
    lifecycle: totals(events),
    period: totals(events, filter),
  });
}
async function filterKey(filter: PurchaseFilters) {
  return hashJsonValue(filter);
}
function encodeCursor(date: string, id: string, filter: string) {
  return btoa(
    String.fromCharCode(
      ...new TextEncoder().encode(JSON.stringify({ date, id, filter })),
    ),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function decodeCursor(value: string) {
  try {
    return cursorSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          Uint8Array.from(
            atob(value.replace(/-/g, "+").replace(/_/g, "/")),
            (c) => c.charCodeAt(0),
          ),
        ),
      ),
    );
  } catch {
    throw new PurchaseViewError("invalid_request");
  }
}
export function createPurchaseViewReader(db: D1Database) {
  async function readRows(
    tenant: TenantContext,
    filter: PurchaseFilters,
    limit: number,
    cursor?: { date: string; id: string },
    includeEvents = true,
  ) {
    const where = conditions(tenant, filter);
    const continuation = cursor
      ? " AND (p.document_date<? OR (p.document_date=? AND p.id>?))"
      : "";
    const values = cursor
      ? [...where.values, cursor.date, cursor.date, cursor.id, limit]
      : [...where.values, limit];
    return (
      await db
        .prepare(
          `SELECT ${includeEvents ? projection : `${metadataProjection},'[]' AS events`} FROM purchases p WHERE ${where.sql}${continuation} ORDER BY p.document_date DESC,p.id ASC LIMIT ?`,
        )
        .bind(...values)
        .all<Row>()
    ).results;
  }
  async function list(tenant: TenantContext, input: PurchaseListRequest) {
    const checked = purchaseListRequestSchema.safeParse(input);
    if (!checked.success) throw new PurchaseViewError("invalid_request");
    const { limit, cursor, ...filters } = checked.data;
    const key = await filterKey(filters);
    const after = cursor ? decodeCursor(cursor) : undefined;
    if (after && after.filter !== key)
      throw new PurchaseViewError("invalid_request");
    const rows = await readRows(tenant, filters, limit + 1, after);
    const page = rows.slice(0, limit),
      last = page.at(-1);
    return purchaseListResponseSchema.parse({
      rows: page.map((r) => display(r, filters)),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.date, last.id, key)
          : null,
      dateBasis: "document-or-event",
    });
  }
  async function exportRows(
    tenant: TenantContext,
    input: PurchaseFilters = {},
    limit = 500,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new PurchaseViewError("invalid_request");
    const filter = checkedFilters(input),
      rows = await readRows(tenant, filter, limit + 1);
    return {
      rows: rows.slice(0, limit).map((r) => display(r, filter)),
      hasMore: rows.length > limit,
    };
  }
  async function exportSnapshot(
    tenant: TenantContext,
    input: PurchaseFilters = {},
  ) {
    const filters = checkedFilters(input);
    const rows = await readRows(tenant, filters, 501, undefined, false);
    if (rows.length > 500) throw new PurchaseViewError("read_limit");
    const selectedPurchases = rows.map((row) => display(row, filters));
    // One bounded union fetches event and evidence metadata for the selected tenant-owned records.
    const records = (
      await db
        .prepare(
          `WITH selected AS (SELECT value AS id FROM json_each(?)),
    events AS (SELECT 'event' AS type,json_object('id',e.id,'purchaseId',e.purchase_id,'observationId',e.observation_id,'origin',e.origin,'version',e.version,'kind',e.kind,'minor',CAST(e.amount_minor AS TEXT),'currency',e.currency,'date',e.event_date,'dateBasis',e.date_basis,'eligible',e.eligible) AS payload FROM ledger_entries e JOIN selected p ON p.id=e.purchase_id WHERE e.user_id=? AND ${activeProfile("e")} ORDER BY e.id LIMIT 2001),
    evidence AS (SELECT 'evidence' AS type,json_object('purchaseId',pe.purchase_id,'documentId',d.id,'observationId',o.id,'mailboxId',s.connection_id,'provider',c.provider,'providerMessageId',s.provider_message_id,'contentHash',d.content_hash,'available',s.available,'relationship',pe.relationship,'evidenceCode',o.evidence_code,'reviewState',o.review_state,'documentType',COALESCE(json_extract(o.structured_fields,'$.documentType'),'unknown'),'fields',json(o.normalized_fields)) AS payload FROM purchase_evidence pe JOIN selected p ON p.id=pe.purchase_id JOIN observations o ON o.user_id=pe.user_id AND o.id=pe.observation_id JOIN documents d ON d.user_id=o.user_id AND d.id=o.document_id JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id JOIN connections c ON c.user_id=s.user_id AND c.id=s.connection_id WHERE pe.user_id=? AND ${activeProfile("pe")} ORDER BY pe.purchase_id,o.id LIMIT 2001)
    ,manual_evidence AS (SELECT 'manual-evidence' AS type,json_object('purchaseId',me.purchase_id,'documentId',d.id,'observationId',NULL,'mailboxId',s.connection_id,'provider',c.provider,'providerMessageId',s.provider_message_id,'contentHash',d.content_hash,'available',s.available,'relationship','user-associated','evidenceCode','user-associated','reviewState','user-supplied','documentType','unknown','fields',NULL) AS payload FROM manual_purchase_evidence me JOIN selected p ON p.id=me.purchase_id JOIN documents d ON d.user_id=me.user_id AND d.id=me.document_id JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id JOIN connections c ON c.user_id=s.user_id AND c.id=s.connection_id WHERE me.user_id=? AND ${activeProfile("me")} ORDER BY me.purchase_id,d.id LIMIT 2001),overrides AS (SELECT 'override' AS type,json_object('entityKind',fo.entity_kind,'entityId',fo.entity_id,'field',fo.field,'originalValue',json(fo.original_value_json),'value',json(fo.value_json),'revision',fo.revision) AS payload FROM field_overrides fo WHERE fo.user_id=? AND ${activeProfile("fo")} AND ((fo.entity_kind='purchase' AND fo.entity_id IN (SELECT id FROM selected)) OR (fo.entity_kind='entry' AND EXISTS(SELECT 1 FROM ledger_entries e JOIN selected p ON p.id=e.purchase_id WHERE e.user_id=fo.user_id AND e.id=fo.entity_id))) ORDER BY fo.entity_kind,fo.entity_id,fo.field LIMIT 4001)
    SELECT type,payload FROM events UNION ALL SELECT type,payload FROM evidence UNION ALL SELECT type,payload FROM manual_evidence UNION ALL SELECT type,payload FROM overrides`,
        )
        .bind(
          JSON.stringify(rows.map((row) => row.id)),
          tenant.userId,
          tenant.userId,
          tenant.userId,
          tenant.userId,
        )
        .all<{
          type: "event" | "evidence" | "manual-evidence" | "override";
          payload: string;
        }>()
    ).results;
    const events = records.filter((row) => row.type === "event");
    const evidence = records.filter(
      (row) => row.type === "evidence" || row.type === "manual-evidence",
    );
    const overrideRows = records.filter((row) => row.type === "override");
    if (overrideRows.length > 4000) throw new PurchaseViewError("read_limit");
    const overrideValue = z
      .union([
        z.string().max(1000),
        z.null(),
        z.number().int().min(0).max(9000000000000),
      ])
      .transform((value) =>
        typeof value === "number" ? String(value) : value,
      );
    const overrides = purchaseExportSnapshotSchema.shape.overrides.parse(
      overrideRows.map((row) => {
        const value = z
          .object({
            entityKind: z.enum(["purchase", "entry"]),
            entityId: z.string(),
            field: z.string(),
            originalValue: overrideValue,
            value: overrideValue,
            revision: z.number().int().positive(),
          })
          .parse(JSON.parse(row.payload));
        return value;
      }),
    );
    if (events.length > 2000 || evidence.length > 2000)
      throw new PurchaseViewError("read_limit");
    const ledgerEntries =
      purchaseExportSnapshotSchema.shape.ledgerEntries.parse(
        events.map((row) => {
          const event = z
            .object({
              id: z.string(),
              purchaseId: z.string(),
              observationId: z.string().nullable(),
              origin: z.enum(["source", "user-confirmed"]),
              version: z.number().int().positive(),
              kind: z.enum(["payment", "refund"]),
              minor: z.string(),
              currency: z.string(),
              date: z.string(),
              dateBasis: z.string(),
              eligible: z.number().int().min(0).max(1),
            })
            .parse(JSON.parse(row.payload));
          return { ...event, eligible: event.eligible === 1 };
        }),
      );
    const metadata = evidence.map((row) =>
      z
        .object({
          purchaseId: z.string(),
          documentId: z.string(),
          observationId: z.string().nullable(),
          provenance: z.enum(["source-extracted", "user-associated"]),
          mailboxId: z.string(),
          provider: z.string(),
          providerMessageId: z.string(),
          contentHash: z.string(),
          available: z.number().int().min(0).max(1),
          relationship: z.string(),
          evidenceCode: z.string(),
          reviewState: z.string(),
          documentType: z.string(),
          fields: z.unknown(),
        })
        .parse({
          ...JSON.parse(row.payload),
          provenance:
            row.type === "manual-evidence"
              ? "user-associated"
              : "source-extracted",
        }),
    );
    const financialEvents = ledgerEntries.map((event) => ({
      ...event,
      eligible: event.eligible ? 1 : 0,
    }));
    const purchases = selectedPurchases.map((purchase) => {
      const ownedEvents = financialEvents.filter(
        (event) => event.purchaseId === purchase.id,
      );
      return {
        ...purchase,
        lifecycle: totals(ownedEvents),
        period: totals(ownedEvents, filters),
      };
    });
    const summary = purchaseSummarySchema.parse({
      totals: totals(financialEvents, filters),
      dateBasis: "event",
      recordCount: purchases.length,
      unpaidCount: purchases.filter(
        (purchase) => purchase.paymentState === "unpaid",
      ).length,
      unknownCount: purchases.filter(
        (purchase) => purchase.paymentState === "unknown",
      ).length,
      reviewCount: purchases.filter(
        (purchase) => purchase.reviewReasons.length > 0,
      ).length,
      missingCurrencyCount: purchases.filter(
        (purchase) => purchase.currency === null,
      ).length,
      excludedEntryCount: financialEvents.filter(
        (event) => !event.eligible && matchesPeriod(event, filters),
      ).length,
      conversion: "not_configured",
    });
    const snapshot = purchaseExportSnapshotSchema.parse({
      overrides,
      purchases,
      ledgerEntries,
      sources: metadata.map((item) => ({
        purchaseId: item.purchaseId,
        documentId: item.documentId,
        observationId: item.observationId,
        provenance: item.provenance,
        mailboxId: item.mailboxId,
        provider: item.provider,
        providerMessageId: item.providerMessageId,
        contentHash: item.contentHash,
        available: item.available === 1,
        originalAvailable: false,
      })),
      observations: metadata
        .filter((item) => item.observationId !== null)
        .map((item) => ({
          id: item.observationId,
          purchaseId: item.purchaseId,
          documentId: item.documentId,
          relationship: item.relationship,
          evidenceCode: item.evidenceCode,
          reviewState: item.reviewState,
          documentType: item.documentType,
          fields: item.fields,
        })),
    });
    return { ...snapshot, summary };
  }
  async function summary(tenant: TenantContext, input: PurchaseFilters = {}) {
    const filter = checkedFilters(input),
      where = conditions(tenant, filter);
    const counts = await db
      .prepare(
        `SELECT COUNT(*) AS recordCount,COALESCE(SUM(p.payment_state='unpaid'),0) AS unpaidCount,COALESCE(SUM(p.payment_state='unknown'),0) AS unknownCount,COALESCE(SUM(p.currency IS NULL),0) AS missingCurrencyCount,COALESCE(SUM(EXISTS(SELECT 1 FROM review_items r WHERE r.user_id=p.user_id AND r.purchase_id=p.id AND r.status='open')),0) AS reviewCount FROM purchases p WHERE ${where.sql}`,
      )
      .bind(...where.values)
      .first<Record<string, number>>();
    let cursor = "",
      excluded = 0;
    const eligible: Pick<EventRow, "kind" | "minor" | "currency">[] = [];
    // 25 bounded chunks leave room for session/profile reads within the shared 40-query cap.
    for (let page = 0; page < 25; page++) {
      const rows = (
        await db
          .prepare(
            `SELECT e.id,e.kind,CAST(e.amount_minor AS TEXT) AS minor,e.currency,e.event_date AS date,e.date_basis AS dateBasis,e.eligible,e.observation_id AS observationId,e.origin,e.version FROM ledger_entries e JOIN purchases p ON p.user_id=e.user_id AND p.id=e.purchase_id WHERE ${where.sql} AND e.id>? AND e.event_date BETWEEN ? AND ?${filter.currency ? " AND e.currency=?" : ""} ORDER BY e.id LIMIT 4000`,
          )
          .bind(
            ...where.values,
            cursor,
            filter.from ?? "0001-01-01",
            filter.to ?? "9999-12-31",
            ...(filter.currency ? [filter.currency] : []),
          )
          .all<EventRow>()
      ).results;
      for (const row of rows) {
        if (!row.eligible) {
          excluded++;
          continue;
        }
        eligible.push(row);
      }
      if (rows.length < 4000)
        return purchaseSummarySchema.parse({
          ...counts,
          totals: perCurrencyTotals(eligible),
          excludedEntryCount: excluded,
          conversion: "not_configured",
          dateBasis: "event",
        });
      const last = rows.at(-1);
      if (!last) throw new PurchaseViewError("read_limit");
      cursor = last.id;
    }
    throw new PurchaseViewError("read_limit");
  }
  async function detail(
    tenant: TenantContext,
    id: string,
    input: PurchaseFilters = {},
  ) {
    if (!id || id.length > 4096) throw new PurchaseViewError("invalid_request");
    const filter = checkedFilters(input),
      where = conditions(tenant, {});
    const row = await db
      .prepare(
        `SELECT ${projection} FROM purchases p WHERE ${where.sql} AND p.id=?`,
      )
      .bind(...where.values, id)
      .first<Row>();
    if (!row) return null;
    const evidence = (
      await db
        .prepare(
          `SELECT * FROM (SELECT 'source-extracted' AS provenance,o.id AS observationId,d.id AS documentId,pe.relationship,o.evidence_code AS evidenceCode,o.review_state AS reviewState,o.structured_fields AS fields,c.id AS mailboxId,c.provider,c.state,s.available FROM purchase_evidence pe JOIN observations o ON o.user_id=pe.user_id AND o.id=pe.observation_id JOIN documents d ON d.user_id=o.user_id AND d.id=o.document_id JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id JOIN connections c ON c.user_id=s.user_id AND c.id=s.connection_id WHERE pe.user_id=? AND pe.purchase_id=? AND ${activeProfile("pe")} UNION ALL SELECT 'user-associated',NULL,d.id,'user-associated','user-associated','user-supplied',NULL,c.id,c.provider,c.state,s.available FROM manual_purchase_evidence me JOIN documents d ON d.user_id=me.user_id AND d.id=me.document_id JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id JOIN connections c ON c.user_id=s.user_id AND c.id=s.connection_id WHERE me.user_id=? AND me.purchase_id=? AND ${activeProfile("me")}) ORDER BY documentId,observationId LIMIT 201`,
        )
        .bind(tenant.userId, id, tenant.userId, id)
        .all<{
          observationId: string | null;
          provenance: "source-extracted" | "user-associated";
          documentId: string;
          relationship: string;
          evidenceCode: string;
          reviewState: string;
          fields: string | null;
          mailboxId: string;
          provider: string;
          state: string;
          available: number;
        }>()
    ).results;
    if (evidence.length > 200) throw new PurchaseViewError("read_limit");
    const events = rowEvents(row);
    return purchaseDetailSchema.parse({
      purchase: display(row, filter),
      ledgerEntries: events.map((event) => ({
        ...event,
        eligible: event.eligible === 1,
      })),
      manualEvidence: evidence
        .filter((e) => e.provenance === "user-associated")
        .map((e) => ({
          documentId: e.documentId,
          provenance: "user-associated",
          source: {
            mailboxId: e.mailboxId,
            provider: e.provider,
            originalAvailable: false,
            reason:
              e.available === 0
                ? "source_deleted"
                : e.state !== "connected"
                  ? "mailbox_disconnected"
                  : "retrieval_not_implemented",
          },
        })),
      timeline: evidence
        .filter((e) => e.provenance === "source-extracted")
        .map((e) => {
          if (!e.observationId) throw new PurchaseViewError("read_limit");
          const observedEvents = events.filter(
            (event) => event.observationId === e.observationId,
          );
          const fields = e.fields
            ? z
                .object({
                  documentType: z.string(),
                  record: z.object({
                    documentDate: z.string().nullable(),
                    eventDate: z.string().nullable(),
                    paymentEvidence: z.string(),
                    refundEvidence: z.string(),
                  }),
                })
                .parse(JSON.parse(e.fields))
            : null;
          return {
            observationId: e.observationId,
            documentId: e.documentId,
            relationship: e.relationship,
            evidenceCode: e.evidenceCode,
            reviewState: e.reviewState,
            documentType: fields?.documentType ?? "unknown",
            date:
              observedEvents[0]?.date ??
              fields?.record.eventDate ??
              fields?.record.documentDate ??
              null,
            paymentEvidence: fields?.record.paymentEvidence ?? null,
            refundEvidence: fields?.record.refundEvidence ?? null,
            source: {
              mailboxId: e.mailboxId,
              provider: e.provider,
              originalAvailable: false,
              reason:
                e.available === 0
                  ? "source_deleted"
                  : e.state !== "connected"
                    ? "mailbox_disconnected"
                    : "retrieval_not_implemented",
            },
            events: observedEvents.map((event) => ({
              id: event.id,
              kind: event.kind,
              minor: event.minor,
              currency: event.currency,
              date: event.date,
              dateBasis: event.dateBasis,
              eligible: event.eligible === 1,
            })),
          };
        })
        .sort(
          (a, b) =>
            (a.date ?? "9999-12-31").localeCompare(b.date ?? "9999-12-31") ||
            a.observationId.localeCompare(b.observationId),
        ),
    });
  }
  async function reviews(tenant: TenantContext, limit = 25) {
    const checked = purchaseReviewRequestSchema.safeParse({ limit });
    if (!checked.success) throw new PurchaseViewError("invalid_request");
    const rows = (
      await db
        .prepare(
          `SELECT r.id,s.id AS sourceMessageId,r.document_id AS documentId,r.purchase_id AS purchaseId,r.reason,r.missing_fields_json AS missing,c.display_address AS mailboxAddress,c.provider,s.received_at AS receivedAt,(s.available=1 AND c.state='connected' AND s.generation=c.generation) AS sourceAvailable FROM review_items r LEFT JOIN documents d ON d.user_id=r.user_id AND d.id=r.document_id LEFT JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id LEFT JOIN connections c ON c.user_id=s.user_id AND c.id=s.connection_id WHERE r.user_id=? AND r.status='open' AND ${activeProfile("r")} ORDER BY r.created_at DESC,r.id ASC LIMIT ?`,
        )
        .bind(tenant.userId, checked.data.limit + 1)
        .all<{
          id: string;
          documentId: string | null;
          purchaseId: string | null;
          reason: string;
          missing: string | null;
          sourceMessageId: string | null;
          mailboxAddress: string | null;
          receivedAt: number | null;
          provider: string | null;
          sourceAvailable: number | null;
        }>()
    ).results;
    return purchaseReviewsSchema.parse({
      reviews: rows.slice(0, checked.data.limit).map((row) => ({
        id: row.id,
        documentId: row.documentId,
        ...(row.sourceMessageId
          ? { sourceMessageId: row.sourceMessageId }
          : {}),
        purchaseId: row.purchaseId,
        reason: row.reason,
        ...(row.mailboxAddress !== null &&
        row.receivedAt !== null &&
        row.provider !== null
          ? {
              sourceContext: {
                mailboxAddress: row.mailboxAddress,
                receivedAt: row.receivedAt,
                provider: row.provider,
                available: row.sourceAvailable === 1,
              },
            }
          : {}),
        missingFields: row.missing === null ? [] : JSON.parse(row.missing),
      })),
      hasMore: rows.length > checked.data.limit,
    });
  }
  async function coverage(tenant: TenantContext) {
    const counts = await db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM purchases p WHERE p.user_id=active.user_id AND p.record_status!='merged' AND p.lifecycle_delete_connection_id IS NULL) AS readyPurchaseCount,(SELECT COUNT(*) FROM review_items r WHERE r.user_id=active.user_id AND r.status='open') AS openReviewCount FROM profiles active WHERE active.user_id=? AND active.status='active'",
      )
      .bind(tenant.userId)
      .first<{ readyPurchaseCount: number; openReviewCount: number }>();
    const connections = (
      await db
        .prepare(
          `SELECT c.id,c.display_address AS address,c.provider,c.state,c.scheduling_state AS schedulingState,(SELECT COUNT(*) FROM jobs j WHERE j.user_id=c.user_id AND j.connection_id=c.id AND j.status IN ('ready','leased','retry_wait')) AS pendingJobs,(SELECT COUNT(*) FROM jobs j WHERE j.user_id=c.user_id AND j.connection_id=c.id AND j.status IN ('paused_budget','paused_auth')) AS pausedJobs,(SELECT COUNT(*) FROM jobs j WHERE j.user_id=c.user_id AND j.connection_id=c.id AND j.status='terminal') AS failedJobs FROM connections c WHERE c.user_id=? AND c.kind='mailbox' AND ${activeProfile("c")} ORDER BY c.id LIMIT 101`,
        )
        .bind(tenant.userId)
        .all<{
          id: string;
          address: string;
          provider: string;
          state: string;
          schedulingState: string;
          pendingJobs: number;
          pausedJobs: number;
          failedJobs: number;
        }>()
    ).results;
    const imports = (
      await db
        .prepare(
          `SELECT r.id,r.connection_id AS connectionId,r.frozen_start AS \`from\`,r.frozen_cutoff AS \`to\`,r.stage,r.pause_reason AS pauseReason,r.completed_at AS completedAt,r.discovered_count AS discoveredSources,r.processed_count AS processedSources FROM import_runs r WHERE r.user_id=? AND ${activeProfile("r")} ORDER BY r.started_at DESC,r.id LIMIT 101`,
        )
        .bind(tenant.userId)
        .all<{
          id: string;
          connectionId: string;
          from: string;
          to: string;
          stage: string;
          pauseReason: string | null;
          completedAt: number | null;
          discoveredSources: number;
          processedSources: number;
        }>()
    ).results;
    if (connections.length > 100 || imports.length > 100)
      throw new PurchaseViewError("read_limit");
    return purchaseCoverageSchema.parse({
      ...(counts ?? { readyPurchaseCount: 0, openReviewCount: 0 }),
      connections: connections.map((c) => ({
        ...c,
        imports: imports
          .filter((r) => r.connectionId === c.id)
          .map((r) => ({
            id: r.id,
            from: r.from,
            to: r.to,
            stage: r.stage,
            pauseReason: r.pauseReason,
            completedAt: r.completedAt,
            discoveredSources: r.discoveredSources,
            processedSources: r.processedSources,
          })),
      })),
    });
  }
  return {
    list,
    detail,
    summary,
    coverage,
    exportRows,
    exportSnapshot,
    reviews,
  };
}
