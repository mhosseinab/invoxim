import { supportedExtractionPrompt } from "@invoxim/contracts";
import type {
  JobLease,
  LedgerInput,
  LedgerPlan,
  LedgerSnapshot,
  PersistableAiResult,
} from "@invoxim/core";
import { normalizeLedgerMerchant, parseMoney } from "@invoxim/core";
import { z } from "zod";
import type { ProcessingReviewMetadata } from "../onboarding/processing-readiness";
import { loadLedgerSnapshot } from "./ledger-snapshot";
import {
  checkedInput,
  checkedResult,
  fingerprintSchema,
  identifier,
  metadataSchema,
  validatePlan,
} from "./plan-validation";
import {
  cachedGuard as baseCachedGuard,
  liveGuard as baseLiveGuard,
  liveWhere as baseLiveWhere,
  currentDocumentGuard,
  executeBatch,
  json,
  LIVE_FROM,
  nextDocumentGuard,
  PipelinePersistenceError,
  type Predicate,
  processingSelectionSchema,
  processingSelectionSql,
  SOURCE_STATUS_CASE,
  safeJson,
  versionGuard,
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

export type PipelineProcessingSelection = ProcessingReviewMetadata;

export function createPipelineRepository(
  db: D1Database,
  options: {
    clock?: () => number;
    remainingStatements?: () => number;
    /** P7: required so no caller can silently skip the consent digest gate. */
    processingDigest: (
      selection: PipelineProcessingSelection,
    ) => Promise<string | null>;
  },
): PipelineRepository {
  const clock = options.clock ?? Date.now;
  const acceptedDigests = new Map<string, string>();
  const compatibleCaches = new Map<string, CachedExtractionCompatibility>();
  const selectionProjection = processingSelectionSql();
  function leaseKey(lease: JobLease) {
    return JSON.stringify([
      lease.context.userId,
      lease.jobId,
      lease.leaseId,
      lease.fence,
    ]);
  }
  async function acceptSelection(lease: JobLease, encoded: string | undefined) {
    acceptedDigests.delete(leaseKey(lease));
    if (!encoded) return false;
    // P1: one selection schema shared with jobs/store and onboarding-recovery.
    const selection = processingSelectionSchema.parse(safeJson(encoded));
    const expected = await options.processingDigest(selection);
    if (!expected || expected !== selection.acceptedDigest) return false;
    acceptedDigests.set(leaseKey(lease), expected);
    return true;
  }
  async function loadSelection(lease: JobLease): Promise<string | undefined> {
    const where = baseLiveWhere(lease, clock());
    const row = await db
      .prepare(
        `SELECT ${selectionProjection} AS processing_selection FROM ${LIVE_FROM} WHERE ${where.sql}`,
      )
      .bind(...where.values)
      .first<{ processing_selection: string }>();
    return row?.processing_selection;
  }
  async function ensureAccepted(lease: JobLease): Promise<boolean> {
    if (acceptedDigests.has(leaseKey(lease))) return true;
    return acceptSelection(lease, await loadSelection(lease));
  }
  function reviewed(lease: JobLease, predicate: Predicate): Predicate {
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
      sql: `(${base.sql}) AND EXISTS(SELECT 1 FROM ai_extractions compatible JOIN usage_events ev ON ev.user_id=compatible.user_id AND ev.run_key=compatible.run_key WHERE compatible.user_id=? AND compatible.document_id=? AND compatible.run_key=? AND compatible.extraction_version=? AND json_extract(ev.price_snapshot,'$.configurationDigest')=? AND json_extract(ev.price_snapshot,'$.policyVersion')=? AND json_extract(ev.price_snapshot,'$.acceptedConfigurationDigest')=?)`,
      values: [
        ...base.values,
        lease.context.userId,
        documentId,
        fingerprint,
        compatibility.extractionVersion,
        compatibility.configurationDigest,
        compatibility.policyVersion,
        acceptedDigests.get(leaseKey(lease)) ?? "",
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
        `SELECT sm.id AS source_id,sm.provider_message_id,pc.ai_settings_revision,pc.disclosure_version,${previousFinancialProjection} AS previous_extraction,dj.pipeline_stage,dj.document_index,dj.extraction_fingerprint,${selectionProjection} AS processing_selection,(SELECT COALESCE(json_group_array(json_object('id',dd.id,'partKey',dd.part_key,'contentHash',dd.content_hash,'mime',dd.mime,'byteLength',dd.byte_length,'parseState',dd.parse_state,'parserVersion',dd.parser_version,'code',dd.parse_code)),'[]') FROM (SELECT id,part_key,content_hash,mime,byte_length,parse_state,parser_version,parse_code FROM documents WHERE user_id=sm.user_id AND source_message_id=sm.id AND pipeline_index IS NOT NULL ORDER BY pipeline_index LIMIT 65) dd) AS documents FROM ${LIVE_FROM} WHERE ${where.sql}`,
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
    if (!(await ensureAccepted(lease))) return "stale";
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
    if (!(await ensureAccepted(lease))) return null;
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
    if (!(await ensureAccepted(lease))) return null;
    return loadLedgerSnapshot(db, lease, input, inputGuard(lease, input));
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
    if (!(await ensureAccepted(lease))) return "stale";
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
    if (!(await ensureAccepted(lease))) return "stale";
    const guard = negativeClassificationGuard(
      lease,
      outcome.classificationFingerprint,
    );
    guard.sql += ` AND ${currentDocumentGuard()}`;
    guard.values.push(lease.context.userId, lease.jobId, outcome.documentId);
    if (outcome.nextDocumentIndex !== null) {
      guard.sql += ` AND ${nextDocumentGuard()}`;
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
    if (!(await ensureAccepted(lease))) return "stale";
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
    if (!(await ensureAccepted(lease))) return "stale";
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
    return acceptSelection(lease, await loadSelection(lease));
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
    if (!(await ensureAccepted(lease))) return "stale";
    const guard = liveGuard(lease, clock());
    // P1.5c: the stage check is shared with skipDocument. The parse_state
    // check is omitted here because this batch writes parse_state and would
    // self-invalidate a guard that re-checks it.
    guard.sql += ` AND ${currentDocumentGuard({ checkParseState: false })}`;
    guard.values.push(lease.context.userId, lease.jobId, outcome.documentId);
    if (outcome.nextDocumentIndex !== null) {
      guard.sql += ` AND ${nextDocumentGuard()}`;
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
