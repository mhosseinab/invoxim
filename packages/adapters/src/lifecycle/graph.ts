import type { DeleteDataPreview, TenantContext } from "@invoxim/core";
import { LifecycleError } from "@invoxim/core";
export const targetObservations =
  "SELECT o.id FROM observations o JOIN documents d ON d.user_id=o.user_id AND d.id=o.document_id JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id WHERE s.user_id=? AND s.connection_id=?";
export const alternateObservation =
  "SELECT o2.id FROM observations original JOIN documents d ON d.user_id=original.user_id AND d.id=original.document_id JOIN observations o2 ON o2.user_id=original.user_id AND o2.segment_index=original.segment_index AND o2.normalized_fields=original.normalized_fields AND o2.structured_fields IS original.structured_fields AND o2.review_state='accepted' AND o2.evidence_code=original.evidence_code JOIN documents d2 ON d2.user_id=o2.user_id AND d2.id=o2.document_id AND d2.content_hash=d.content_hash JOIN source_messages s2 ON s2.user_id=d2.user_id AND s2.id=d2.source_message_id WHERE original.user_id=l.user_id AND original.id=l.observation_id AND s2.connection_id!=? AND EXISTS(SELECT 1 FROM purchase_evidence pe2 WHERE pe2.user_id=o2.user_id AND pe2.observation_id=o2.id AND pe2.purchase_id=l.purchase_id) ORDER BY o2.id LIMIT 1";
export const independentPurchaseSupport = `(p.origin='user-supplied' OR EXISTS(SELECT 1 FROM ledger_entries own_cash WHERE own_cash.user_id=p.user_id AND own_cash.purchase_id=p.id AND own_cash.origin='user-confirmed') OR EXISTS(SELECT 1 FROM purchase_merges pm JOIN purchases supplied ON supplied.user_id=pm.user_id AND supplied.id=pm.source_id WHERE pm.user_id=p.user_id AND pm.target_id=p.id AND pm.active=1 AND supplied.origin='user-supplied'))`;
export function previewSql() {
  const target = targetObservations.replace(
    "s.user_id=? AND s.connection_id=?",
    "s.user_id=c.user_id AND s.connection_id=c.id",
  );
  const docs =
    "SELECT d.id FROM documents d JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id WHERE s.user_id=c.user_id AND s.connection_id=c.id";
  const affected = `(EXISTS(SELECT 1 FROM purchase_evidence pe WHERE pe.user_id=p.user_id AND pe.purchase_id=p.id AND pe.observation_id IN(${target})) OR EXISTS(SELECT 1 FROM manual_purchase_evidence me WHERE me.user_id=p.user_id AND me.purchase_id=p.id AND me.document_id IN(${docs})))`;
  const retained = `(${independentPurchaseSupport} OR EXISTS(SELECT 1 FROM purchase_evidence pe WHERE pe.user_id=p.user_id AND pe.purchase_id=p.id AND pe.observation_id NOT IN(${target})))`;
  const alternate = alternateObservation.replace(
    "s2.connection_id!=?",
    "s2.connection_id!=c.id",
  );
  return `SELECT json_object('connectionId',c.id,'generation',c.generation,'sources',(SELECT COUNT(*) FROM source_messages WHERE user_id=c.user_id AND connection_id=c.id),'documents',(SELECT COUNT(*) FROM documents WHERE user_id=c.user_id AND id IN(${docs})),'observations',(SELECT COUNT(*) FROM observations WHERE user_id=c.user_id AND id IN(${target})),'purchasesRemoved',(SELECT COUNT(*) FROM purchases p WHERE p.user_id=c.user_id AND ${affected} AND NOT ${retained}),'purchasesRetained',(SELECT COUNT(*) FROM purchases p WHERE p.user_id=c.user_id AND ${affected} AND ${retained}),'eventsRemoved',(SELECT COUNT(*) FROM ledger_entries l WHERE l.user_id=c.user_id AND l.observation_id IN(${target}) AND (${alternate}) IS NULL),'eventsRetained',(SELECT COUNT(*) FROM ledger_entries l WHERE l.user_id=c.user_id AND ((l.observation_id IN(${target}) AND (${alternate}) IS NOT NULL) OR (l.origin='user-confirmed' AND EXISTS(SELECT 1 FROM purchases p WHERE p.user_id=l.user_id AND p.id=l.purchase_id AND ${affected} AND ${retained}))))) AS snapshot FROM connections c WHERE c.user_id=? AND c.id=? AND c.kind='mailbox' AND EXISTS(SELECT 1 FROM profiles WHERE user_id=c.user_id AND status='active')`;
}
export function previewArguments(user: string, id: string) {
  return [user, id];
}
export async function previewSnapshot(
  db: D1Database,
  tenant: TenantContext,
  id: string,
) {
  const row = await db
    .prepare(previewSql())
    .bind(...previewArguments(tenant.userId, id))
    .first<{ snapshot: string }>();
  if (!row) throw new LifecycleError("NOT_FOUND");
  return row.snapshot;
}
export async function projectPreview(
  snapshot: string,
): Promise<DeleteDataPreview> {
  const fingerprint = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return {
    ...JSON.parse(snapshot),
    fingerprint,
    supported: true,
    driveFilesDeleted: false,
  } as DeleteDataPreview;
}
