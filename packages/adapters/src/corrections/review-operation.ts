import type { CorrectionCommand, CorrectionResult } from "@invoxim/contracts";
import type { CorrectionSession } from "@invoxim/core";
import {
  assertReviewAction,
  CorrectionError,
  normalizeLedgerMerchant,
} from "@invoxim/core";
import {
  type PurchaseRow,
  purchase,
  purchaseVersion,
  review,
  reviewFact,
  reviewVersion,
} from "./data";
import { planReviewUnblock } from "./review-unblock";
import { sourceNotDiscardedSql } from "./source-decision";
import { discardableSource, executeSourceDiscard } from "./source-discard";
import { correctionTransaction } from "./transaction";

const empty: CorrectionResult = {
  purchaseId: null,
  version: null,
  entryId: null,
  entryVersion: null,
  reviewId: null,
  reviewVersion: null,
  reviewStatus: null,
  mergeId: null,
};
export async function executeReview(
  db: D1Database,
  session: CorrectionSession,
  command: Extract<CorrectionCommand, { kind: "review-resolve" }>,
  key: string,
  identity: { route: string; bodyHash: string },
  clock: () => number,
) {
  const user = session.tenant.userId,
    row = await review(db, user, command.reviewId),
    request = command.request;
  assertReviewAction(
    {
      ...reviewFact(row),
      canDiscardSource:
        request.action === "not-a-purchase" &&
        !!(await discardableSource(db, user, row.document_id)),
    },
    request,
  );
  const checks = [reviewVersion(user, row, request.version)];
  if (row.document_id)
    checks.push({
      sql: `EXISTS(SELECT 1 FROM documents d JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id WHERE d.user_id=? AND d.id=? AND ${sourceNotDiscardedSql("s")})`,
      values: [user, row.document_id],
    });
  if (request.action === "not-a-purchase")
    return executeSourceDiscard(db, session, row, key, identity, checks, clock);
  const owned = row.purchase_id
    ? await purchase(db, user, row.purchase_id)
    : null;
  if (owned)
    checks.push(
      purchaseVersion(
        user,
        owned,
        "purchaseVersion" in request ? request.purchaseVersion : owned.version,
      ),
    );
  if (request.action === "complete-record") {
    const id = crypto.randomUUID();
    const status = row.reason === "unmatched-refund" ? "open" : "resolved";
    const result = {
      ...empty,
      purchaseId: id,
      version: 1,
      reviewId: row.id,
      reviewVersion: row.version + 1,
      reviewStatus: status as "open" | "resolved",
    };
    const unblock =
      status === "resolved" ? await planReviewUnblock(db, user, row) : null;
    if (unblock) checks.push(...unblock.checks);
    const tx = correctionTransaction(
      db,
      session,
      key,
      identity,
      result,
      checks,
      clock,
    );
    const data = request.record;
    tx.add(
      `INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,category,invoice_ref,order_ref,payment_state,origin) SELECT ?,?,?,?,?,?,?,?,?,?,'unknown','user-supplied' WHERE ${tx.guard}`,
      [
        id,
        user,
        data.merchant,
        normalizeLedgerMerchant(data.merchant),
        data.documentDate,
        Number(data.totalMinor),
        data.currency,
        data.category,
        data.invoiceReference ?? null,
        data.orderReference ?? null,
        ...tx.guardValues,
      ],
    );
    tx.add(
      `INSERT INTO manual_purchase_evidence(user_id,purchase_id,document_id) SELECT ?,?,? WHERE ${tx.guard}`,
      [user, id, row.document_id, ...tx.guardValues],
    );
    for (const [field, value] of Object.entries(data)) {
      if (value === undefined) throw new CorrectionError("INVALID_REQUEST");
      tx.override("purchase", id, field, null, value, 1);
    }
    tx.add(
      `UPDATE review_items SET purchase_id=?,status=?,missing_fields_json=NULL,version=version+1 WHERE user_id=? AND id=? AND ${tx.guard}`,
      [id, status, user, row.id, ...tx.guardValues],
    );
    tx.audit(
      "review",
      row.id,
      "user-record-completed",
      { status: row.status },
      { status },
    );
    unblock?.write(tx, clock);
    return tx.commit();
  }
  const result: CorrectionResult = {
    ...empty,
    purchaseId: owned?.id ?? null,
    version: owned ? owned.version + 1 : null,
    reviewId: row.id,
    reviewVersion: row.version + 1,
    reviewStatus:
      request.action === "dismiss-operational"
        ? ("dismissed" as const)
        : ("resolved" as const),
  };
  if (request.action === "correct-missing-fields") {
    if (!owned) throw new CorrectionError("CONFLICT");
    const columns = {
      merchant: "merchant_raw",
      currency: "currency",
      totalMinor: "total_minor",
      documentDate: "document_date",
    } as const;
    const assignments: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [field, value] of Object.entries(request.changes)) {
      if (value === undefined || !Object.hasOwn(columns, field))
        throw new CorrectionError("INVALID_REQUEST");
      const name = field as keyof typeof columns;
      assignments.push(`${columns[name]}=?`);
      values.push(name === "totalMinor" ? Number(value) : value);
      if (name === "merchant") {
        assignments.push("merchant_normalized=?");
        values.push(normalizeLedgerMerchant(String(value)));
      }
    }
    const addressed = new Set(
      Object.keys(request.changes).map((field) =>
        field === "totalMinor" ? "total" : field,
      ),
    );
    const remaining = reviewFact(row).missingFields.filter(
      (field) => !addressed.has(field),
    );
    result.reviewStatus = remaining.length ? "open" : "resolved";
    // The purchase as this correction leaves it, for the payment recompute.
    const corrected: PurchaseRow = { ...owned };
    for (const [field, value] of Object.entries(request.changes)) {
      if (field === "merchant") corrected.merchant_raw = String(value);
      else if (field === "currency") corrected.currency = String(value);
      else if (field === "totalMinor") corrected.total_minor = Number(value);
      else if (field === "documentDate")
        corrected.document_date = String(value);
    }
    const unblock =
      result.reviewStatus === "resolved"
        ? await planReviewUnblock(db, user, row, { owned: corrected })
        : null;
    if (unblock) checks.push(...unblock.checks);
    // Result must reflect only the fields actually corrected, not a blanket resolution.
    const updated = correctionTransaction(
      db,
      session,
      key,
      identity,
      result,
      checks,
      clock,
    );
    for (const [field, value] of Object.entries(request.changes)) {
      const name = field as keyof typeof columns;
      updated.override(
        "purchase",
        owned.id,
        name,
        name === "totalMinor" && owned.total_minor !== null
          ? String(owned.total_minor)
          : owned[columns[name]],
        value,
        owned.version + 1,
      );
    }
    updated.add(
      `UPDATE purchases SET ${assignments.join(",")},version=version+1 WHERE user_id=? AND id=? AND ${updated.guard}`,
      [...values, user, owned.id, ...updated.guardValues],
    );
    updated.add(
      `UPDATE review_items SET missing_fields_json=?,status=?,version=version+1 WHERE user_id=? AND id=? AND ${updated.guard}`,
      [
        remaining.length ? JSON.stringify(remaining) : null,
        result.reviewStatus,
        user,
        row.id,
        ...updated.guardValues,
      ],
    );
    updated.audit(
      "review",
      row.id,
      "missing-fields-corrected",
      { status: row.status },
      { status: result.reviewStatus },
    );
    unblock?.write(updated, clock);
    return updated.commit();
  }
  const unblock = await planReviewUnblock(db, user, row, { owned });
  checks.push(...unblock.checks);
  const tx = correctionTransaction(
    db,
    session,
    key,
    identity,
    result,
    checks,
    clock,
  );
  if (request.action === "different-purchase") {
    if (!owned || !row.observation_id) throw new CorrectionError("CONFLICT");
    const similar = await db
      .prepare(
        "SELECT id FROM purchases WHERE user_id=? AND id!=? AND merchant_normalized=? AND document_date=? AND currency IS ? AND total_minor IS ? AND record_status!='merged' LIMIT 201",
      )
      .bind(
        user,
        owned.id,
        owned.merchant_normalized,
        owned.document_date,
        owned.currency,
        owned.total_minor,
      )
      .all();
    if (similar.results.length > 200) throw new CorrectionError("TOO_LARGE");
    tx.add(
      `INSERT INTO ledger_match_decisions(user_id,content_hash,segment_index,purchase_id,decision) SELECT o.user_id,d.content_hash,o.segment_index,?,'same-purchase' FROM observations o JOIN documents d ON d.user_id=o.user_id AND d.id=o.document_id WHERE o.user_id=? AND o.id=? AND ${tx.guard} ON CONFLICT(user_id,content_hash,segment_index,purchase_id) DO UPDATE SET decision='same-purchase'`,
      [owned.id, user, row.observation_id, ...tx.guardValues],
    );
    tx.add(
      `INSERT INTO ledger_match_decisions(user_id,content_hash,segment_index,purchase_id,decision) SELECT o.user_id,d.content_hash,o.segment_index,p.id,'different-purchase' FROM observations o JOIN documents d ON d.user_id=o.user_id AND d.id=o.document_id JOIN purchases p ON p.user_id=o.user_id AND p.id!=? AND p.merchant_normalized=? AND p.document_date=? AND p.currency IS ? AND p.total_minor IS ? AND p.record_status!='merged' WHERE o.user_id=? AND o.id=? AND ${tx.guard} LIMIT 200 ON CONFLICT(user_id,content_hash,segment_index,purchase_id) DO UPDATE SET decision='different-purchase'`,
      [
        owned.id,
        owned.merchant_normalized,
        owned.document_date,
        owned.currency,
        owned.total_minor,
        user,
        row.observation_id,
        ...tx.guardValues,
      ],
    );
  }
  tx.add(
    `UPDATE review_items SET status=?,version=version+1 WHERE user_id=? AND id=? AND ${tx.guard}`,
    [result.reviewStatus, user, row.id, ...tx.guardValues],
  );
  if (owned)
    tx.add(
      `UPDATE purchases SET version=version+1 WHERE user_id=? AND id=? AND ${tx.guard}`,
      [user, owned.id, ...tx.guardValues],
    );
  tx.audit(
    "review",
    row.id,
    request.action,
    { status: row.status },
    { status: result.reviewStatus },
  );
  unblock.write(tx, clock);
  return tx.commit();
}
