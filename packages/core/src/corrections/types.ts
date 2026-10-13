import type {
  CorrectionCommand,
  CorrectionResult,
  CorrectionReview,
  CorrectionState,
} from "@invoxim/contracts";
import type { TenantContext } from "../tenant-context";
export interface CorrectionSession {
  tenant: TenantContext;
  sessionId: string;
}
export interface CorrectionStore {
  execute(
    session: CorrectionSession,
    command: CorrectionCommand,
    idempotencyKey: string,
  ): Promise<CorrectionResult>;
  readPurchase(
    tenant: TenantContext,
    id: string,
  ): Promise<Omit<CorrectionState, "mutationToken"> | null>;
  readReview(
    tenant: TenantContext,
    id: string,
  ): Promise<Omit<CorrectionReview, "mutationToken"> | null>;
}
export class CorrectionError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "NOT_FOUND"
      | "CONFLICT"
      | "TOO_LARGE"
      | "UNAVAILABLE",
  ) {
    super(code);
  }
}
