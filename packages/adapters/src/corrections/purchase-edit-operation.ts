import type { CorrectionCommand, CorrectionResult } from "@invoxim/contracts";
import type { CorrectionSession } from "@invoxim/core";
import {
  CorrectionError,
  evaluateCorrectionSettlement,
  normalizeLedgerMerchant,
  settlementEvents,
} from "@invoxim/core";
import {
  allocationsCheck,
  creditProofs,
  planAllocations,
  writeAllocations,
} from "./allocation";
import type { PurchaseRow } from "./data";
import { events, purchase, purchaseVersion, reviewFact, reviews } from "./data";
import type { SqlValue } from "./transaction";
import { correctionTransaction } from "./transaction";

const emptyResult: CorrectionResult = {
  purchaseId: null,
  version: null,
  entryId: null,
  entryVersion: null,
  reviewId: null,
  reviewVersion: null,
  reviewStatus: null,
  mergeId: null,
};
const fields = {
  merchant: "merchant_raw",
  category: "category",
  documentDate: "document_date",
  totalMinor: "total_minor",
  currency: "currency",
  invoiceReference: "invoice_ref",
  orderReference: "order_ref",
} as const;
function previous(row: PurchaseRow, field: keyof typeof fields) {
  const value = row[fields[field]];
  return field === "totalMinor" && value !== null ? String(value) : value;
}
export async function executePurchaseEdit(
  db: D1Database,
  session: CorrectionSession,
  command: Extract<CorrectionCommand, { kind: "purchase-edit" }>,
  key: string,
  identity: { route: string; bodyHash: string },
  clock: () => number,
): Promise<CorrectionResult> {
  const user = session.tenant.userId;

  const row = await purchase(db, user, command.purchaseId);
  const checks = [purchaseVersion(user, row, command.request.version)];
  const financial =
    Object.hasOwn(command.request.changes, "totalMinor") ||
    Object.hasOwn(command.request.changes, "currency");
  const nextCurrency = Object.hasOwn(command.request.changes, "currency")
    ? (command.request.changes.currency ?? null)
    : row.currency;
  const nextTotal = Object.hasOwn(command.request.changes, "totalMinor")
    ? (command.request.changes.totalMinor ?? null)
    : row.total_minor === null
      ? null
      : String(row.total_minor);
  const warnings = financial ? await reviews(db, user, row.id) : [];
  const settlement = financial
    ? evaluateCorrectionSettlement(
        {
          currency: nextCurrency,
          totalMinor: nextTotal,
          paymentState: row.payment_state,
        },
        settlementEvents(
          await events(db, user, row.id),
          warnings.map(reviewFact),
        ),
        await creditProofs(db, user, row.id),
      )
    : null;
  const allocations = settlement
    ? planAllocations(row, settlement, warnings)
    : [];
  checks.push(...allocationsCheck(user, allocations));
  const result = {
    ...emptyResult,
    purchaseId: row.id,
    version: row.version + 1,
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
  const assignments: string[] = [];
  const values: SqlValue[] = [];
  for (const [field, value] of Object.entries(command.request.changes)) {
    if (value === undefined || !Object.hasOwn(fields, field))
      throw new CorrectionError("INVALID_REQUEST");
    const name = field as keyof typeof fields;
    assignments.push(`${fields[name]}=?`);
    values.push(
      name === "totalMinor" && value !== null ? Number(value) : value,
    );
    tx.override(
      "purchase",
      row.id,
      name,
      previous(row, name),
      value,
      row.version + 1,
    );
    if (name === "merchant") {
      assignments.push("merchant_normalized=?");
      values.push(normalizeLedgerMerchant(String(value)));
    }
  }
  if (settlement) {
    assignments.push("payment_state=?");
    values.push(settlement.paymentState);
    writeAllocations(tx, user, row.id, allocations, clock);
  }
  tx.add(
    `UPDATE purchases SET ${assignments.join(",")},version=version+1 WHERE user_id=? AND id=? AND ${tx.guard}`,
    [...values, user, row.id, ...tx.guardValues],
  );
  return tx.commit();
}
