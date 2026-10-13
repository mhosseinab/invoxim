import { hasControlCharacters } from "@invoxim/contracts";
import type { TenantContext } from "@invoxim/core";
import { calendarDate, minorDigits, parseMinor } from "@invoxim/core";
export class CommitConflictError extends Error {
  readonly code = "COMMIT_CONFLICT";
  constructor() {
    super("COMMIT_CONFLICT");
    this.name = "CommitConflictError";
  }
}
export interface SourceCommit {
  jobId: string;
  leaseId: string;
  fence: number;
  connectionId: string;
  generation: number;
  source: { id: string; providerMessageId: string; receivedAt: number };
  document: {
    id: string;
    partKey: string;
    contentHash: string;
    mime: string;
    byteLength: number;
  };
  observation: { id: string; fingerprint: string; evidenceCode: string };
  purchase: {
    id: string;
    merchant: string;
    date: string;
    totalMinor: string | null;
    currency: string;
    paymentState: "unknown" | "unpaid" | "partially_paid" | "paid";
  };
  entries: readonly {
    id: string;
    eventKey: string;
    kind: "payment" | "refund";
    minor: string;
    currency: string;
    date: string;
    eligible: boolean;
  }[];
}
function bindMinor(value: string): number {
  const amount = Number(parseMinor(value));
  if (!Number.isSafeInteger(amount)) throw new Error("INVALID_AMOUNT");
  return amount;
}
function boundedText(value: string, limit: number) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > limit ||
    hasControlCharacters(value)
  )
    throw new Error("INVALID_COMMIT");
}
function validateMetadata(input: SourceCommit) {
  for (const value of [
    input.jobId,
    input.leaseId,
    input.connectionId,
    input.source.id,
    input.document.id,
    input.document.partKey,
    input.observation.id,
    input.observation.fingerprint,
    input.purchase.id,
  ])
    boundedText(value, 256);
  boundedText(input.source.providerMessageId, 1024);
  boundedText(input.purchase.merchant, 200);
  if (
    !/^[a-f0-9]{64}$/.test(input.document.contentHash) ||
    ![
      "application/pdf",
      "text/plain",
      "text/html",
      "image/png",
      "image/jpeg",
      "image/webp",
    ].includes(input.document.mime) ||
    !Number.isSafeInteger(input.document.byteLength) ||
    input.document.byteLength < 0 ||
    input.document.byteLength > 4194304 ||
    !Number.isSafeInteger(input.source.receivedAt) ||
    input.source.receivedAt < 0 ||
    ![
      "explicitly-paid",
      "completed-refund",
      "invoice-only",
      "manual-confirmation",
      "unknown",
    ].includes(input.observation.evidenceCode)
  )
    throw new Error("INVALID_COMMIT");
  for (const entry of input.entries) {
    boundedText(entry.id, 256);
    boundedText(entry.eventKey, 256);
    if (
      typeof entry.eligible !== "boolean" ||
      !["payment", "refund"].includes(entry.kind)
    )
      throw new Error("INVALID_COMMIT");
  }
}
export function createSourceRepository(
  db: D1Database,
  clock: () => number = Date.now,
) {
  return {
    async commit(
      context: TenantContext,
      input: SourceCommit,
    ): Promise<"committed" | "stale"> {
      validateMetadata(input);
      const now = clock();
      if (
        !Number.isSafeInteger(now) ||
        now < 0 ||
        !["unknown", "unpaid", "partially_paid", "paid"].includes(
          input.purchase.paymentState,
        )
      )
        throw new Error("INVALID_COMMIT");
      calendarDate(input.purchase.date);
      minorDigits(input.purchase.currency);
      const total =
        input.purchase.totalMinor === null
          ? null
          : bindMinor(input.purchase.totalMinor);
      if (
        !Number.isSafeInteger(input.fence) ||
        input.fence < 0 ||
        !Number.isSafeInteger(input.generation) ||
        input.generation < 1 ||
        input.entries.length > 50
      )
        throw new Error("INVALID_COMMIT");
      const entries = input.entries.map((entry) => {
        calendarDate(entry.date);
        minorDigits(entry.currency);
        return { ...entry, amount: bindMinor(entry.minor) };
      });
      const guard = `EXISTS(SELECT 1 FROM jobs j JOIN connections c ON c.user_id=j.user_id AND c.id=j.connection_id JOIN profiles p ON p.user_id=j.user_id JOIN processing_consents pc ON pc.user_id=j.user_id AND pc.id=j.consent_id AND pc.connection_id=j.connection_id WHERE j.user_id=? AND j.id=? AND j.status='leased' AND j.lease_id=? AND j.fence=? AND j.lease_expires_at>? AND j.connection_id=? AND j.connection_generation=? AND c.generation=j.connection_generation AND c.state='connected' AND c.scheduling_state='active' AND p.status='active' AND pc.revoked_at IS NULL AND pc.background_authorized=1 AND pc.accepted_at<=?)`;
      const fence = [
        context.userId,
        input.jobId,
        input.leaseId,
        input.fence,
        now,
        input.connectionId,
        input.generation,
        now,
      ];
      const statement = (sql: string, values: (string | number | null)[]) =>
        db.prepare(sql).bind(...values, ...fence);
      const sourceId = `(SELECT id FROM source_messages WHERE user_id=? AND connection_id=? AND provider_message_id=?)`;
      const sourceKey = [
        context.userId,
        input.connectionId,
        input.source.providerMessageId,
      ];
      const documentId = `(SELECT id FROM documents WHERE user_id=? AND source_message_id=${sourceId} AND part_key=?)`;
      const documentKey = [
        context.userId,
        ...sourceKey,
        input.document.partKey,
      ];
      const observationId = `(SELECT id FROM observations WHERE user_id=? AND document_id=${documentId} AND segment_index=0 AND extraction_fingerprint=?)`;
      const observationKey = [
        context.userId,
        ...documentKey,
        input.observation.fingerprint,
      ];
      const batch = [
        statement(
          `INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation,processing_status) SELECT ?,?,?,?,?,?,'processed' WHERE ${guard} ON CONFLICT(user_id,connection_id,provider_message_id) DO UPDATE SET processing_status='processed'`,
          [
            input.source.id,
            ...sourceKey,
            input.source.receivedAt,
            input.generation,
          ],
        ),
        statement(
          `INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length,document_date,parse_state) SELECT ?,?,${sourceId},?,?,?,?,?,'extracted' WHERE ${guard} ON CONFLICT(user_id,source_message_id,part_key) DO UPDATE SET content_hash=CASE WHEN documents.content_hash=excluded.content_hash AND documents.mime=excluded.mime AND documents.byte_length=excluded.byte_length AND documents.document_date IS excluded.document_date THEN documents.content_hash ELSE NULL END,parse_state='extracted'`,
          [
            input.document.id,
            context.userId,
            ...sourceKey,
            input.document.partKey,
            input.document.contentHash,
            input.document.mime,
            input.document.byteLength,
            input.purchase.date,
          ],
        ),
        statement(
          `INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) SELECT ?,?,${documentId},0,?,1,?,?,'accepted' WHERE ${guard} ON CONFLICT(user_id,document_id,segment_index,extraction_fingerprint) DO UPDATE SET normalized_fields=CASE WHEN observations.normalized_fields=excluded.normalized_fields AND observations.evidence_code=excluded.evidence_code AND observations.extraction_version=excluded.extraction_version AND observations.review_state='accepted' THEN observations.normalized_fields ELSE NULL END`,
          [
            input.observation.id,
            context.userId,
            ...documentKey,
            input.observation.fingerprint,
            input.observation.evidenceCode,
            JSON.stringify({
              schemaVersion: 1,
              merchant: input.purchase.merchant,
              date: input.purchase.date,
              totalMinor: input.purchase.totalMinor,
              currency: input.purchase.currency,
            }),
          ],
        ),
        statement(
          `INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) SELECT ?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(user_id,id) DO UPDATE SET total_minor=CASE WHEN purchases.total_minor IS excluded.total_minor AND purchases.currency IS excluded.currency AND purchases.document_date=excluded.document_date AND purchases.payment_state=excluded.payment_state THEN purchases.total_minor ELSE -1 END`,
          [
            input.purchase.id,
            context.userId,
            input.purchase.merchant,
            input.purchase.merchant.toLowerCase(),
            input.purchase.date,
            total,
            input.purchase.currency,
            input.purchase.paymentState,
          ],
        ),
        statement(
          `INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) SELECT ?,?,${observationId},'source' WHERE ${guard} ON CONFLICT(user_id,observation_id) DO UPDATE SET relationship=CASE WHEN purchase_evidence.purchase_id=excluded.purchase_id AND purchase_evidence.relationship=excluded.relationship THEN purchase_evidence.relationship ELSE NULL END`,
          [context.userId, input.purchase.id, ...observationKey],
        ),
        ...entries.map((entry) =>
          statement(
            `INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) SELECT ?,?,?,${observationId},?,?,?,?,?,'document',? WHERE ${guard} ON CONFLICT(user_id,business_event_key) DO UPDATE SET amount_minor=CASE WHEN ledger_entries.purchase_id IS excluded.purchase_id AND ledger_entries.kind=excluded.kind AND ledger_entries.amount_minor=excluded.amount_minor AND ledger_entries.currency=excluded.currency AND ledger_entries.event_date=excluded.event_date AND ledger_entries.date_basis=excluded.date_basis AND ledger_entries.eligible=excluded.eligible THEN ledger_entries.amount_minor ELSE -1 END`,
            [
              entry.id,
              context.userId,
              input.purchase.id,
              ...observationKey,
              entry.eventKey,
              entry.kind,
              entry.amount,
              entry.currency,
              entry.date,
              entry.eligible ? 1 : 0,
            ],
          ),
        ),
        statement(
          `UPDATE jobs SET status='completed',outcome_code='committed' WHERE user_id=? AND id=? AND ${guard}`,
          [context.userId, input.jobId],
        ),
      ];
      try {
        const results = await db.batch(batch);
        return results.at(-1)?.meta.changes === 1 ? "committed" : "stale";
      } catch (error) {
        // A D1 constraint aborts the whole batch. Never report an immutable mismatch as a completed replay.
        if (error instanceof Error && /SQLITE_CONSTRAINT/.test(error.message))
          throw new CommitConflictError();
        throw error;
      }
    },
  };
}
