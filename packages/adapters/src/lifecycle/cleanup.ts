import type { DeletionJournal } from "@invoxim/core";
import { cleanupConnection } from "./connection-cleanup";
import { cleanupM1Leaves } from "./m1-leaf-cleanup";

/** Leaf-first bounded erasure. Profiles remain deleting until the entire active graph is empty. */
const accountTables = [
  "usage_events",
  "ai_extractions",
  "purchase_evidence",
  "manual_purchase_evidence",
  "field_overrides",
  "correction_audit",
  "ledger_match_decisions",
  "purchase_merges",
  "ledger_entries",
  "review_items",
  "observations",
  "purchases",
  "documents",
  "discovery_source_jobs",
  "discovery_run_sources",
  "source_messages",
  "discovery_seen_refs",
  "jobs",
  "sync_states",
  "onboarding_commands",
  "import_runs",
  "processing_consents",
  "mailbox_refresh_leases",
  "mailbox_oauth_intents",
  "oauth_states",
  "connections",
  "ai_settings",
  "usage_buckets",
  "lifecycle_commands",
  "correction_commands",
  "account",
] as const;
interface Pending {
  user_id: string;
  scope: "account" | "connection";
  target_id: string;
  request_id: string;
  deleted_at: number;
  stage: number;
  journal_ack: number;
}
export function createLifecycleCleanup(
  db: D1Database,
  journal: DeletionJournal | null,
) {
  return {
    /** A scheduler invokes exactly one bounded unit using its existing invocation database meter. */
    async runOne() {
      const item = await db
        .prepare(
          "SELECT user_id,scope,target_id,request_id,deleted_at,stage,journal_ack FROM lifecycle_deletions ld WHERE EXISTS(SELECT 1 FROM profiles p WHERE p.user_id=ld.user_id AND ((ld.scope='account' AND p.status='deleting') OR (ld.scope='connection' AND p.status='active'))) ORDER BY deleted_at,user_id,scope,target_id LIMIT 1",
        )
        .first<Pending>();
      if (!item) {
        const expired = await db
          .prepare(
            "DELETE FROM lifecycle_commands WHERE rowid IN(SELECT rowid FROM lifecycle_commands WHERE created_at<? LIMIT 100)",
          )
          .bind(Date.now() - 7 * 86400000)
          .run();
        return {
          status: expired.meta.changes
            ? ("pending" as const)
            : ("idle" as const),
        };
      }
      if (item.scope === "connection") return cleanupConnection(db, item);
      if (!item.journal_ack) {
        if (!journal) return { status: "awaiting_journal" as const };
        try {
          await journal.append({
            userId: item.user_id,
            deletedAt: item.deleted_at,
            requestId: item.request_id,
          });
          await db
            .prepare(
              "UPDATE lifecycle_deletions SET journal_ack=1 WHERE user_id=? AND scope='account' AND request_id=? AND deleted_at=? AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='deleting')",
            )
            .bind(item.user_id, item.request_id, item.deleted_at, item.user_id)
            .run();
        } catch {
          return { status: "awaiting_journal" as const };
        }
        return { status: "pending" as const };
      }
      if (
        item.stage >= 8 &&
        (await cleanupM1Leaves(db, { ...item, scope: "account" }))
      )
        return { status: "pending" as const };
      const table = accountTables[item.stage];
      if (table) {
        const owner = table === "account" ? "userId" : "user_id";
        const removed = await db
          .prepare(
            `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${owner}=? LIMIT 100) AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='deleting') AND EXISTS(SELECT 1 FROM lifecycle_deletions WHERE user_id=? AND scope='account' AND stage=? AND journal_ack=1) RETURNING 1 AS applied`,
          )
          .bind(item.user_id, item.user_id, item.user_id, item.stage)
          .all<{ applied: number }>();
        if (removed.results.length < 100)
          await db
            .prepare(
              "UPDATE lifecycle_deletions SET stage=stage+1 WHERE user_id=? AND scope='account' AND stage=? AND journal_ack=1",
            )
            .bind(item.user_id, item.stage)
            .run();
        return { status: "pending" as const };
      }
      await db
        .prepare(
          "DELETE FROM user WHERE id=? AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='deleting') AND EXISTS(SELECT 1 FROM lifecycle_deletions WHERE user_id=? AND scope='account' AND stage=? AND journal_ack=1)",
        )
        .bind(item.user_id, item.user_id, item.user_id, accountTables.length)
        .run();
      return { status: "completed" as const };
    },
  };
}
