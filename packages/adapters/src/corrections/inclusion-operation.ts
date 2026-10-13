import type { CorrectionCommand, CorrectionResult } from "@invoxim/contracts";
import type { CorrectionSession } from "@invoxim/core";
import {
  restorationEligibility,
  validateRefundAllocation,
} from "@invoxim/core";
import { events, purchase, purchaseVersion, reviewFact, reviews } from "./data";
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
export async function executeInclusion(
  db: D1Database,
  session: CorrectionSession,
  command: Extract<CorrectionCommand, { kind: "exclude" | "restore" }>,
  key: string,
  identity: { route: string; bodyHash: string },
  clock: () => number,
): Promise<CorrectionResult> {
  const user = session.tenant.userId;

  const row = await purchase(db, user, command.purchaseId);
  const all = await events(db, user, row.id);
  const warningRows = await reviews(db, user, row.id);
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
    [purchaseVersion(user, row, command.request.version)],
    clock,
  );
  tx.add(
    `UPDATE purchases SET record_status=?,version=version+1 WHERE user_id=? AND id=? AND ${tx.guard}`,
    [
      command.kind === "exclude" ? "excluded" : "active",
      user,
      row.id,
      ...tx.guardValues,
    ],
  );
  if (command.kind === "exclude")
    tx.add(
      `UPDATE ledger_entries SET eligible=0 WHERE user_id=? AND purchase_id=? AND ${tx.guard}`,
      [user, row.id, ...tx.guardValues],
    );
  else {
    const restored = all.filter((item) =>
      restorationEligibility(item, warningRows.map(reviewFact)),
    );
    validateRefundAllocation(restored);
    const eligible = restored.map((item) => item.id);
    tx.add(
      `UPDATE ledger_entries SET eligible=CASE WHEN id IN(SELECT value FROM json_each(?)) THEN 1 ELSE 0 END WHERE user_id=? AND purchase_id=? AND ${tx.guard}`,
      [JSON.stringify(eligible), user, row.id, ...tx.guardValues],
    );
  }
  tx.audit(
    "purchase",
    row.id,
    command.kind,
    { recordStatus: row.record_status },
    {
      recordStatus: command.kind === "exclude" ? "excluded" : "active",
      ...(command.kind === "exclude" ? { reason: command.request.reason } : {}),
    },
  );
  return tx.commit();
}
