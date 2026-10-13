import type { CorrectionCommand } from "@invoxim/contracts";
import type { CorrectionSession, CorrectionStore } from "./types";
import { CorrectionError } from "./types";
export function createCorrectionService(store: CorrectionStore) {
  return {
    readPurchase: store.readPurchase,
    readReview: store.readReview,
    execute(
      session: CorrectionSession,
      command: CorrectionCommand,
      key: string,
    ) {
      if (
        session.tenant.authority !== "session" ||
        !/^[A-Za-z0-9_-]{16,120}$/.test(key)
      )
        throw new CorrectionError("INVALID_REQUEST");
      return store.execute(session, command, key);
    },
  };
}
