import { supportedCurrency, validCalendarDate } from "@invoxim/contracts";
import type {
  JobLease,
  LedgerCashProof,
  LedgerCashReview,
  LedgerCreditProof,
  LedgerEvent,
  LedgerInput,
  LedgerObservation,
  LedgerPurchase,
  LedgerSnapshot,
} from "@invoxim/core";
import {
  ENTRY_MINOR_BOUND,
  LEDGER_REVIEW_REASONS,
  ledgerEventKey,
  normalizeLedgerMerchant,
  parseMoney,
} from "@invoxim/core";
import { z } from "zod";
import {
  creditProofSql,
  parseCreditProofRows,
} from "../corrections/allocation";
import {
  checkedResult,
  fingerprintSchema,
  identifier,
} from "./plan-validation";
import {
  json,
  PipelinePersistenceError,
  type Predicate,
  safeJson,
} from "./repository-guards";

type ObservationRow = {
  id: string;
  document_id: string;
  segment_index: number;
  extraction_fingerprint: string;
  structured_fields: string;
  content_hash: string;
  purchase_id: string | null;
};
type PurchaseRow = {
  id: string;
  merchant_raw: string;
  currency: string | null;
  total_minor: number | null;
  document_date: string;
  invoice_ref: string | null;
  order_ref: string | null;
  category: LedgerPurchase["category"];
  payment_state: LedgerPurchase["paymentState"];
  record_status: NonNullable<LedgerPurchase["recordStatus"]>;
  lifecycle_delete_connection_id: string | null;
  lifecycle_recompute_connection_id: string | null;
  version: number;
  overrides_json: string;
  credits_json: string;
};
type EventRow = {
  id: string;
  business_event_key: string;
  purchase_id: string | null;
  observation_id: string | null;
  origin: "source" | "user-confirmed";
  original_values_json: string;
  kind: "payment" | "refund";
  amount_minor: number;
  currency: string;
  event_date: string;
  date_basis: LedgerEvent["dateBasis"];
  eligible: number;
  version: number;
  proof_json: string | null;
};
const cashProofSchema = z.strictObject({
  documentId: identifier,
  evidenceCode: z.string().max(40).nullable(),
  accepted: z.union([z.literal(0), z.literal(1)]),
});
/** Corrections events() facts: no observation means no source proof. */
function cashProof(encoded: string | null): LedgerCashProof {
  if (encoded === null)
    return { documentId: null, evidenceCode: null, accepted: false };
  const proof = cashProofSchema.parse(safeJson(encoded));
  return {
    documentId: proof.documentId,
    evidenceCode: proof.evidenceCode,
    accepted: proof.accepted === 1,
  };
}
function originalEventValues(
  encoded: string,
): NonNullable<LedgerEvent["sourceValues"]> {
  const amount = z
    .union([
      z.number().int().min(0).max(Number(ENTRY_MINOR_BOUND)),
      z
        .string()
        .regex(/^(0|[1-9][0-9]*)$/)
        .max(13),
    ])
    .transform((value) => Number(value))
    .refine((value) => value <= Number(ENTRY_MINOR_BOUND));
  const parsed = z
    .strictObject({
      amountMinor: amount.optional(),
      dateBasis: z
        .enum([
          "explicit-event-date",
          "document-date",
          "user-confirmed-date",
          "user-corrected-date",
        ])
        .optional(),
      currency: supportedCurrency.optional(),
      eventDate: z.string().refine(validCalendarDate).optional(),
    })
    .parse(safeJson(encoded));
  return {
    ...(parsed.amountMinor === undefined
      ? {}
      : { amountMinor: parsed.amountMinor }),
    ...(parsed.currency === undefined ? {} : { currency: parsed.currency }),
    ...(parsed.eventDate === undefined ? {} : { eventDate: parsed.eventDate }),
    ...(parsed.dateBasis === undefined ? {} : { dateBasis: parsed.dateBasis }),
  };
}
/**
 * Load the durable ledger snapshot for a candidate ingestion input
 * (P4 split from repository.ts). `guard` is the caller's optimistic
 * concurrency predicate; a missing authorization row returns null.
 */
export async function loadLedgerSnapshot(
  db: D1Database,
  lease: JobLease,
  input: LedgerInput,
  guard: Predicate,
): Promise<LedgerSnapshot | null> {
  const records =
    input.result.status === "accepted" ? input.result.records : [];
  const candidates = records.map((record) => ({
    merchant:
      record.merchant === null
        ? null
        : normalizeLedgerMerchant(record.merchant),
    invoice: record.invoiceNumber,
    order: record.orderReference,
    date: record.documentDate,
    total:
      record.currency === null || record.total === null
        ? null
        : Number(parseMoney(record.total, record.currency)),
  }));
  const keys = records.flatMap((record, index) =>
    record.merchant === null
      ? []
      : [
          ledgerEventKey(input.identity, index, record, "payment"),
          ledgerEventKey(input.identity, index, record, "refund"),
        ],
  );
  const purchaseRows = await db
    .prepare(
      `WITH q AS (SELECT json_extract(value,'$.merchant') AS merchant,json_extract(value,'$.invoice') AS invoice,json_extract(value,'$.order') AS order_ref,json_extract(value,'$.date') AS date,json_extract(value,'$.total') AS total FROM json_each(?)), purchase_refs AS (
          SELECT p.id FROM q CROSS JOIN purchases p INDEXED BY purchases_invoice_reference WHERE p.user_id=? AND p.merchant_normalized=q.merchant AND p.invoice_ref=q.invoice AND p.invoice_ref IS NOT NULL
          UNION SELECT p.id FROM q CROSS JOIN purchases p INDEXED BY purchases_order_reference WHERE p.user_id=? AND p.merchant_normalized=q.merchant AND p.order_ref=q.order_ref AND p.order_ref IS NOT NULL
          UNION SELECT p.id FROM q CROSS JOIN purchases p INDEXED BY purchases_tenant_date WHERE p.user_id=? AND p.document_date=q.date AND p.merchant_normalized=q.merchant AND p.total_minor=q.total
        ), observation_refs AS (
          SELECT pe.purchase_id FROM q CROSS JOIN observations o INDEXED BY observations_invoice_reference CROSS JOIN purchase_evidence pe WHERE o.user_id=? AND o.merchant_key=q.merchant AND o.invoice_ref=q.invoice AND pe.user_id=o.user_id AND pe.observation_id=o.id AND o.invoice_ref IS NOT NULL
          UNION SELECT pe.purchase_id FROM q CROSS JOIN observations o INDEXED BY observations_order_reference CROSS JOIN purchase_evidence pe WHERE o.user_id=? AND o.merchant_key=q.merchant AND o.order_ref=q.order_ref AND pe.user_id=o.user_id AND pe.observation_id=o.id AND o.order_ref IS NOT NULL
          UNION SELECT pe.purchase_id FROM documents d INDEXED BY documents_tenant_hash CROSS JOIN observations o CROSS JOIN purchase_evidence pe WHERE d.user_id=? AND d.content_hash=? AND o.user_id=d.user_id AND o.document_id=d.id AND pe.user_id=o.user_id AND pe.observation_id=o.id
          UNION SELECT pe.purchase_id FROM observations o CROSS JOIN purchase_evidence pe WHERE o.user_id=? AND o.document_id=? AND pe.user_id=o.user_id AND pe.observation_id=o.id
        ), cash_refs AS (
          SELECT le.purchase_id FROM json_each(?) k CROSS JOIN ledger_entries le WHERE le.user_id=? AND le.business_event_key=k.value
        ), candidate_ids AS (
          SELECT id FROM purchase_refs UNION SELECT purchase_id FROM observation_refs UNION SELECT purchase_id FROM cash_refs
        ) SELECT p.id,p.merchant_raw,p.currency,p.total_minor,p.document_date,p.invoice_ref,p.order_ref,p.category,p.payment_state,p.record_status,p.lifecycle_delete_connection_id,p.lifecycle_recompute_connection_id,p.version,(SELECT json_group_array(field) FROM (SELECT field FROM field_overrides fo WHERE fo.user_id=p.user_id AND fo.entity_kind='purchase' AND fo.entity_id=p.id ORDER BY field LIMIT 21)) AS overrides_json,(SELECT json_group_array(json_object('currency',currency,'total',total,'credit',credit)) FROM (${creditProofSql("p.user_id", "p.id")})) AS credits_json FROM purchases p WHERE p.user_id=? AND (p.id IN (SELECT id FROM candidate_ids) OR EXISTS(SELECT 1 FROM manual_purchase_evidence me JOIN documents md ON md.user_id=me.user_id AND md.id=me.document_id WHERE me.user_id=p.user_id AND me.purchase_id=p.id AND md.content_hash=?)) AND p.record_status!='merged' AND ${guard.sql} ORDER BY p.id LIMIT 101`,
    )
    .bind(
      json(candidates),
      lease.context.userId,
      lease.context.userId,
      lease.context.userId,
      lease.context.userId,
      lease.context.userId,
      lease.context.userId,
      input.identity.contentHash,
      lease.context.userId,
      input.identity.documentId,
      json(keys),
      lease.context.userId,
      lease.context.userId,
      input.identity.contentHash,
      ...guard.values,
    )
    .all<PurchaseRow>();
  if (purchaseRows.results.length > 100)
    throw new PipelinePersistenceError("PIPELINE_LIMIT");
  if (
    purchaseRows.results.some(
      (purchase) =>
        purchase.lifecycle_delete_connection_id !== null ||
        purchase.lifecycle_recompute_connection_id !== null,
    )
  )
    throw new PipelinePersistenceError("PIPELINE_CONFLICT");
  const purchases: LedgerPurchase[] = purchaseRows.results.map((purchase) => ({
    id: purchase.id,
    merchant: purchase.merchant_raw,
    currency: purchase.currency,
    totalMinor: purchase.total_minor,
    documentDate: purchase.document_date,
    invoiceNumber: purchase.invoice_ref,
    orderReference: purchase.order_ref,
    category: purchase.category,
    paymentState: purchase.payment_state,
    recordStatus: purchase.record_status,
    version: purchase.version,
    overriddenFields: z
      .array(
        z.enum([
          "merchant",
          "category",
          "documentDate",
          "totalMinor",
          "currency",
          "invoiceReference",
          "orderReference",
          "paymentState",
        ]),
      )
      .max(20)
      .parse(safeJson(purchase.overrides_json))
      .map((field) => (field === "invoiceReference" ? "invoiceNumber" : field)),
  }));
  // OQ-A: payment state counts current cash plus credit, so load the same
  // credit proofs corrections and the lifecycle recompute use.
  const creditProofs: LedgerCreditProof[] = purchaseRows.results.flatMap(
    (purchase) => {
      const rows = z
        .array(
          z.strictObject({
            currency: z.unknown(),
            total: z.unknown(),
            credit: z.unknown(),
          }),
        )
        .parse(safeJson(purchase.credits_json));
      if (rows.length > 200)
        throw new PipelinePersistenceError("PIPELINE_LIMIT");
      return parseCreditProofRows(rows).map((proof) => ({
        purchaseId: purchase.id,
        ...proof,
      }));
    },
  );
  const ids = json(purchases.map((purchase) => purchase.id));
  const rows = await db
    .prepare(
      `WITH related AS (
          SELECT o.id FROM documents d JOIN observations o ON o.user_id=d.user_id AND o.document_id=d.id WHERE d.user_id=? AND d.content_hash=?
          UNION SELECT id FROM observations WHERE user_id=? AND document_id=?
          UNION SELECT observation_id FROM purchase_evidence WHERE user_id=? AND purchase_id IN (SELECT value FROM json_each(?))
        ) SELECT o.id,o.document_id,o.segment_index,o.extraction_fingerprint,o.structured_fields,d.content_hash,pe.purchase_id FROM observations o JOIN documents d ON d.user_id=o.user_id AND d.id=o.document_id LEFT JOIN purchase_evidence pe ON pe.user_id=o.user_id AND pe.observation_id=o.id WHERE o.user_id=? AND o.id IN (SELECT id FROM related) AND o.structured_fields IS NOT NULL AND ${guard.sql} ORDER BY o.id LIMIT 1001`,
    )
    .bind(
      lease.context.userId,
      input.identity.contentHash,
      lease.context.userId,
      input.identity.documentId,
      lease.context.userId,
      ids,
      lease.context.userId,
      ...guard.values,
    )
    .all<ObservationRow>();
  if (rows.results.length > 1000)
    throw new PipelinePersistenceError("PIPELINE_LIMIT");
  const observations: LedgerObservation[] = rows.results.map((row) => {
    const payload = z
      .strictObject({
        schemaVersion: z.literal(1),
        documentType: z.string(),
        record: z.unknown(),
      })
      .parse(safeJson(row.structured_fields));
    const result = checkedResult({
      status: "accepted",
      documentType: payload.documentType,
      records: [payload.record],
      warnings: [],
    });
    if (result.status !== "accepted" || !result.records[0])
      throw new PipelinePersistenceError("PIPELINE_CONFLICT");
    return {
      id: row.id,
      identity: {
        documentId: row.document_id,
        contentHash: row.content_hash,
        extractionFingerprint: row.extraction_fingerprint,
      },
      segmentIndex: row.segment_index,
      documentType: result.documentType,
      record: result.records[0],
      purchaseId: row.purchase_id,
    };
  });
  const eventRows = await db
    .prepare(
      `WITH related AS (
          SELECT id FROM ledger_entries WHERE user_id=? AND purchase_id IN (SELECT value FROM json_each(?))
          UNION SELECT id FROM ledger_entries WHERE user_id=? AND observation_id IN (SELECT value FROM json_each(?))
          UNION SELECT id FROM ledger_entries WHERE user_id=? AND business_event_key IN (SELECT value FROM json_each(?))
        ) SELECT id,business_event_key,purchase_id,observation_id,kind,amount_minor,currency,event_date,date_basis,eligible,version,origin,(SELECT json_group_object(field,json(original_value_json)) FROM field_overrides fo WHERE fo.user_id=ledger_entries.user_id AND fo.entity_kind='entry' AND fo.entity_id=ledger_entries.id) AS original_values_json,(SELECT json_object('documentId',o.document_id,'evidenceCode',o.evidence_code,'accepted',o.review_state='accepted') FROM observations o WHERE o.user_id=ledger_entries.user_id AND o.id=ledger_entries.observation_id) AS proof_json FROM ledger_entries WHERE user_id=? AND id IN (SELECT id FROM related) AND ${guard.sql} ORDER BY id LIMIT 1001`,
    )
    .bind(
      lease.context.userId,
      ids,
      lease.context.userId,
      json(observations.map((observation) => observation.id)),
      lease.context.userId,
      json(keys),
      lease.context.userId,
      ...guard.values,
    )
    .all<EventRow>();
  if (eventRows.results.length > 1000)
    throw new PipelinePersistenceError("PIPELINE_LIMIT");
  const events: LedgerEvent[] = eventRows.results.map((event) => ({
    id: event.id,
    businessKey: event.business_event_key,
    purchaseId: event.purchase_id,
    observationId: event.observation_id,
    origin: event.origin,
    sourceValues: originalEventValues(event.original_values_json),
    kind: event.kind,
    amountMinor: event.amount_minor,
    currency: event.currency,
    eventDate: event.event_date,
    dateBasis: event.date_basis,
    eligible: event.eligible === 1,
    version: event.version,
    cashProof: cashProof(event.proof_json),
  }));
  const entryIds = json(events.map((event) => event.id));
  // Empty arrays also need a positive authorization check. The source read is cheap and never caches a lease.
  const authorized = await db
    .prepare(
      `SELECT (SELECT json_group_array(json_object('contentHash',content_hash,'segmentIndex',segment_index,'purchaseId',purchase_id,'decision',decision)) FROM (SELECT content_hash,segment_index,purchase_id,decision FROM ledger_match_decisions WHERE user_id=? AND (content_hash=? OR purchase_id IN (SELECT value FROM json_each(?))) ORDER BY content_hash,segment_index,purchase_id LIMIT 1001)) AS decisions,(SELECT json_group_array(json_object('contentHash',content_hash,'purchaseId',purchase_id)) FROM (SELECT DISTINCT md.content_hash,me.purchase_id FROM manual_purchase_evidence me JOIN documents md ON md.user_id=me.user_id AND md.id=me.document_id JOIN purchases mp ON mp.user_id=me.user_id AND mp.id=me.purchase_id WHERE me.user_id=? AND md.content_hash=? AND mp.record_status!='merged' AND mp.lifecycle_delete_connection_id IS NULL ORDER BY me.purchase_id LIMIT 101)) AS manual_evidence,(SELECT json_group_array(json_object('id',id,'observationId',observation_id,'documentId',document_id,'purchaseId',purchase_id,'reason',reason)) FROM (SELECT r.id,r.observation_id,r.document_id,r.purchase_id,r.reason FROM review_items r WHERE r.user_id=? AND r.status='open' AND r.blocking_scope='financial' AND r.reason!='payment-allocation-review' AND (r.purchase_id IN (SELECT value FROM json_each(?)) OR r.document_id=? OR r.observation_id IN (SELECT observation_id FROM ledger_entries WHERE user_id=r.user_id AND id IN (SELECT value FROM json_each(?))) OR (r.observation_id IS NULL AND r.document_id IN (SELECT o.document_id FROM ledger_entries l JOIN observations o ON o.user_id=l.user_id AND o.id=l.observation_id WHERE l.user_id=r.user_id AND l.id IN (SELECT value FROM json_each(?))))) ORDER BY r.id LIMIT 1001)) AS reviews WHERE ${guard.sql}`,
    )
    .bind(
      lease.context.userId,
      input.identity.contentHash,
      ids,
      lease.context.userId,
      input.identity.contentHash,
      lease.context.userId,
      ids,
      input.identity.documentId,
      entryIds,
      entryIds,
      ...guard.values,
    )
    .first<{ decisions: string; manual_evidence: string; reviews: string }>();
  if (!authorized) return null;
  const decisions = z
    .array(
      z.strictObject({
        contentHash: fingerprintSchema,
        segmentIndex: z.number().int().min(0).max(9),
        purchaseId: identifier,
        decision: z.enum(["same-purchase", "different-purchase"]),
      }),
    )
    .max(1000)
    .parse(safeJson(authorized.decisions));
  const manualEvidence = z
    .array(
      z.strictObject({
        contentHash: fingerprintSchema,
        purchaseId: identifier,
      }),
    )
    .max(100)
    .parse(safeJson(authorized.manual_evidence));
  // OQ-B: the open financial reviews corrections would apply to this cash
  // (purchase-scoped, entry observation/document, or the current document).
  const reviews: LedgerCashReview[] = z
    .array(
      z.strictObject({
        id: identifier,
        observationId: identifier.nullable(),
        documentId: identifier.nullable(),
        purchaseId: identifier.nullable(),
        reason: z.enum(LEDGER_REVIEW_REASONS),
      }),
    )
    .max(1000)
    .parse(safeJson(authorized.reviews));
  return {
    observations,
    purchases,
    events,
    decisions,
    manualEvidence,
    creditProofs,
    reviews,
  };
}
