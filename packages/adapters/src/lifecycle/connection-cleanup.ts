import { recomputeConnectionPurchase } from "./connection-recompute";
import {
  alternateObservation,
  independentPurchaseSupport,
  targetObservations,
} from "./graph";
import { cleanupM1Leaves } from "./m1-leaf-cleanup";

interface Item {
  user_id: string;
  target_id: string;
  stage: number;
  request_id: string;
}
export async function cleanupConnection(db: D1Database, item: Item) {
  // Stage9 only recomputes retained records; leave its existing query/mutation budget untouched.
  if (
    item.stage !== 9 &&
    (await cleanupM1Leaves(db, { ...item, scope: "connection" }))
  )
    return { status: "pending" as const };
  const user = item.user_id,
    id = item.target_id;
  const guard =
    "EXISTS(SELECT 1 FROM lifecycle_deletions WHERE user_id=? AND scope='connection' AND target_id=? AND request_id=? AND stage=?) AND EXISTS(SELECT 1 FROM connections WHERE user_id=? AND id=? AND state='disconnected')";
  const guardArgs = [user, id, item.request_id, item.stage, user, id];
  const prefix = `WITH target AS (${targetObservations}),docs AS (SELECT d.id FROM documents d JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id WHERE s.user_id=? AND s.connection_id=?),doomed AS (SELECT id FROM purchases WHERE user_id=? AND lifecycle_delete_connection_id=?) `;
  const scope = [user, id, user, id, user, id];
  let query: string,
    extra: (string | number)[] = [];
  if (item.stage === 0) {
    query = `UPDATE ledger_entries AS l SET observation_id=(${alternateObservation}) WHERE rowid IN(SELECT l.rowid FROM ledger_entries l WHERE l.user_id=? AND l.observation_id IN(SELECT id FROM target) AND (${alternateObservation}) IS NOT NULL LIMIT 100) AND ${guard}`;
    extra = [id, user, id];
  } else if (item.stage === 1) {
    query = `UPDATE purchases SET lifecycle_delete_connection_id=? WHERE rowid IN(SELECT p.rowid FROM purchases p WHERE p.user_id=? AND p.lifecycle_delete_connection_id IS NULL AND (EXISTS(SELECT 1 FROM purchase_evidence pe WHERE pe.user_id=p.user_id AND pe.purchase_id=p.id AND pe.observation_id IN(SELECT id FROM target)) OR EXISTS(SELECT 1 FROM manual_purchase_evidence me WHERE me.user_id=p.user_id AND me.purchase_id=p.id AND me.document_id IN(SELECT id FROM docs))) AND NOT ${independentPurchaseSupport} AND NOT EXISTS(SELECT 1 FROM purchase_evidence pe WHERE pe.user_id=p.user_id AND pe.purchase_id=p.id AND pe.observation_id NOT IN(SELECT id FROM target)) LIMIT 100) AND ${guard}`;
    extra = [id, user];
  } else if (item.stage === 2) {
    query = `UPDATE purchases SET lifecycle_delete_connection_id=? WHERE rowid IN(SELECT p.rowid FROM purchases p WHERE p.user_id=? AND p.lifecycle_delete_connection_id IS NULL AND p.origin='source' AND NOT ${independentPurchaseSupport} AND EXISTS(SELECT 1 FROM purchase_merges pm WHERE pm.user_id=p.user_id AND pm.source_id=p.id AND pm.active=1 AND pm.target_id IN(SELECT id FROM doomed)) LIMIT 100) AND ${guard}`;
    extra = [id, user];
  } else if (item.stage === 3) {
    query = `UPDATE purchases SET payment_state='unknown',version=CASE WHEN version<2147483646 THEN version+1 ELSE version END,lifecycle_recompute_connection_id=? WHERE rowid IN(SELECT p.rowid FROM purchases p WHERE p.user_id=? AND p.lifecycle_delete_connection_id IS NULL AND p.lifecycle_recompute_connection_id IS NULL AND (EXISTS(SELECT 1 FROM ledger_entries l WHERE l.user_id=p.user_id AND l.purchase_id=p.id AND l.observation_id IN(SELECT id FROM target)) OR EXISTS(SELECT 1 FROM purchase_evidence pe JOIN observations o ON o.user_id=pe.user_id AND o.id=pe.observation_id WHERE pe.user_id=p.user_id AND pe.purchase_id=p.id AND o.id IN(SELECT id FROM target) AND o.review_state='accepted' AND o.evidence_code='explicitly-paid' AND (json_extract(o.structured_fields,'$.record.storeCreditAmount') IS NOT NULL OR json_extract(o.structured_fields,'$.record.paymentMethodHint')='store-credit'))) LIMIT 100) AND ${guard}`;
    extra = [id, user];
  } else if (item.stage === 4) {
    query = `DELETE FROM review_items WHERE rowid IN(SELECT r.rowid FROM review_items r JOIN purchases p ON p.user_id=r.user_id AND p.id=r.purchase_id WHERE r.user_id=? AND r.id='source-deletion:'||p.id AND r.reason='incomplete-financial-facts' AND r.observation_id IS NULL AND r.status='open' AND (p.lifecycle_recompute_connection_id=? OR p.lifecycle_delete_connection_id=?) LIMIT 100) AND ${guard}`;
    extra = [user, id, id];
  } else if (item.stage === 5) {
    query = `UPDATE ledger_entries SET eligible=0 WHERE rowid IN(SELECT rowid FROM ledger_entries WHERE user_id=? AND origin='source' AND eligible=1 AND observation_id IN(SELECT id FROM target) LIMIT 100) AND ${guard}`;
    extra = [user];
  } else if (item.stage === 9) {
    const result = await recomputeConnectionPurchase(
      db,
      user,
      id,
      guard,
      guardArgs,
    );
    if (result.empty)
      await db
        .prepare(
          "UPDATE lifecycle_deletions SET stage=stage+1 WHERE user_id=? AND scope='connection' AND target_id=? AND request_id=? AND stage=?",
        )
        .bind(user, id, item.request_id, item.stage)
        .run();
    return { status: "pending" as const };
  } else {
    const entries =
      "SELECT id FROM ledger_entries WHERE user_id=? AND (observation_id IN(SELECT id FROM target) OR purchase_id IN(SELECT id FROM doomed))";
    const erasedFacts = `((entity_kind='entry' AND entity_id IN(${entries})) OR (entity_kind='purchase' AND entity_id IN(SELECT id FROM doomed)))`;
    const definitions: [string, string, (string | number)[]][] = [
      ["field_overrides", erasedFacts, [user]],
      [
        "correction_audit",
        `(${erasedFacts} OR (entity_kind='review' AND entity_id IN(SELECT id FROM review_items WHERE user_id=? AND (document_id IN(SELECT id FROM docs) OR (document_id IS NULL AND purchase_id IN(SELECT id FROM doomed))))))`,
        [user, user],
      ],
      [
        "ledger_entries",
        "(observation_id IN(SELECT id FROM target) OR purchase_id IN(SELECT id FROM doomed))",
        [],
      ],
      [
        "review_items",
        "(document_id IN(SELECT id FROM docs) OR purchase_id IN(SELECT id FROM doomed))",
        [],
      ],
      ["ledger_match_decisions", "purchase_id IN(SELECT id FROM doomed)", []],
      [
        "purchase_merges",
        "(target_id IN(SELECT id FROM doomed) OR source_id IN(SELECT id FROM doomed))",
        [],
      ],
      [
        "manual_purchase_evidence",
        "(document_id IN(SELECT id FROM docs) OR purchase_id IN(SELECT id FROM doomed))",
        [],
      ],
      [
        "purchase_evidence",
        "(observation_id IN(SELECT id FROM target) OR purchase_id IN(SELECT id FROM doomed))",
        [],
      ],
      ["purchases", "id IN(SELECT id FROM doomed)", []],
      ["observations", "id IN(SELECT id FROM target)", []],
      ["ai_extractions", "document_id IN(SELECT id FROM docs)", []],
      ["documents", "id IN(SELECT id FROM docs)", []],
      [
        "discovery_source_jobs",
        "source_message_id IN(SELECT id FROM source_messages WHERE user_id=? AND connection_id=?)",
        [user, id],
      ],
      [
        "discovery_run_sources",
        "source_message_id IN(SELECT id FROM source_messages WHERE user_id=? AND connection_id=?)",
        [user, id],
      ],
      ["source_messages", "connection_id=?", [id]],
    ];
    // Detach surviving review documents in their own bounded stage before the parent can disappear.
    if (item.stage === 10) {
      query = `UPDATE review_items SET purchase_id=CASE WHEN purchase_id IN(SELECT id FROM doomed) THEN NULL ELSE purchase_id END,observation_id=CASE WHEN observation_id IN(SELECT id FROM target) THEN NULL ELSE observation_id END WHERE rowid IN(SELECT rowid FROM review_items WHERE user_id=? AND (purchase_id IN(SELECT id FROM doomed) OR observation_id IN(SELECT id FROM target)) AND document_id NOT IN(SELECT id FROM docs) LIMIT 100) AND ${guard}`;
      extra = [user];
    } else {
      const index =
          item.stage - 6 - (item.stage > 9 ? 1 : 0) - (item.stage > 10 ? 1 : 0),
        definition = definitions[index];
      if (!definition) {
        await db
          .prepare(
            "DELETE FROM lifecycle_deletions WHERE user_id=? AND scope='connection' AND target_id=? AND request_id=? AND stage=?",
          )
          .bind(user, id, item.request_id, item.stage)
          .run();
        return { status: "completed" as const };
      }
      const [table, predicate, values] = definition;
      query = `DELETE FROM ${table} WHERE rowid IN(SELECT rowid FROM ${table} WHERE user_id=? AND ${predicate} LIMIT 100) AND ${guard}`;
      extra = [user, ...values];
    }
  }
  const result = await db
    .prepare(prefix + query)
    .bind(...scope, ...extra, ...guardArgs)
    .run();
  if (item.stage === 2 ? result.meta.changes === 0 : result.meta.changes < 100)
    await db
      .prepare(
        "UPDATE lifecycle_deletions SET stage=stage+1 WHERE user_id=? AND scope='connection' AND target_id=? AND request_id=? AND stage=?",
      )
      .bind(user, id, item.request_id, item.stage)
      .run();
  return { status: "pending" as const };
}
