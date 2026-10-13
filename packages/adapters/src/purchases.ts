import type { TenantContext } from "@invoxim/core";
import { calendarDate, minorDigits, parseMinor } from "@invoxim/core";
export interface PurchaseRow {
  id: string;
  merchant_raw: string;
  document_date: string;
  total_minor: string | null;
  currency: string | null;
  payment_state: string;
  version: number;
}
const columns =
  "id,merchant_raw,document_date,CAST(total_minor AS TEXT) AS total_minor,currency,payment_state,version";
export function createPurchaseRepository(db: D1Database) {
  return {
    // beforeDate is an exclusive date filter, not a continuation cursor.
    async list(
      context: TenantContext,
      options: { limit?: number; beforeDate?: string } = {},
    ) {
      const limit = options.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error("INVALID_PAGE");
      const before =
        options.beforeDate === undefined
          ? "9999-12-31"
          : calendarDate(options.beforeDate);
      return (
        await db
          .prepare(
            `SELECT ${columns} FROM purchases WHERE user_id=? AND document_date<? ORDER BY document_date DESC,id LIMIT ?`,
          )
          .bind(context.userId, before, limit)
          .all<PurchaseRow>()
      ).results;
    },
    async detail(context: TenantContext, id: string) {
      const purchase = await db
        .prepare(`SELECT ${columns} FROM purchases WHERE user_id=? AND id=?`)
        .bind(context.userId, id)
        .first<PurchaseRow>();
      if (!purchase) return null;
      const evidence = (
        await db
          .prepare(
            "SELECT o.id,o.evidence_code,d.id AS document_id,d.mime,d.content_hash FROM purchase_evidence e JOIN observations o ON o.user_id=e.user_id AND o.id=e.observation_id JOIN documents d ON d.user_id=o.user_id AND d.id=o.document_id WHERE e.user_id=? AND e.purchase_id=?",
          )
          .bind(context.userId, id)
          .all<{
            id: string;
            evidence_code: string;
            document_id: string;
            mime: string;
            content_hash: string;
          }>()
      ).results;
      return { purchase, evidence };
    },
    async updateMerchant(
      context: TenantContext,
      id: string,
      expectedVersion: number,
      merchant: string,
    ) {
      if (
        merchant.trim().length === 0 ||
        merchant.length > 200 ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1
      )
        throw new Error("INVALID_EDIT");
      const result = await db
        .prepare(
          "UPDATE purchases SET merchant_raw=?,merchant_normalized=?,version=version+1 WHERE user_id=? AND id=? AND version=? AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')",
        )
        .bind(
          merchant,
          merchant.trim().toLowerCase(),
          context.userId,
          id,
          expectedVersion,
          context.userId,
        )
        .run();
      return result.meta.changes === 1;
    },
    async delete(context: TenantContext, id: string, expectedVersion: number) {
      const result = await db
        .prepare(
          "DELETE FROM purchases WHERE user_id=? AND id=? AND version=? AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')",
        )
        .bind(context.userId, id, expectedVersion, context.userId)
        .run();
      return result.meta.changes === 1;
    },
    async totals(context: TenantContext, currency: string) {
      minorDigits(currency);
      let paid = 0n,
        refunded = 0n,
        cursor = "";
      // Bounded individual INTEGER values are safe; aggregate only with BigInt, never SQLite SUM -> Number.
      for (;;) {
        const rows = (
          await db
            .prepare(
              "SELECT id,kind,CAST(amount_minor AS TEXT) AS minor FROM ledger_entries WHERE user_id=? AND currency=? AND eligible=1 AND id>? ORDER BY id LIMIT 500",
            )
            .bind(context.userId, currency, cursor)
            .all<{ id: string; kind: string; minor: string }>()
        ).results;
        for (const row of rows) {
          const amount = parseMinor(row.minor);
          if (row.kind === "payment") paid += amount;
          else refunded += amount;
        }
        if (rows.length < 500) break;
        const lastRow = rows.at(-1);
        if (!lastRow) throw new Error("PURCHASE_QUERY_UNAVAILABLE");
        cursor = lastRow.id;
      }
      return {
        paidMinor: paid.toString(),
        refundedMinor: refunded.toString(),
        netMinor: (paid - refunded).toString(),
      };
    },
  };
}
