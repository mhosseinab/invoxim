import {
  hasControlCharacters,
  supportedExtractionPrompt,
} from "@invoxim/contracts";
import type {
  JobLease,
  LedgerEvent,
  LedgerInput,
  LedgerObservation,
  LedgerPlan,
  LedgerPurchase,
  LedgerSnapshot,
  PersistableAiResult,
} from "@invoxim/core";
import {
  calendarDate,
  ledgerEventKey,
  normalizeLedgerMerchant,
  parseMoney,
  validatePersistableAiResult,
} from "@invoxim/core";
import { z } from "zod";
import type { ProcessingReviewMetadata } from "../onboarding/processing-readiness";
import {
  cachedGuard as baseCachedGuard,
  liveGuard as baseLiveGuard,
  liveWhere as baseLiveWhere,
  executeBatch,
  LIVE_FROM,
  PipelinePersistenceError,
  type Predicate,
} from "./repository-guards";

export interface CachedExtractionCompatibility {
  readonly extractionVersion: string;
  readonly configurationDigest: string;
  readonly policyVersion: number;
}

export interface PipelineDocumentMetadata {
  readonly id: string;
  readonly partKey: string;
  readonly contentHash: string;
  readonly mime: string;
  readonly byteLength: number;
  readonly parseState:
    | "ready"
    | "extracted"
    | "needs_review"
    | "unsupported"
    | "unreadable"
    | "incomplete";
  readonly parserVersion: string;
  readonly code?: string;
}
export interface PipelineWork {
  readonly sourceId: string;
  readonly providerMessageId: string;
  readonly settingsRevision: number;
  readonly disclosureVersion: number;
  readonly stage: "parse" | "infer" | "reconcile";
  readonly documentIndex: number;
  readonly documents: readonly PipelineDocumentMetadata[];
  readonly extractionFingerprint: string | null;
  readonly previousFinancialExtraction?: {
    readonly fingerprint: string;
    readonly extractionVersion: string;
    readonly completed: boolean;
  };
}
export interface PipelineAdvance {
  readonly stage: "infer" | "reconcile";
  readonly documentIndex: number;
  readonly extractionFingerprint?: string;
}
export interface PipelineCommit {
  readonly input: LedgerInput;
  readonly plan: LedgerPlan;
  readonly nextDocumentIndex: number | null;
}
export interface PipelineRepository {
  skipDocument?(
    lease: JobLease,
    outcome: {
      documentId: string;
      classificationFingerprint: string;
      nextDocumentIndex: number | null;
    },
  ): Promise<"committed" | "stale">;
  skipSource?(
    lease: JobLease,
    classificationFingerprint: string,
  ): Promise<"committed" | "stale">;
  failDocument(
    lease: JobLease,
    outcome: {
      documentId: string;
      code: string;
      nextDocumentIndex: number | null;
    },
  ): Promise<"committed" | "stale">;
  load(lease: JobLease): Promise<PipelineWork | null>;
  checkpoint(lease: JobLease): Promise<boolean>;
  stageDocuments(
    lease: JobLease,
    documents: readonly PipelineDocumentMetadata[],
  ): Promise<"committed" | "stale">;
  advance(
    lease: JobLease,
    next: PipelineAdvance,
  ): Promise<"committed" | "stale">;
  cachedResult(
    lease: JobLease,
    documentId: string,
    fingerprint: string,
    compatibility?: CachedExtractionCompatibility,
  ): Promise<PersistableAiResult | null>;
  loadSnapshot(
    lease: JobLease,
    input: LedgerInput,
  ): Promise<LedgerSnapshot | null>;
  commit(
    lease: JobLease,
    input: PipelineCommit,
  ): Promise<"committed" | "stale">;
  fail(
    lease: JobLease,
    outcome: { status: "review" | "unsupported" | "failed"; code: string },
  ): Promise<"committed" | "stale">;
}

const identifier = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !hasControlCharacters(value));
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
const metadataSchema = z
  .strictObject({
    id: identifier,
    partKey: z
      .string()
      .max(256)
      .refine((value) => !hasControlCharacters(value)),
    contentHash: fingerprintSchema,
    mime: z
      .string()
      .max(100)
      .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
    byteLength: z.number().int().min(0).max(4194304),
    parseState: z.enum([
      "ready",
      "extracted",
      "needs_review",
      "unsupported",
      "unreadable",
      "incomplete",
    ]),
    parserVersion: z.string().min(1).max(120),
    code: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .optional(),
  })
  .refine(
    (document) =>
      !["ready", "extracted"].includes(document.parseState) ||
      [
        "application/pdf",
        "text/plain",
        "text/html",
        "image/png",
        "image/jpeg",
        "image/webp",
      ].includes(document.mime) ||
      (document.parserVersion === "documents-direct-v1" &&
        [
          "multipart/alternative",
          "multipart/mixed",
          "multipart/related",
        ].includes(document.mime)),
    "Unsupported ready document MIME",
  );
type SourceRow = {
  source_id: string;
  provider_message_id: string;
  ai_settings_revision: number;
  disclosure_version: number;
  pipeline_stage: PipelineWork["stage"];
  document_index: number;
  extraction_fingerprint: string | null;
  documents: string;
  processing_selection?: string;
  previous_extraction?: string | null;
};
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
};
function originalEventValues(
  encoded: string,
): NonNullable<LedgerEvent["sourceValues"]> {
  const amount = z
    .union([
      z.number().int().min(0).max(9000000000000),
      z
        .string()
        .regex(/^(0|[1-9][0-9]*)$/)
        .max(13),
    ])
    .transform((value) => Number(value))
    .refine((value) => value <= 9000000000000);
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
      currency: z
        .string()
        .refine((value) => {
          try {
            parseMoney("0", value);
            return true;
          } catch {
            return false;
          }
        })
        .optional(),
      eventDate: z
        .string()
        .refine((value) => {
          try {
            calendarDate(value);
            return true;
          } catch {
            return false;
          }
        })
        .optional(),
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
function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (
    encoded === undefined ||
    new TextEncoder().encode(encoded).length > 262144
  )
    throw new PipelinePersistenceError("PIPELINE_LIMIT");
  return encoded;
}
function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new PipelinePersistenceError("PIPELINE_CONFLICT");
  }
}
function checkedResult(value: unknown): PersistableAiResult {
  const result = validatePersistableAiResult(value);
  if (!result) throw new PipelinePersistenceError("INVALID_PIPELINE");
  return result;
}
function checkedInput(input: LedgerInput): void {
  identifier.parse(input.identity.documentId);
  fingerprintSchema.parse(input.identity.contentHash);
  fingerprintSchema.parse(input.identity.extractionFingerprint);
  checkedResult(input.result);
}
function monetary(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 9000000000000)
    throw new PipelinePersistenceError("INVALID_PIPELINE");
}
function validatePlan(input: LedgerInput, plan: LedgerPlan): void {
  checkedInput(input);
  if (
    plan.observations.length > 10 ||
    plan.purchases.length > 10 ||
    plan.events.length > 20 ||
    plan.evidence.length > 10 ||
    plan.reviews.length > 50 ||
    plan.expectedPurchases.length > 100 ||
    plan.paymentStates.length > 100
  )
    throw new PipelinePersistenceError("PIPELINE_LIMIT");
  for (const observation of plan.observations) {
    identifier.parse(observation.id);
    if (
      observation.identity.documentId !== input.identity.documentId ||
      observation.identity.contentHash !== input.identity.contentHash ||
      observation.identity.extractionFingerprint !==
        input.identity.extractionFingerprint ||
      input.result.status !== "accepted" ||
      !Number.isInteger(observation.segmentIndex) ||
      observation.segmentIndex < 0 ||
      observation.segmentIndex >= input.result.records.length ||
      json(observation.record) !==
        json(input.result.records[observation.segmentIndex]) ||
      observation.documentType !== input.result.documentType
    )
      throw new PipelinePersistenceError("INVALID_PIPELINE");
    checkedResult({
      status: "accepted",
      documentType: observation.documentType,
      records: [observation.record],
      warnings: [],
    });
  }
  for (const purchase of plan.purchases) {
    identifier.parse(purchase.id);
    if (purchase.totalMinor === null || purchase.currency === null)
      throw new PipelinePersistenceError("INVALID_PIPELINE");
    monetary(purchase.totalMinor);
    calendarDate(purchase.documentDate);
    parseMoney("0", purchase.currency);
    if (
      purchase.version !== 1 ||
      purchase.merchant.length > 200 ||
      purchase.merchant.trim().length === 0
    )
      throw new PipelinePersistenceError("INVALID_PIPELINE");
  }
  for (const event of plan.events) {
    identifier.parse(event.id);
    identifier.parse(event.businessKey);
    monetary(event.amountMinor);
    calendarDate(event.eventDate);
    parseMoney("0", event.currency);
    if (
      !plan.observations.some(
        (observation) => observation.id === event.observationId,
      ) ||
      !["payment", "refund"].includes(event.kind) ||
      !["explicit-event-date", "document-date"].includes(event.dateBasis) ||
      event.version !== 1
    )
      throw new PipelinePersistenceError("INVALID_PIPELINE");
  }
  for (const review of plan.reviews)
    if (
      review.documentId !== input.identity.documentId ||
      review.blockingScope !== "financial"
    )
      throw new PipelinePersistenceError("INVALID_PIPELINE");
  for (const expected of plan.expectedPurchases) {
    identifier.parse(expected.id);
    if (!Number.isSafeInteger(expected.version) || expected.version < 1)
      throw new PipelinePersistenceError("INVALID_PIPELINE");
  }
  if (
    new Set(plan.expectedPurchases.map((item) => item.id)).size !==
      plan.expectedPurchases.length ||
    new Set(plan.paymentStates.map((item) => item.purchaseId)).size !==
      plan.paymentStates.length
  )
    throw new PipelinePersistenceError("INVALID_PIPELINE");
  for (const state of plan.paymentStates)
    if (
      !plan.expectedPurchases.some(
        (expected) =>
          expected.id === state.purchaseId &&
          expected.version === state.expectedVersion,
      ) ||
      !["unknown", "unpaid", "partially_paid", "paid"].includes(
        state.paymentState,
      )
    )
      throw new PipelinePersistenceError("INVALID_PIPELINE");
}
async function continuationKey(
  lease: JobLease,
  sourceId: string,
  next: PipelineAdvance,
): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      json([
        lease.context.userId,
        sourceId,
        lease.connectionId,
        lease.generation,
        lease.consentId,
        lease.type,
        next.stage,
        next.documentIndex,
        next.extractionFingerprint ?? null,
      ]),
    ),
  );
  return `pipeline:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export type PipelineProcessingSelection = ProcessingReviewMetadata;

/**
 * Single source-status derivation shared by `commit` and `skipDocument`
 * (P3/P0.5). A document whose parse_state is outside {ready, extracted} is
 * unresolved content and keeps the source at 'review', so a non-purchase skip
 * cannot discard a source that a financial commit would leave reviewable.
 */
const SOURCE_STATUS_CASE = `CASE WHEN EXISTS(SELECT 1 FROM review_items r JOIN documents d ON d.user_id=r.user_id AND d.id=r.document_id WHERE r.user_id=source_messages.user_id AND d.source_message_id=source_messages.id AND r.status='open') OR EXISTS(SELECT 1 FROM documents d WHERE d.user_id=source_messages.user_id AND d.source_message_id=source_messages.id AND d.parse_state NOT IN('ready','extracted')) THEN 'review' WHEN EXISTS(SELECT 1 FROM documents d WHERE d.user_id=source_messages.user_id AND d.source_message_id=source_messages.id AND d.parse_state='ready') THEN 'discovered' WHEN EXISTS(SELECT 1 FROM documents d WHERE d.user_id=source_messages.user_id AND d.source_message_id=source_messages.id AND d.parse_state='extracted') THEN 'processed' ELSE 'unsupported' END`;

export function createPipelineRepository(
  db: D1Database,
  options: {
    clock?: () => number;
    remainingStatements?: () => number;
    processingDigest?: (
      selection: PipelineProcessingSelection,
    ) => Promise<string | null>;
  } = {},
): PipelineRepository {
  const clock = options.clock ?? Date.now;
  const acceptedDigests = new Map<string, string>();
  const compatibleCaches = new Map<string, CachedExtractionCompatibility>();
  const selectionProjection = `json_object('mode',a.mode,'settingsRevision',a.revision,'providerId',a.provider_id,'modelId',a.model_id,'configVersion',a.config_version,'policyVersion',a.consent_version,'acceptedDigest',pc.accepted_configuration_digest)`;
  function leaseKey(lease: JobLease) {
    return JSON.stringify([
      lease.context.userId,
      lease.jobId,
      lease.leaseId,
      lease.fence,
    ]);
  }
  async function acceptSelection(lease: JobLease, encoded: string | undefined) {
    if (!options.processingDigest) return true;
    acceptedDigests.delete(leaseKey(lease));
    if (!encoded) return false;
    const selection = z
      .strictObject({
        mode: z.enum(["hosted", "byok"]).nullable(),
        settingsRevision: z.number().int().positive(),
        providerId: z.string().nullable(),
        modelId: z.string().nullable(),
        configVersion: z.string().nullable(),
        policyVersion: z.number().int().nonnegative(),
        acceptedDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      })
      .parse(safeJson(encoded));
    const expected = await options.processingDigest(selection);
    if (!expected || expected !== selection.acceptedDigest) return false;
    acceptedDigests.set(leaseKey(lease), expected);
    return true;
  }
  function reviewed(lease: JobLease, predicate: Predicate): Predicate {
    if (!options.processingDigest) return predicate;
    const expected = acceptedDigests.get(leaseKey(lease));
    if (!expected) return { sql: "0", values: [] };
    return {
      sql: `(${predicate.sql}) AND EXISTS(SELECT 1 FROM processing_consents reviewed WHERE reviewed.user_id=? AND reviewed.id=? AND reviewed.accepted_configuration_digest=?)`,
      values: [
        ...predicate.values,
        lease.context.userId,
        lease.consentId,
        expected,
      ],
    };
  }
  function liveGuard(lease: JobLease, now: number) {
    return reviewed(lease, baseLiveGuard(lease, now));
  }
  function cacheKey(lease: JobLease, documentId: string, fingerprint: string) {
    return JSON.stringify([leaseKey(lease), documentId, fingerprint]);
  }
  function cachedGuard(
    lease: JobLease,
    now: number,
    documentId: string,
    fingerprint: string,
    compatibility = compatibleCaches.get(
      cacheKey(lease, documentId, fingerprint),
    ),
  ): Predicate {
    const base = reviewed(
      lease,
      baseCachedGuard(lease, now, documentId, fingerprint),
    );
    if (!compatibility) return base;
    return {
      sql: `(${base.sql}) AND EXISTS(SELECT 1 FROM ai_extractions compatible JOIN usage_events ev ON ev.user_id=compatible.user_id AND ev.run_key=compatible.run_key WHERE compatible.user_id=? AND compatible.document_id=? AND compatible.run_key=? AND compatible.extraction_version=? AND json_extract(ev.price_snapshot,'$.configurationDigest')=? AND json_extract(ev.price_snapshot,'$.policyVersion')=?${options.processingDigest ? " AND json_extract(ev.price_snapshot,'$.acceptedConfigurationDigest')=?" : ""})`,
      values: [
        ...base.values,
        lease.context.userId,
        documentId,
        fingerprint,
        compatibility.extractionVersion,
        compatibility.configurationDigest,
        compatibility.policyVersion,
        ...(options.processingDigest
          ? [acceptedDigests.get(leaseKey(lease)) ?? ""]
          : []),
      ],
    };
  }

  function batch(
    statements: D1PreparedStatement[],
    settlementHeadroom = 2,
  ): Promise<"committed" | "stale"> {
    if (
      options.remainingStatements &&
      options.remainingStatements() < statements.length + settlementHeadroom
    )
      throw new PipelinePersistenceError("PIPELINE_LIMIT");
    return executeBatch(db, statements);
  }
  function stmt(
    sql: string,
    values: (string | number | null)[],
    guard: Predicate,
  ): D1PreparedStatement {
    return db.prepare(sql).bind(...values, ...guard.values);
  }
  function complete(
    lease: JobLease,
    guard: Predicate,
    code: string,
  ): D1PreparedStatement {
    return stmt(
      `UPDATE jobs SET status='completed',lease_id=NULL,lease_expires_at=NULL,outcome_code=? WHERE user_id=? AND id=? AND ${guard.sql}`,
      [code, lease.context.userId, lease.jobId],
      guard,
    );
  }
  const previousFinancialProjection = `(SELECT json_object('fingerprint',e.run_key,'extractionVersion',e.extraction_version,'completed',json(CASE WHEN e.completed_at IS NOT NULL THEN 'true' ELSE 'false' END)) FROM ai_extractions e JOIN documents prior ON prior.user_id=e.user_id AND prior.id=e.document_id WHERE prior.user_id=sm.user_id AND prior.source_message_id=sm.id AND prior.pipeline_index=dj.document_index AND e.purpose='extraction' AND e.content_hash=prior.content_hash AND e.extraction_version LIKE 'invoice-extraction-v%' AND EXISTS(SELECT 1 FROM usage_events paid WHERE paid.user_id=e.user_id AND paid.run_key=e.run_key AND paid.state IN ('sent','known','uncertain','overrun')) ORDER BY e.created_at DESC,e.run_key LIMIT 1)`;
  async function load(lease: JobLease): Promise<PipelineWork | null> {
    const where = baseLiveWhere(lease, clock());
    const row = await db
      .prepare(
        `SELECT sm.id AS source_id,sm.provider_message_id,pc.ai_settings_revision,pc.disclosure_version,${previousFinancialProjection} AS previous_extraction,dj.pipeline_stage,dj.document_index,dj.extraction_fingerprint,${options.processingDigest ? `${selectionProjection} AS processing_selection,` : ""}(SELECT COALESCE(json_group_array(json_object('id',dd.id,'partKey',dd.part_key,'contentHash',dd.content_hash,'mime',dd.mime,'byteLength',dd.byte_length,'parseState',dd.parse_state,'parserVersion',dd.parser_version,'code',dd.parse_code)),'[]') FROM (SELECT id,part_key,content_hash,mime,byte_length,parse_state,parser_version,parse_code FROM documents WHERE user_id=sm.user_id AND source_message_id=sm.id AND pipeline_index IS NOT NULL ORDER BY pipeline_index LIMIT 65) dd) AS documents FROM ${LIVE_FROM} WHERE ${where.sql}`,
      )
      .bind(...where.values)
      .first<SourceRow>();
    if (!row || !(await acceptSelection(lease, row.processing_selection)))
      return null;
    const raw = z
      .array(z.record(z.string(), z.unknown()))
      .max(64)
      .parse(safeJson(row.documents));
    const documents = raw.map((document): PipelineDocumentMetadata => {
      const { code, ...metadata } = metadataSchema.parse({
        ...document,
        ...(document.code === null ? { code: undefined } : {}),
      });
      return code === undefined ? metadata : { ...metadata, code };
    });
    const previous = row.previous_extraction
      ? z
          .strictObject({
            fingerprint: fingerprintSchema,
            extractionVersion: z.string().min(1).max(120),
            completed: z.boolean(),
          })
          .parse(safeJson(row.previous_extraction))
      : undefined;
    return {
      ...(previous ? { previousFinancialExtraction: previous } : {}),
      sourceId: row.source_id,
      providerMessageId: row.provider_message_id,
      settingsRevision: row.ai_settings_revision,
      disclosureVersion: row.disclosure_version,
      stage: row.pipeline_stage,
      documentIndex: row.document_index,
      documents,
      extractionFingerprint: row.extraction_fingerprint,
    };
  }
  async function continuation(
    lease: JobLease,
    next: PipelineAdvance,
    guard: Predicate,
  ): Promise<D1PreparedStatement[]> {
    if (
      !Number.isInteger(next.documentIndex) ||
      next.documentIndex < 0 ||
      next.documentIndex > 63 ||
      !["infer", "reconcile"].includes(next.stage)
    )
      throw new PipelinePersistenceError("INVALID_PIPELINE");
    if (next.extractionFingerprint !== undefined)
      fingerprintSchema.parse(next.extractionFingerprint);
    if (next.stage === "reconcile" && !next.extractionFingerprint)
      throw new PipelinePersistenceError("INVALID_PIPELINE");
    // Trusted source lookup is part of each INSERT; IDs and immutable cursor fields alone survive the stage.
    const source = await db
      .prepare(
        `SELECT dj.source_message_id FROM discovery_source_jobs dj WHERE dj.user_id=? AND dj.job_id=? AND ${guard.sql}`,
      )
      .bind(lease.context.userId, lease.jobId, ...guard.values)
      .first<string>("source_message_id");
    if (!source) return [];
    const dedupe = await continuationKey(lease, source, next);
    return [
      stmt(
        `INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,priority) SELECT ?,?,?,?,?,?,?,'ready',?,(SELECT priority FROM jobs WHERE user_id=? AND id=?) WHERE ${guard.sql} ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
        [
          crypto.randomUUID(),
          lease.context.userId,
          lease.connectionId,
          lease.consentId,
          lease.generation,
          lease.type,
          dedupe,
          clock(),
          lease.context.userId,
          lease.jobId,
        ],
        guard,
      ),
      stmt(
        `INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id,pipeline_stage,document_index,extraction_fingerprint) SELECT ?,(SELECT id FROM jobs WHERE user_id=? AND dedupe_key=?),?,?,?,? WHERE ${guard.sql} ON CONFLICT(user_id,job_id) DO NOTHING`,
        [
          lease.context.userId,
          lease.context.userId,
          dedupe,
          source,
          next.stage,
          next.documentIndex,
          next.extractionFingerprint ?? null,
        ],
        guard,
      ),
    ];
  }
  async function advance(
    lease: JobLease,
    next: PipelineAdvance,
  ): Promise<"committed" | "stale"> {
    const guard = liveGuard(lease, clock());
    const statements = await continuation(lease, next, guard);
    if (!statements.length) return "stale";
    return batch([...statements, complete(lease, guard, "pipeline_staged")]);
  }
  async function stageDocuments(
    lease: JobLease,
    input: readonly PipelineDocumentMetadata[],
  ): Promise<"committed" | "stale"> {
    const documents = z.array(metadataSchema).min(1).max(64).parse(input);
    if (
      new Set(documents.map((document) => document.partKey)).size !==
        documents.length ||
      new Set(documents.map((document) => document.id)).size !==
        documents.length ||
      documents.some((document) => document.parseState === "extracted")
    )
      throw new PipelinePersistenceError("INVALID_PIPELINE");
    const guard = liveGuard(lease, clock());
    guard.sql += ` AND EXISTS(SELECT 1 FROM discovery_source_jobs WHERE user_id=? AND job_id=? AND pipeline_stage='parse')`;
    guard.values.push(lease.context.userId, lease.jobId);
    const follow = await continuation(
      lease,
      { stage: "infer", documentIndex: 0 },
      guard,
    );
    if (!follow.length) return "stale";
    const insert = stmt(
      `INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length,parse_state,pipeline_index,parser_version,parse_code) SELECT json_extract(value,'$.id'),?,(SELECT source_message_id FROM discovery_source_jobs WHERE user_id=? AND job_id=?),json_extract(value,'$.partKey'),json_extract(value,'$.contentHash'),json_extract(value,'$.mime'),json_extract(value,'$.byteLength'),json_extract(value,'$.parseState'),CAST(key AS INTEGER),json_extract(value,'$.parserVersion'),json_extract(value,'$.code') FROM json_each(?) WHERE ${guard.sql} ON CONFLICT(user_id,source_message_id,part_key) DO UPDATE SET content_hash=CASE WHEN documents.content_hash=excluded.content_hash AND documents.mime=excluded.mime AND documents.byte_length=excluded.byte_length AND (documents.pipeline_index IS NULL OR documents.pipeline_index=excluded.pipeline_index) THEN documents.content_hash ELSE NULL END,pipeline_index=excluded.pipeline_index,parser_version=excluded.parser_version,parse_state=excluded.parse_state,parse_code=excluded.parse_code`,
      [
        lease.context.userId,
        lease.context.userId,
        lease.jobId,
        json(documents),
      ],
      guard,
    );
    return batch([
      insert,
      ...follow,
      complete(lease, guard, "documents_staged"),
    ]);
  }
  async function cachedResult(
    lease: JobLease,
    documentId: string,
    fingerprint: string,
    compatibility?: CachedExtractionCompatibility,
  ): Promise<PersistableAiResult | null> {
    identifier.parse(documentId);
    fingerprintSchema.parse(fingerprint);
    if (
      compatibility &&
      (!supportedExtractionPrompt(compatibility.extractionVersion) ||
        !/^[a-f0-9]{64}$/.test(compatibility.configurationDigest) ||
        !Number.isSafeInteger(compatibility.policyVersion) ||
        compatibility.policyVersion < 1)
    )
      return null;
    const guard = cachedGuard(
      lease,
      clock(),
      documentId,
      fingerprint,
      compatibility,
    );
    const row = await db
      .prepare(
        `SELECT result_json FROM ai_extractions WHERE user_id=? AND document_id=? AND run_key=? AND ${guard.sql}`,
      )
      .bind(lease.context.userId, documentId, fingerprint, ...guard.values)
      .first<string>("result_json");
    if (!row) return null;
    const result = checkedResult(safeJson(row));
    // Recheck the exact compatibility tuple on every subsequent snapshot/commit write.
    if (compatibility)
      compatibleCaches.set(cacheKey(lease, documentId, fingerprint), {
        ...compatibility,
      });
    return result;
  }
  function inputGuard(lease: JobLease, input: LedgerInput): Predicate {
    checkedInput(input);
    const now = clock();
    const base = liveGuard(lease, now);
    const validCache = cachedGuard(
      lease,
      now,
      input.identity.documentId,
      input.identity.extractionFingerprint,
    );
    return {
      sql: `${base.sql} AND EXISTS(SELECT 1 FROM documents d JOIN discovery_source_jobs dj ON dj.user_id=d.user_id AND dj.source_message_id=d.source_message_id WHERE d.user_id=? AND d.id=? AND d.content_hash=? AND dj.job_id=? AND d.pipeline_index=dj.document_index AND ((dj.pipeline_stage='reconcile' AND dj.extraction_fingerprint=?) OR (dj.pipeline_stage='infer' AND d.parse_state IN ('needs_review','unsupported','unreadable','incomplete') AND ?='needs-review'))) AND (${validCache.sql} AND EXISTS(SELECT 1 FROM ai_extractions WHERE user_id=? AND run_key=? AND result_json=?) OR (?='needs-review' AND EXISTS(SELECT 1 FROM documents WHERE user_id=? AND id=? AND parse_state IN ('needs_review','unsupported','unreadable','incomplete'))))`,
      values: [
        ...base.values,
        lease.context.userId,
        input.identity.documentId,
        input.identity.contentHash,
        lease.jobId,
        input.identity.extractionFingerprint,
        input.result.status,
        ...validCache.values,
        lease.context.userId,
        input.identity.extractionFingerprint,
        json(checkedResult(input.result)),
        input.result.status,
        lease.context.userId,
        input.identity.documentId,
      ],
    };
  }
  async function loadSnapshot(
    lease: JobLease,
    input: LedgerInput,
  ): Promise<LedgerSnapshot | null> {
    const guard = inputGuard(lease, input);
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
        ) SELECT p.id,p.merchant_raw,p.currency,p.total_minor,p.document_date,p.invoice_ref,p.order_ref,p.category,p.payment_state,p.record_status,p.lifecycle_delete_connection_id,p.lifecycle_recompute_connection_id,p.version,(SELECT json_group_array(field) FROM (SELECT field FROM field_overrides fo WHERE fo.user_id=p.user_id AND fo.entity_kind='purchase' AND fo.entity_id=p.id ORDER BY field LIMIT 21)) AS overrides_json FROM purchases p WHERE p.user_id=? AND (p.id IN (SELECT id FROM candidate_ids) OR EXISTS(SELECT 1 FROM manual_purchase_evidence me JOIN documents md ON md.user_id=me.user_id AND md.id=me.document_id WHERE me.user_id=p.user_id AND me.purchase_id=p.id AND md.content_hash=?)) AND p.record_status!='merged' AND ${guard.sql} ORDER BY p.id LIMIT 101`,
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
    const purchases: LedgerPurchase[] = purchaseRows.results.map(
      (purchase) => ({
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
          .map((field) =>
            field === "invoiceReference" ? "invoiceNumber" : field,
          ),
      }),
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
        ) SELECT id,business_event_key,purchase_id,observation_id,kind,amount_minor,currency,event_date,date_basis,eligible,version,origin,(SELECT json_group_object(field,json(original_value_json)) FROM field_overrides fo WHERE fo.user_id=ledger_entries.user_id AND fo.entity_kind='entry' AND fo.entity_id=ledger_entries.id) AS original_values_json FROM ledger_entries WHERE user_id=? AND id IN (SELECT id FROM related) AND ${guard.sql} ORDER BY id LIMIT 1001`,
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
    }));
    // Empty arrays also need a positive authorization check. The source read is cheap and never caches a lease.
    const authorized = await db
      .prepare(
        `SELECT (SELECT json_group_array(json_object('contentHash',content_hash,'segmentIndex',segment_index,'purchaseId',purchase_id,'decision',decision)) FROM (SELECT content_hash,segment_index,purchase_id,decision FROM ledger_match_decisions WHERE user_id=? AND (content_hash=? OR purchase_id IN (SELECT value FROM json_each(?))) ORDER BY content_hash,segment_index,purchase_id LIMIT 1001)) AS decisions,(SELECT json_group_array(json_object('contentHash',content_hash,'purchaseId',purchase_id)) FROM (SELECT DISTINCT md.content_hash,me.purchase_id FROM manual_purchase_evidence me JOIN documents md ON md.user_id=me.user_id AND md.id=me.document_id JOIN purchases mp ON mp.user_id=me.user_id AND mp.id=me.purchase_id WHERE me.user_id=? AND md.content_hash=? AND mp.record_status!='merged' AND mp.lifecycle_delete_connection_id IS NULL ORDER BY me.purchase_id LIMIT 101)) AS manual_evidence WHERE ${guard.sql}`,
      )
      .bind(
        lease.context.userId,
        input.identity.contentHash,
        ids,
        lease.context.userId,
        input.identity.contentHash,
        ...guard.values,
      )
      .first<{ decisions: string; manual_evidence: string }>();
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
    return { observations, purchases, events, decisions, manualEvidence };
  }
  function versionGuard(
    guard: Predicate,
    lease: JobLease,
    plan: LedgerPlan,
    advanced = false,
  ): Predicate {
    const expected = plan.expectedPurchases.map((purchase) => ({
      id: purchase.id,
      version:
        purchase.version +
        (advanced &&
        plan.paymentStates.some((state) => state.purchaseId === purchase.id)
          ? 1
          : 0),
    }));
    return {
      sql: `${guard.sql} AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM purchases WHERE user_id=? AND id=json_extract(expected.value,'$.id') AND version=json_extract(expected.value,'$.version') AND lifecycle_delete_connection_id IS NULL AND lifecycle_recompute_connection_id IS NULL))`,
      values: [...guard.values, json(expected), lease.context.userId],
    };
  }
  function importProjection(
    lease: JobLease,
    guard: Predicate,
  ): D1PreparedStatement {
    const userId = lease.context.userId;
    return stmt(
      `UPDATE import_runs SET processed_count=(SELECT COUNT(*) FROM discovery_run_sources r JOIN source_messages s ON s.user_id=r.user_id AND s.id=r.source_message_id WHERE r.user_id=import_runs.user_id AND r.import_run_id=import_runs.id AND s.processing_status='processed'),first_usable_at=COALESCE(first_usable_at,CASE WHEN EXISTS(SELECT 1 FROM discovery_run_sources r JOIN documents d ON d.user_id=r.user_id AND d.source_message_id=r.source_message_id JOIN observations o ON o.user_id=d.user_id AND o.document_id=d.id JOIN purchase_evidence pe ON pe.user_id=o.user_id AND pe.observation_id=o.id JOIN purchases p ON p.user_id=pe.user_id AND p.id=pe.purchase_id WHERE r.user_id=import_runs.user_id AND r.import_run_id=import_runs.id AND o.review_state='accepted') THEN ? ELSE NULL END) WHERE user_id=? AND connection_id=? AND consent_id=? AND connection_generation=? AND id IN (SELECT import_run_id FROM discovery_run_sources WHERE user_id=? AND source_message_id=(SELECT source_message_id FROM discovery_source_jobs WHERE user_id=? AND job_id=?)) AND ${guard.sql}`,
      [
        clock(),
        userId,
        lease.connectionId,
        lease.consentId,
        lease.generation,
        userId,
        userId,
        lease.jobId,
      ],
      guard,
    );
  }
  async function commit(
    lease: JobLease,
    operation: PipelineCommit,
  ): Promise<"committed" | "stale"> {
    const { input, plan, nextDocumentIndex } = operation;
    validatePlan(input, plan);
    const guard = versionGuard(inputGuard(lease, input), lease, plan);
    const statements: D1PreparedStatement[] = [];
    const add = (sql: string, values: (string | number | null)[]) =>
      statements.push(stmt(sql, values, guard));
    const userId = lease.context.userId;
    const observations = plan.observations.map((observation) => ({
      id: observation.id,
      documentId: observation.identity.documentId,
      segment: observation.segmentIndex,
      fingerprint: observation.identity.extractionFingerprint,
      evidenceCode:
        observation.record.paymentEvidence === "explicitly-paid"
          ? "explicitly-paid"
          : observation.record.refundEvidence === "completed"
            ? "completed-refund"
            : "invoice-only",
      normalized: json({
        schemaVersion: 1,
        merchant: observation.record.merchant,
        date: observation.record.documentDate,
        totalMinor:
          observation.record.currency === null
            ? null
            : (parseMoney(
                observation.record.total,
                observation.record.currency,
              )?.toString() ?? null),
        currency: observation.record.currency,
      }),
      structured: json({
        schemaVersion: 1,
        documentType: observation.documentType,
        record: observation.record,
      }),
      merchantKey:
        observation.record.merchant === null
          ? null
          : normalizeLedgerMerchant(observation.record.merchant),
      invoice: observation.record.invoiceNumber,
      order: observation.record.orderReference,
      reviewState: plan.reviews.some(
        (review) => review.observationId === observation.id,
      )
        ? "needs_review"
        : "accepted",
    }));
    if (observations.length)
      add(
        `INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,structured_fields,merchant_key,invoice_ref,order_ref,review_state) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.documentId'),json_extract(value,'$.segment'),json_extract(value,'$.fingerprint'),1,json_extract(value,'$.evidenceCode'),json_extract(value,'$.normalized'),json_extract(value,'$.structured'),json_extract(value,'$.merchantKey'),json_extract(value,'$.invoice'),json_extract(value,'$.order'),json_extract(value,'$.reviewState') FROM json_each(?) WHERE ${guard.sql} ON CONFLICT(user_id,document_id,segment_index,extraction_fingerprint) DO UPDATE SET normalized_fields=CASE WHEN observations.normalized_fields=excluded.normalized_fields AND observations.structured_fields=excluded.structured_fields AND observations.evidence_code=excluded.evidence_code THEN observations.normalized_fields ELSE NULL END`,
        [userId, json(observations)],
      );
    if (plan.purchases.length)
      add(
        `INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,invoice_ref,order_ref,document_date,total_minor,currency,category,payment_state,version) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.merchant'),json_extract(value,'$.merchantKey'),json_extract(value,'$.invoiceNumber'),json_extract(value,'$.orderReference'),json_extract(value,'$.documentDate'),json_extract(value,'$.totalMinor'),json_extract(value,'$.currency'),json_extract(value,'$.category'),json_extract(value,'$.paymentState'),1 FROM json_each(?) WHERE ${guard.sql} ON CONFLICT(user_id,id) DO UPDATE SET total_minor=-1`,
        [
          userId,
          json(
            plan.purchases.map((purchase) => ({
              ...purchase,
              merchantKey: normalizeLedgerMerchant(purchase.merchant),
            })),
          ),
        ],
      );
    if (plan.evidence.length)
      add(
        `INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) SELECT ?,json_extract(value,'$.purchaseId'),json_extract(value,'$.observationId'),'document' FROM json_each(?) WHERE ${guard.sql} ON CONFLICT(user_id,observation_id) DO UPDATE SET relationship=CASE WHEN purchase_evidence.purchase_id=excluded.purchase_id THEN purchase_evidence.relationship ELSE NULL END`,
        [userId, json(plan.evidence)],
      );
    if (plan.events.length)
      add(
        `INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,version) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.purchaseId'),json_extract(value,'$.observationId'),json_extract(value,'$.businessKey'),json_extract(value,'$.kind'),json_extract(value,'$.amountMinor'),json_extract(value,'$.currency'),json_extract(value,'$.eventDate'),json_extract(value,'$.dateBasis'),json_extract(value,'$.eligible'),1 FROM json_each(?) WHERE ${guard.sql} ON CONFLICT(user_id,business_event_key) DO UPDATE SET amount_minor=CASE WHEN ledger_entries.purchase_id IS excluded.purchase_id AND ledger_entries.kind=excluded.kind AND ledger_entries.amount_minor=excluded.amount_minor AND ledger_entries.currency=excluded.currency AND ledger_entries.event_date=excluded.event_date AND ledger_entries.date_basis=excluded.date_basis AND ledger_entries.eligible=excluded.eligible THEN ledger_entries.amount_minor ELSE -1 END`,
        [userId, json(plan.events)],
      );
    if (plan.reviews.length)
      add(
        `INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,created_at,missing_fields_json) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.documentId'),json_extract(value,'$.observationId'),json_extract(value,'$.purchaseId'),json_extract(value,'$.reason'),'financial',?,CASE WHEN json_type(value,'$.missingFields')='array' THEN json_extract(value,'$.missingFields') ELSE NULL END FROM json_each(?) WHERE ${guard.sql} ON CONFLICT(user_id,id) DO NOTHING`,
        [userId, clock(), json(plan.reviews)],
      );
    add(
      `UPDATE documents SET parse_state=CASE WHEN parse_state='ready' THEN 'extracted' ELSE parse_state END WHERE user_id=? AND id=? AND ${guard.sql}`,
      [userId, input.identity.documentId],
    );
    if (nextDocumentIndex !== null)
      statements.push(
        ...(await continuation(
          lease,
          { stage: "infer", documentIndex: nextDocumentIndex },
          guard,
        )),
      );
    else
      add(
        `UPDATE source_messages SET processing_status=${SOURCE_STATUS_CASE} WHERE user_id=? AND id=(SELECT source_message_id FROM discovery_source_jobs WHERE user_id=? AND job_id=?) AND ${guard.sql}`,
        [userId, userId, lease.jobId],
      );
    statements.push(importProjection(lease, guard));
    if (plan.paymentStates.length)
      add(
        `UPDATE purchases SET payment_state=(SELECT json_extract(value,'$.paymentState') FROM json_each(?) WHERE json_extract(value,'$.purchaseId')=purchases.id),version=version+1 WHERE user_id=? AND id IN (SELECT json_extract(value,'$.purchaseId') FROM json_each(?)) AND ${guard.sql}`,
        [json(plan.paymentStates), userId, json(plan.paymentStates)],
      );
    const updated = versionGuard(inputGuard(lease, input), lease, plan, true);
    // This is deliberately adjacent to the purchase projection UPDATE. An external
    // version bump is never evidence that this batch applied its candidate plan.
    if (plan.paymentStates.length) {
      updated.sql += " AND changes()=?";
      updated.values.push(plan.paymentStates.length);
    }
    statements.push(complete(lease, updated, "ledger_committed"));
    const outcome = await batch(statements, 3);
    if (outcome === "stale" && (await checkpoint(lease)))
      throw new PipelinePersistenceError("PIPELINE_CONFLICT");
    return outcome;
  }
  function negativeClassificationGuard(
    lease: JobLease,
    classificationFingerprint: string,
  ): Predicate {
    fingerprintSchema.parse(classificationFingerprint);
    const guard = liveGuard(lease, clock());
    guard.sql += ` AND EXISTS(SELECT 1 FROM discovery_source_jobs dj JOIN documents d ON d.user_id=dj.user_id AND d.source_message_id=dj.source_message_id JOIN ai_extractions e ON e.user_id=d.user_id AND e.document_id=d.id WHERE dj.user_id=? AND dj.job_id=? AND dj.pipeline_stage='infer' AND d.pipeline_index=dj.document_index AND d.parse_state IN('ready','extracted') AND e.run_key=? AND e.content_hash=d.content_hash AND e.extraction_version='email-classification-v1' AND e.completed_at IS NOT NULL AND e.generation=(SELECT generation FROM ai_settings WHERE user_id=e.user_id) AND e.credential_version=(SELECT credential_version FROM ai_settings WHERE user_id=e.user_id) AND json_extract(e.result_json,'$.status')='classified' AND json_extract(e.result_json,'$.isReceipt')=0 AND e.settings_revision=(SELECT ai_settings_revision FROM processing_consents WHERE user_id=? AND id=?))`;
    guard.values.push(
      lease.context.userId,
      lease.jobId,
      classificationFingerprint,
      lease.context.userId,
      lease.consentId,
    );
    return guard;
  }
  async function skipDocument(
    lease: JobLease,
    outcome: {
      documentId: string;
      classificationFingerprint: string;
      nextDocumentIndex: number | null;
    },
  ): Promise<"committed" | "stale"> {
    identifier.parse(outcome.documentId);
    const guard = negativeClassificationGuard(
      lease,
      outcome.classificationFingerprint,
    );
    guard.sql += ` AND EXISTS(SELECT 1 FROM discovery_source_jobs current JOIN documents d ON d.user_id=current.user_id AND d.source_message_id=current.source_message_id WHERE current.user_id=? AND current.job_id=? AND current.pipeline_stage='infer' AND d.id=? AND d.pipeline_index=current.document_index AND d.parse_state IN('ready','extracted'))`;
    guard.values.push(lease.context.userId, lease.jobId, outcome.documentId);
    if (outcome.nextDocumentIndex !== null) {
      guard.sql += ` AND EXISTS(SELECT 1 FROM discovery_source_jobs current JOIN documents d ON d.user_id=current.user_id AND d.source_message_id=current.source_message_id WHERE current.user_id=? AND current.job_id=? AND d.pipeline_index=? AND d.pipeline_index=current.document_index+1)`;
      guard.values.push(
        lease.context.userId,
        lease.jobId,
        outcome.nextDocumentIndex,
      );
    }
    const follow =
      outcome.nextDocumentIndex === null
        ? []
        : await continuation(
            lease,
            { stage: "infer", documentIndex: outcome.nextDocumentIndex },
            guard,
          );
    if (outcome.nextDocumentIndex !== null && !follow.length) return "stale";
    return batch([
      stmt(
        `UPDATE documents SET parse_state='extracted',parse_code='non-purchase' WHERE user_id=? AND id=? AND ${guard.sql}`,
        [lease.context.userId, outcome.documentId],
        guard,
      ),
      ...follow,
      stmt(
        `UPDATE source_messages SET processing_status=${SOURCE_STATUS_CASE} WHERE user_id=? AND id=(SELECT source_message_id FROM discovery_source_jobs WHERE user_id=? AND job_id=?) AND ${guard.sql}`,
        [lease.context.userId, lease.context.userId, lease.jobId],
        guard,
      ),
      importProjection(lease, guard),
      complete(lease, guard, "non-purchase"),
    ]);
  }
  async function skipSource(
    lease: JobLease,
    classificationFingerprint: string,
  ): Promise<"committed" | "stale"> {
    const guard = negativeClassificationGuard(lease, classificationFingerprint);
    guard.sql += ` AND EXISTS(SELECT 1 FROM discovery_source_jobs current WHERE current.user_id=? AND current.job_id=? AND current.document_index=0 AND (SELECT COUNT(*) FROM documents d WHERE d.user_id=current.user_id AND d.source_message_id=current.source_message_id)=1)`;
    guard.values.push(lease.context.userId, lease.jobId);
    return batch([
      stmt(
        `UPDATE documents SET parse_state='extracted',parse_code='non-purchase' WHERE user_id=? AND source_message_id=(SELECT source_message_id FROM discovery_source_jobs WHERE user_id=? AND job_id=?) AND ${guard.sql}`,
        [lease.context.userId, lease.context.userId, lease.jobId],
        guard,
      ),
      stmt(
        `UPDATE source_messages SET processing_status='processed' WHERE user_id=? AND id=(SELECT source_message_id FROM discovery_source_jobs WHERE user_id=? AND job_id=?) AND ${guard.sql}`,
        [lease.context.userId, lease.context.userId, lease.jobId],
        guard,
      ),
      importProjection(lease, guard),
      complete(lease, guard, "non-purchase"),
    ]);
  }
  async function fail(
    lease: JobLease,
    outcome: { status: "review" | "unsupported" | "failed"; code: string },
  ): Promise<"committed" | "stale"> {
    if (
      !["review", "unsupported", "failed"].includes(outcome.status) ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(outcome.code)
    )
      throw new PipelinePersistenceError("INVALID_PIPELINE");
    const guard = liveGuard(lease, clock());
    return batch([
      stmt(
        `UPDATE source_messages SET processing_status=? WHERE user_id=? AND id=(SELECT source_message_id FROM discovery_source_jobs WHERE user_id=? AND job_id=?) AND ${guard.sql}`,
        [
          outcome.status,
          lease.context.userId,
          lease.context.userId,
          lease.jobId,
        ],
        guard,
      ),
      importProjection(lease, guard),
      complete(lease, guard, outcome.code),
    ]);
  }
  async function checkpoint(lease: JobLease): Promise<boolean> {
    if (options.processingDigest) {
      const where = baseLiveWhere(lease, clock());
      const row = await db
        .prepare(
          `SELECT ${selectionProjection} AS processing_selection FROM ${LIVE_FROM} WHERE ${where.sql}`,
        )
        .bind(...where.values)
        .first<{ processing_selection: string }>();
      return acceptSelection(lease, row?.processing_selection);
    }
    const guard = liveGuard(lease, clock());
    return (
      (await db
        .prepare(`SELECT 1 AS valid WHERE ${guard.sql}`)
        .bind(...guard.values)
        .first<number>("valid")) === 1
    );
  }
  async function failDocument(
    lease: JobLease,
    outcome: {
      documentId: string;
      code: string;
      nextDocumentIndex: number | null;
    },
  ): Promise<"committed" | "stale"> {
    identifier.parse(outcome.documentId);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(outcome.code))
      throw new PipelinePersistenceError("INVALID_PIPELINE");
    const guard = liveGuard(lease, clock());
    guard.sql += ` AND EXISTS(SELECT 1 FROM documents d JOIN discovery_source_jobs dj ON dj.user_id=d.user_id AND dj.source_message_id=d.source_message_id WHERE d.user_id=? AND d.id=? AND dj.job_id=? AND d.pipeline_index=dj.document_index)`;
    guard.values.push(lease.context.userId, outcome.documentId, lease.jobId);
    if (outcome.nextDocumentIndex !== null) {
      guard.sql += ` AND EXISTS(SELECT 1 FROM documents d JOIN discovery_source_jobs dj ON dj.user_id=d.user_id AND dj.source_message_id=d.source_message_id WHERE d.user_id=? AND dj.job_id=? AND d.pipeline_index=? AND d.pipeline_index=dj.document_index+1)`;
      guard.values.push(
        lease.context.userId,
        lease.jobId,
        outcome.nextDocumentIndex,
      );
    }
    const userId = lease.context.userId;
    const statements = [
      stmt(
        `UPDATE documents SET parse_state='needs_review',parse_code=? WHERE user_id=? AND id=? AND ${guard.sql}`,
        [outcome.code, userId, outcome.documentId],
        guard,
      ),
      stmt(
        `INSERT INTO review_items(id,user_id,document_id,reason,blocking_scope,created_at) SELECT ?,?,?,'document-review','operational',? WHERE ${guard.sql} ON CONFLICT(user_id,id) DO NOTHING`,
        [
          `document-review:${outcome.documentId}`,
          userId,
          outcome.documentId,
          clock(),
        ],
        guard,
      ),
    ];
    if (outcome.nextDocumentIndex !== null)
      statements.push(
        ...(await continuation(
          lease,
          { stage: "infer", documentIndex: outcome.nextDocumentIndex },
          guard,
        )),
      );
    else
      statements.push(
        stmt(
          `UPDATE source_messages SET processing_status='review' WHERE user_id=? AND id=(SELECT source_message_id FROM discovery_source_jobs WHERE user_id=? AND job_id=?) AND ${guard.sql}`,
          [userId, userId, lease.jobId],
          guard,
        ),
      );
    statements.push(
      importProjection(lease, guard),
      complete(lease, guard, "document_review"),
    );
    return batch(statements);
  }
  return {
    skipDocument,
    skipSource,
    failDocument,
    load,
    stageDocuments,
    advance,
    cachedResult,
    loadSnapshot,
    commit,
    fail,
    checkpoint,
  };
}
