import type {
  CorrectionEventFact,
  CorrectionReviewFact,
  CorrectionSettlement,
} from "@invoxim/core";
import {
  allocationReviewStatus,
  evaluateCorrectionSettlement,
  settlementEvents,
} from "@invoxim/core";
import {
  creditProofSql,
  parseCreditProofRows,
} from "../corrections/allocation";

// Cash support is decided in TS by core settlementEvents (eligibility, cash proof,
// restoration reviews), the same rule corrections use (C1, CORE-6). SQL only
// projects the facts; `accepted` folds in connection deletion like corrections/data.ts.
const cashSql = `SELECT l.id,l.kind,CAST(l.amount_minor AS TEXT) AS amountMinor,l.currency,l.event_date AS eventDate,l.origin,l.eligible,l.observation_id AS observationId,o.document_id AS documentId,o.evidence_code AS evidenceCode,CASE WHEN o.review_state='accepted' AND NOT EXISTS(SELECT 1 FROM lifecycle_deletions ld WHERE ld.user_id=s.user_id AND ld.scope='connection' AND ld.target_id=s.connection_id) THEN 1 ELSE 0 END AS accepted FROM ledger_entries l LEFT JOIN observations o ON o.user_id=l.user_id AND o.id=l.observation_id LEFT JOIN documents d ON d.user_id=o.user_id AND d.id=o.document_id LEFT JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id WHERE l.user_id=p.user_id AND l.purchase_id=p.id ORDER BY l.id LIMIT 1001`;
// Open financial reviews that can block this purchase's cash: purchase-scoped
// (as corrections load them) plus any linked through an entry's observation or,
// without observation, its document (a conservative superset).
const reviewSql = `SELECT r.id,r.observation_id AS observationId,r.document_id AS documentId,r.purchase_id AS purchaseId,r.reason,r.blocking_scope AS blockingScope,r.status FROM review_items r WHERE r.user_id=p.user_id AND r.status='open' AND r.blocking_scope='financial' AND r.reason!='payment-allocation-review' AND (r.purchase_id=p.id OR r.observation_id IN(SELECT l.observation_id FROM ledger_entries l WHERE l.user_id=p.user_id AND l.purchase_id=p.id) OR (r.observation_id IS NULL AND r.document_id IN(SELECT o.document_id FROM ledger_entries l JOIN observations o ON o.user_id=l.user_id AND o.id=l.observation_id WHERE l.user_id=p.user_id AND l.purchase_id=p.id))) ORDER BY r.id LIMIT 201`;
const creditSql = creditProofSql("p.user_id", "p.id");
interface Row {
  id: string;
  version: number;
  currency: string | null;
  total_minor: string | null;
  payment_state: string;
  cash_json: string;
  reviews_json: string;
  credits_json: string;
  warning_json: string;
}
export async function recomputeConnectionPurchase(
  db: D1Database,
  user: string,
  connection: string,
  guard: string,
  guardArgs: readonly (string | number)[],
) {
  const row = await db
    .prepare(
      `SELECT p.id,p.version,p.currency,CAST(p.total_minor AS TEXT) AS total_minor,p.payment_state,(SELECT json_group_array(json_object('id',id,'kind',kind,'amountMinor',amountMinor,'currency',currency,'eventDate',eventDate,'origin',origin,'eligible',eligible,'observationId',observationId,'documentId',documentId,'evidenceCode',evidenceCode,'accepted',accepted)) FROM(${cashSql})) AS cash_json,(SELECT json_group_array(json_object('id',id,'observationId',observationId,'documentId',documentId,'purchaseId',purchaseId,'reason',reason,'blockingScope',blockingScope,'status',status)) FROM(${reviewSql})) AS reviews_json,(SELECT json_group_array(json_object('currency',currency,'total',total,'credit',credit)) FROM(${creditSql})) AS credits_json,(SELECT json_group_array(json_object('id',id,'version',version)) FROM(SELECT r.id,r.version FROM review_items r WHERE r.user_id=p.user_id AND r.purchase_id=p.id AND r.reason='payment-allocation-review' AND r.status='open' ORDER BY r.id LIMIT 100)) AS warning_json FROM purchases p WHERE p.user_id=? AND p.lifecycle_recompute_connection_id=? AND p.lifecycle_delete_connection_id IS NULL ORDER BY p.id LIMIT 1`,
    )
    .bind(user, connection)
    .first<Row>();
  if (!row) return { empty: true };
  const cash = (
    JSON.parse(row.cash_json) as (Omit<
      CorrectionEventFact,
      "eligible" | "accepted"
    > & { eligible: number; accepted: number })[]
  ).map(
    (entry): CorrectionEventFact => ({
      ...entry,
      eligible: entry.eligible === 1,
      accepted: entry.accepted === 1,
    }),
  );
  const reviews = (
    JSON.parse(row.reviews_json) as Omit<
      CorrectionReviewFact,
      "missingFields"
    >[]
  ).map((review): CorrectionReviewFact => ({ ...review, missingFields: [] }));
  const credits = JSON.parse(row.credits_json) as {
    currency: unknown;
    total: unknown;
    credit: unknown;
  }[];
  const existing = JSON.parse(row.warning_json) as {
    id: string;
    version: number;
  }[];
  const oversized =
    cash.length > 1000 || reviews.length > 200 || credits.length > 200;
  const settlement: CorrectionSettlement = oversized
    ? {
        paymentState: "unknown",
        supportedMinor: "0",
        balanced: false,
        sourceProof: true,
      }
    : evaluateCorrectionSettlement(
        {
          currency: row.currency,
          totalMinor: row.total_minor,
          paymentState: row.payment_state,
        },
        settlementEvents(cash, reviews),
        parseCreditProofRows(credits),
      );
  const status = allocationReviewStatus(
    row.payment_state,
    settlement,
    existing.length > 0,
    true,
  );
  // The final sentinel is not written: leave the marker and unknown state until the next bounded unit.
  const resolving = status === "resolved";
  const pendingQuestions = resolving && existing.length === 100;
  const questionUnit = existing.slice(0, 99);
  const cas = `EXISTS(SELECT 1 FROM purchases WHERE user_id=? AND id=? AND version=? AND lifecycle_recompute_connection_id=? AND lifecycle_delete_connection_id IS NULL) AND ${guard}`;
  const args = [user, row.id, row.version, connection, ...guardArgs];
  const statements: D1PreparedStatement[] = [];
  if (status !== null) {
    if (existing.length > 0 && resolving)
      statements.push(
        db
          .prepare(
            `UPDATE review_items SET status=?,version=CASE WHEN version<2147483646 THEN version+1 ELSE version END WHERE user_id=? AND reason='payment-allocation-review' AND status='open' AND EXISTS(SELECT 1 FROM json_each(?) e WHERE json_extract(e.value,'$.id')=review_items.id AND json_extract(e.value,'$.version')=review_items.version) AND ${cas}`,
          )
          .bind(status, user, JSON.stringify(questionUnit), ...args),
      );
    else if (existing.length === 0)
      statements.push(
        db
          .prepare(
            `INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at) SELECT ?,?,NULL,NULL,?,'payment-allocation-review','financial','open',? WHERE ${cas}`,
          )
          .bind(crypto.randomUUID(), user, row.id, Date.now(), ...args),
      );
  }
  statements.push(
    db
      .prepare(
        `UPDATE purchases SET payment_state=?,lifecycle_recompute_connection_id=?,version=CASE WHEN version<2147483646 THEN version+1 ELSE version END WHERE user_id=? AND id=? AND ${cas}`,
      )
      .bind(
        pendingQuestions ? "unknown" : settlement.paymentState,
        pendingQuestions ? connection : null,
        user,
        row.id,
        ...args,
      ),
  );
  await db.batch(statements);
  return { empty: false };
}
