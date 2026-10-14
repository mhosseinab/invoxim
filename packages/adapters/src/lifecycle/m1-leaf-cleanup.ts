import { activeProfileSql } from "../pipeline/repository-guards";
import { targetObservations } from "./graph";

interface BaseItem {
  readonly user_id: string;
  readonly target_id: string;
  readonly request_id: string;
  readonly stage: number;
}
export type M1CleanupItem =
  | (BaseItem & { readonly scope: "account"; readonly deleted_at: number })
  | (BaseItem & { readonly scope: "connection" });
/**
 * New-style leaf tables drained before legacy parent erasure. Children first so
 * foreign keys stay satisfiable. Keep in sync with the schema-completeness test.
 */
export const m1LeafTables = [
  "archive_upload_sessions",
  "archive_backfill_items",
  "archive_dispatch",
  "archive_document_order",
  "archive_backfill_runs",
  "archive_objects",
  "archive_folders",
  "recurring_entries",
  "recurring_series",
  "entry_valuations",
  "outlook_inventory_states",
  "outlook_folders",
  "archive_settings",
  "storage_oauth_intents",
  "storage_refresh_leases",
] as const;
type Leaf = (typeof m1LeafTables)[number];
function current(item: M1CleanupItem): {
  text: string;
  values: (string | number)[];
} {
  if (item.scope === "account")
    return {
      text: "EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='deleting') AND EXISTS(SELECT 1 FROM lifecycle_deletions WHERE user_id=? AND scope='account' AND target_id=? AND request_id=? AND stage=? AND deleted_at=? AND journal_ack=1)",
      values: [
        item.user_id,
        item.user_id,
        item.target_id,
        item.request_id,
        item.stage,
        item.deleted_at,
      ],
    };
  return {
    text: `${activeProfileSql} AND EXISTS(SELECT 1 FROM connections WHERE user_id=? AND id=? AND state='disconnected') AND EXISTS(SELECT 1 FROM lifecycle_deletions WHERE user_id=? AND scope='connection' AND target_id=? AND request_id=? AND stage=?)`,
    values: [
      item.user_id,
      item.user_id,
      item.target_id,
      item.user_id,
      item.target_id,
      item.request_id,
      item.stage,
    ],
  };
}
function predicate(
  table: Leaf,
  item: M1CleanupItem,
): { text: string; values: (string | number)[] } {
  if (item.scope === "account") return { text: "1", values: [] };
  if (table === "recurring_series") return { text: "0", values: [] };
  if (table === "archive_upload_sessions")
    return {
      text: "EXISTS(SELECT 1 FROM archive_objects a WHERE a.user_id=v.user_id AND a.id=v.object_id AND (a.mailbox_connection_id=? OR a.storage_connection_id=?))",
      values: [item.target_id, item.target_id],
    };
  if (table === "archive_objects")
    return {
      text: "(v.mailbox_connection_id=? OR v.storage_connection_id=?)",
      values: [item.target_id, item.target_id],
    };
  if (table === "archive_dispatch")
    return {
      text: "EXISTS(SELECT 1 FROM archive_objects a WHERE a.user_id=v.user_id AND a.id=v.object_id AND (a.mailbox_connection_id=? OR a.storage_connection_id=?))",
      values: [item.target_id, item.target_id],
    };
  if (table === "archive_backfill_items")
    return {
      text: "EXISTS(SELECT 1 FROM archive_backfill_runs r WHERE r.user_id=v.user_id AND r.id=v.run_id AND r.connection_id=?)",
      values: [item.target_id],
    };
  if (table === "archive_document_order")
    return {
      text: "EXISTS(SELECT 1 FROM documents d JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id WHERE d.user_id=v.user_id AND d.id=v.document_id AND s.connection_id=?)",
      values: [item.target_id],
    };
  if (table !== "entry_valuations" && table !== "recurring_entries")
    return { text: "v.connection_id=?", values: [item.target_id] };
  if (item.stage < 6) return { text: "0", values: [] };
  return {
    text: `EXISTS(SELECT 1 FROM ledger_entries l WHERE l.user_id=v.user_id AND l.id=v.entry_id AND l.origin='source' AND ((l.eligible=0 AND l.observation_id IN(${targetObservations})) OR EXISTS(SELECT 1 FROM purchases p WHERE p.user_id=l.user_id AND p.id=l.purchase_id AND p.lifecycle_delete_connection_id=?)))`,
    values: [item.user_id, item.target_id, item.target_id],
  };
}
/** Before legacy parent erasure, drain one new leaf table without changing integer stages. */
export async function cleanupM1Leaves(
  db: D1Database,
  item: M1CleanupItem,
): Promise<boolean> {
  try {
    const placeholders = m1LeafTables.map(() => "?").join(",");
    const available = (
      await db
        .prepare(
          `SELECT name FROM sqlite_schema WHERE type='table' AND name IN (${placeholders}) LIMIT ${m1LeafTables.length}`,
        )
        .bind(...m1LeafTables)
        .all<{ name: string }>()
    ).results;
    const present = m1LeafTables.filter((name) =>
      available.some((row) => row.name === name),
    );
    if (present.length === 0) return false;
    const guard = current(item),
      argumentsList: (string | number)[] = [],
      queries: string[] = [];
    for (const table of present) {
      const scope = predicate(table, item);
      queries.push(
        `(SELECT json_object('leaf','${table}','ids',json_group_array(CAST(rowid AS TEXT))) FROM(SELECT v.rowid AS rowid FROM ${table} v WHERE v.user_id=? AND ${scope.text} LIMIT 100) HAVING COUNT(*)>0)`,
      );
      argumentsList.push(item.user_id, ...scope.values);
    }
    // A changed request/profile must stop this unit, not fall through to legacy parent erasure.
    // Check the shared guard once, keeping all leaves below D1's 100-bind limit.
    const selected = await db
      .prepare(
        `SELECT json_extract(selected,'$.leaf') AS leaf,json_extract(selected,'$.ids') AS ids FROM (SELECT CASE WHEN ${guard.text} THEN (SELECT value FROM json_each(json_array(${queries.join(",")})) WHERE value IS NOT NULL ORDER BY CAST(key AS INTEGER) LIMIT 1) ELSE json_object('leaf','blocked','ids',json('[]')) END AS selected) WHERE selected IS NOT NULL`,
      )
      .bind(...guard.values, ...argumentsList)
      .first<{ leaf: string; ids: string }>();
    if (!selected) return false;
    if (selected.leaf === "blocked") return true;
    const table = m1LeafTables.find((name) => name === selected.leaf);
    if (!table) throw new Error("INVALID_LEAF");
    const ids: unknown = JSON.parse(selected.ids);
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 100 ||
      !ids.every(
        (value) => typeof value === "string" && /^-?[0-9]{1,19}$/.test(value),
      )
    )
      throw new Error("INVALID_LEAF");
    const scope = predicate(table, item);
    const mutation =
      table === "archive_settings" && item.scope === "connection"
        ? `UPDATE archive_settings AS v SET enabled=0,version=CASE WHEN version<2147483646 THEN version+1 ELSE version END,connection_id=NULL,connection_generation=NULL,disclosure_version=NULL,accepted_at=NULL WHERE v.user_id=? AND v.rowid IN(SELECT value FROM json_each(?)) AND ${scope.text} AND ${guard.text}`
        : `DELETE FROM ${table} AS v WHERE v.user_id=? AND v.rowid IN(SELECT value FROM json_each(?)) AND ${scope.text} AND ${guard.text}`;
    await db
      .prepare(mutation)
      .bind(item.user_id, selected.ids, ...scope.values, ...guard.values)
      .run();
    return true;
  } catch {
    throw new Error("M1_LEAF_CLEANUP_UNAVAILABLE");
  }
}
