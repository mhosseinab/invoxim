import type { CorrectionCommand, CorrectionResult } from "@invoxim/contracts";
import type { CorrectionSession } from "@invoxim/core";
import {
  CorrectionError,
  evaluateCorrectionSettlement,
  settlementEvents,
  validateEntryChange,
} from "@invoxim/core";
import {
  allocationsCheck,
  creditProofs,
  planAllocations,
  writeAllocations,
} from "./allocation";
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
export async function executeEventEdit(
  db: D1Database,
  session: CorrectionSession,
  command: Extract<CorrectionCommand, { kind: "event-edit" }>,
  key: string,
  identity: { route: string; bodyHash: string },
  clock: () => number,
): Promise<CorrectionResult> {
  const user = session.tenant.userId;

  const owned = await db
    .prepare(
      "SELECT purchase_id FROM ledger_entries WHERE user_id=? AND id=? AND EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')",
    )
    .bind(user, command.entryId, user)
    .first<{ purchase_id: string | null }>();
  if (!owned?.purchase_id) throw new CorrectionError("NOT_FOUND");
  const row = await purchase(db, user, owned.purchase_id);
  const all = await events(db, user, row.id);
  const entry = all.find((item) => item.id === command.entryId);
  if (
    !entry ||
    entry.version !== command.request.version ||
    entry.version >= 2147483646
  )
    throw new CorrectionError("CONFLICT");
  validateEntryChange(entry, command.request.changes, all);
  const checks = [
    purchaseVersion(user, row, row.version),
    {
      sql: "EXISTS(SELECT 1 FROM ledger_entries WHERE user_id=? AND id=? AND version=? AND version<2147483646)",
      values: [user, entry.id, entry.version],
    },
  ];
  const warnings = await reviews(db, user, row.id);
  const changed = all.map((item) =>
    item.id === entry.id
      ? {
          ...item,
          amountMinor: command.request.changes.amountMinor ?? item.amountMinor,
          currency: command.request.changes.currency ?? item.currency,
          eventDate: command.request.changes.eventDate ?? item.eventDate,
        }
      : item,
  );
  const settlement = evaluateCorrectionSettlement(
    {
      currency: row.currency,
      totalMinor: row.total_minor === null ? null : String(row.total_minor),
      paymentState: row.payment_state,
    },
    settlementEvents(changed, warnings.map(reviewFact)),
    await creditProofs(db, user, row.id),
  );
  const allocations = planAllocations(row, settlement, warnings);
  checks.push(...allocationsCheck(user, allocations));
  const result = {
    ...emptyResult,
    purchaseId: row.id,
    version: row.version + 1,
    entryId: entry.id,
    entryVersion: entry.version + 1,
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
  const mappings = {
    amountMinor: "amount_minor",
    currency: "currency",
    eventDate: "event_date",
  } as const;
  const assignments: string[] = [];
  const values: SqlValue[] = [];
  for (const [field, value] of Object.entries(command.request.changes)) {
    if (value === undefined || !Object.hasOwn(mappings, field))
      throw new CorrectionError("INVALID_REQUEST");
    const name = field as keyof typeof mappings;
    assignments.push(`${mappings[name]}=?`);
    values.push(name === "amountMinor" ? Number(value) : value);
    tx.override("entry", entry.id, name, entry[name], value, entry.version + 1);
  }
  if (command.request.changes.eventDate !== undefined) {
    assignments.push("date_basis=?");
    values.push("user-corrected-date");
    tx.override(
      "entry",
      entry.id,
      "dateBasis",
      entry.dateBasis,
      "user-corrected-date",
      entry.version + 1,
    );
  }
  tx.add(
    `UPDATE ledger_entries SET ${assignments.join(",")},version=version+1 WHERE user_id=? AND id=? AND ${tx.guard}`,
    [...values, user, entry.id, ...tx.guardValues],
  );
  writeAllocations(tx, user, row.id, allocations, clock);
  tx.add(
    `UPDATE purchases SET version=version+1,payment_state=? WHERE user_id=? AND id=? AND ${tx.guard}`,
    [settlement.paymentState, user, row.id, ...tx.guardValues],
  );
  return tx.commit();
}
