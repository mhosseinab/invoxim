import type { CorrectionResult } from "@invoxim/contracts";
import type { CorrectionSession } from "@invoxim/core";
import { CorrectionError } from "@invoxim/core";
import type { ReviewRow } from "./data";
import { sourceNotDiscardedSql } from "./source-decision";
import { correctionTransaction, type VersionCheck } from "./transaction";

// Conservative: even excluded/merged financial evidence must use purchase controls.
function noFinancialEvidence() {
  return `NOT EXISTS(SELECT 1 FROM documents d JOIN review_items r ON r.user_id=d.user_id AND r.document_id=d.id WHERE d.user_id=s.user_id AND d.source_message_id=s.id AND r.purchase_id IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM documents d JOIN observations o ON o.user_id=d.user_id AND o.document_id=d.id JOIN purchase_evidence pe ON pe.user_id=o.user_id AND pe.observation_id=o.id WHERE d.user_id=s.user_id AND d.source_message_id=s.id)
    AND NOT EXISTS(SELECT 1 FROM documents d JOIN manual_purchase_evidence me ON me.user_id=d.user_id AND me.document_id=d.id WHERE d.user_id=s.user_id AND d.source_message_id=s.id)
    AND NOT EXISTS(SELECT 1 FROM documents d JOIN observations o ON o.user_id=d.user_id AND o.document_id=d.id JOIN ledger_entries l ON l.user_id=o.user_id AND l.observation_id=o.id WHERE d.user_id=s.user_id AND d.source_message_id=s.id)
    AND NOT EXISTS(SELECT 1 FROM lifecycle_deletions ld WHERE ld.user_id=s.user_id AND ld.scope='connection' AND ld.target_id=s.connection_id)`;
}
export async function discardableSource(
  db: D1Database,
  user: string,
  documentId: string | null,
) {
  if (!documentId) return null;
  return db
    .prepare(
      `SELECT s.id FROM source_messages s JOIN documents selected ON selected.user_id=s.user_id AND selected.source_message_id=s.id WHERE s.user_id=? AND selected.id=? AND ${noFinancialEvidence()} AND ${sourceNotDiscardedSql("s")}`,
    )
    .bind(user, documentId)
    .first<{ id: string }>();
}
export async function executeSourceDiscard(
  db: D1Database,
  session: CorrectionSession,
  row: ReviewRow,
  key: string,
  identity: { route: string; bodyHash: string },
  checks: VersionCheck[],
  clock: () => number,
) {
  const user = session.tenant.userId;
  const source = await discardableSource(db, user, row.document_id);
  if (!source || row.purchase_id) throw new CorrectionError("CONFLICT");
  const siblings = (
    await db
      .prepare(
        "SELECT r.id,r.version FROM review_items r JOIN documents d ON d.user_id=r.user_id AND d.id=r.document_id WHERE r.user_id=? AND d.source_message_id=? AND r.status='open' ORDER BY r.id LIMIT 201",
      )
      .bind(user, source.id)
      .all<{ id: string; version: number }>()
  ).results;
  if (siblings.length > 200) throw new CorrectionError("TOO_LARGE");
  if (!siblings.length || siblings.some((item) => item.version >= 2147483646))
    throw new CorrectionError("CONFLICT");
  const snapshot = JSON.stringify(siblings);
  checks.push({
    sql: `EXISTS(SELECT 1 FROM source_messages s JOIN documents selected ON selected.user_id=s.user_id AND selected.source_message_id=s.id WHERE s.user_id=? AND s.id=? AND selected.id=? AND ${noFinancialEvidence()}) AND (SELECT COUNT(*) FROM review_items r JOIN documents d ON d.user_id=r.user_id AND d.id=r.document_id WHERE r.user_id=? AND d.source_message_id=? AND r.status='open')=? AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM review_items r WHERE r.user_id=? AND r.id=json_extract(expected.value,'$.id') AND r.version=json_extract(expected.value,'$.version') AND r.status='open'))`,
    values: [
      user,
      source.id,
      row.document_id,
      user,
      source.id,
      siblings.length,
      snapshot,
      user,
    ],
  });
  const result: CorrectionResult = {
    purchaseId: null,
    version: null,
    entryId: null,
    entryVersion: null,
    reviewId: row.id,
    reviewVersion: row.version + 1,
    reviewStatus: "dismissed",
    mergeId: null,
  };
  const tx = correctionTransaction(
    db,
    session,
    key,
    identity,
    result,
    checks,
    clock,
  );
  tx.add(
    `INSERT INTO correction_audit(id,user_id,entity_kind,entity_id,action,before_json,after_json,created_at) SELECT lower(hex(randomblob(16))),?,'review',r.id,'not-a-purchase',json_object('status',r.status),json_object('status','dismissed','sourceMessageId',?),? FROM review_items r JOIN documents d ON d.user_id=r.user_id AND d.id=r.document_id WHERE r.user_id=? AND d.source_message_id=? AND r.status='open' AND ${tx.guard}`,
    [user, source.id, clock(), user, source.id, ...tx.guardValues],
  );
  tx.add(
    `UPDATE review_items SET status='dismissed',version=version+1 WHERE user_id=? AND status='open' AND document_id IN(SELECT id FROM documents WHERE user_id=? AND source_message_id=?) AND ${tx.guard}`,
    [user, user, source.id, ...tx.guardValues],
  );
  tx.add(
    `UPDATE jobs SET status='canceled',lease_id=NULL,lease_expires_at=NULL,fence=fence+1,outcome_code='not-a-purchase' WHERE user_id=? AND status IN('ready','retry_wait','leased','paused_auth','paused_budget') AND id IN(SELECT job_id FROM discovery_source_jobs WHERE user_id=? AND source_message_id=?) AND ${tx.guard}`,
    [user, user, source.id, ...tx.guardValues],
  );
  tx.add(
    `UPDATE source_messages SET processing_status='processed' WHERE user_id=? AND id=? AND ${tx.guard}`,
    [user, source.id, ...tx.guardValues],
  );
  return tx.commit();
}
