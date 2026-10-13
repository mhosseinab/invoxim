import type { CorrectionCommand, CorrectionResult } from "@invoxim/contracts";
import type { CorrectionSession, CorrectionStore } from "@invoxim/core";
import { executeCashConfirm } from "./cash-confirm-operation";
import { executeEventEdit } from "./event-edit-operation";
import { executeInclusion } from "./inclusion-operation";
import { executeMerge } from "./merge-operation";
import { executePurchaseEdit } from "./purchase-edit-operation";
import { readCorrectionPurchase, readCorrectionReview } from "./reader";
import { executeReview } from "./review-operation";
import { replayCorrection } from "./transaction";
export function createCorrectionStore(
  db: D1Database,
  clock: () => number = Date.now,
): CorrectionStore {
  async function execute(
    session: CorrectionSession,
    command: CorrectionCommand,
    key: string,
  ): Promise<CorrectionResult> {
    const identity = await replayCorrection(db, session, command, key, clock);
    if (identity.result) return identity.result;
    if (command.kind === "purchase-edit")
      return executePurchaseEdit(db, session, command, key, identity, clock);
    if (command.kind === "event-edit")
      return executeEventEdit(db, session, command, key, identity, clock);
    if (command.kind === "cash-confirm")
      return executeCashConfirm(db, session, command, key, identity, clock);
    if (command.kind === "exclude" || command.kind === "restore")
      return executeInclusion(db, session, command, key, identity, clock);
    if (command.kind === "merge" || command.kind === "unmerge")
      return executeMerge(db, session, command, key, identity, clock);
    return executeReview(db, session, command, key, identity, clock);
  }
  return {
    execute,
    readPurchase: (tenant, id) => readCorrectionPurchase(db, tenant, id),
    readReview: (tenant, id) => readCorrectionReview(db, tenant, id),
  };
}
