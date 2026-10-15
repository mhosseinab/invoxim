import type {
  AiMissingField,
  PersistableAiResult,
  PersistedAiRecord,
} from "../ai/types";

export interface LedgerIdentity {
  readonly documentId: string;
  readonly contentHash: string;
  readonly extractionFingerprint: string;
}
export interface LedgerInput {
  readonly identity: LedgerIdentity;
  readonly result: PersistableAiResult;
}
export interface LedgerObservation {
  readonly id: string;
  readonly identity: LedgerIdentity;
  readonly segmentIndex: number;
  readonly documentType: Extract<
    PersistableAiResult,
    { status: "accepted" }
  >["documentType"];
  readonly record: PersistedAiRecord;
  readonly purchaseId: string | null;
}
/** Purchase fields a user can correct; extraction never overwrites them. */
export type OverriddenField =
  | "merchant"
  | "category"
  | "documentDate"
  | "totalMinor"
  | "currency"
  | "invoiceNumber"
  | "orderReference"
  | "paymentState";
export interface LedgerPurchase {
  readonly id: string;
  readonly merchant: string;
  readonly currency: string | null;
  readonly totalMinor: number | null;
  readonly documentDate: string;
  readonly invoiceNumber: string | null;
  readonly orderReference: string | null;
  readonly category: PersistedAiRecord["category"];
  readonly paymentState: "unknown" | "unpaid" | "partially_paid" | "paid";
  readonly recordStatus?: "active" | "excluded" | "merged";
  readonly version: number;
  /** Persisted manual decisions; extraction never overwrites these fields. */
  readonly overriddenFields: readonly OverriddenField[];
}
export interface LedgerEvent {
  readonly id: string;
  readonly businessKey: string;
  readonly purchaseId: string | null;
  readonly observationId: string | null;
  readonly origin?: "source" | "user-confirmed";
  /** Immutable original source values for user-overridden cash fields. */
  readonly sourceValues?: {
    readonly amountMinor?: number;
    readonly currency?: string;
    readonly eventDate?: string;
    readonly dateBasis?: LedgerEvent["dateBasis"];
  };
  readonly kind: "payment" | "refund";
  readonly amountMinor: number;
  readonly currency: string;
  readonly eventDate: string;
  readonly dateBasis:
    | "explicit-event-date"
    | "document-date"
    | "user-confirmed-date"
    | "user-corrected-date";
  readonly eligible: boolean;
  readonly version: number;
  /**
   * Cash-proof facts of the entry's source observation, as corrections load
   * them: snapshot events carry the persisted facts, planned events this
   * document's facts.
   */
  readonly cashProof: LedgerCashProof;
}
export interface LedgerCashProof {
  /** The source observation's document; null without an observation. */
  readonly documentId: string | null;
  /** observations.evidence_code; null without an observation. */
  readonly evidenceCode: string | null;
  /** observations.review_state = 'accepted'. */
  readonly accepted: boolean;
}
export const LEDGER_REVIEW_REASONS = [
  "extraction-review",
  "incomplete-financial-facts",
  "unknown-payment",
  "payment-allocation-review",
  "ambiguous-event",
  "event-conflict",
  "invoice-conflict",
  "purchase-conflict",
  "possible-duplicate",
  "unmatched-refund",
  "refund-exceeds-payment",
  "refund-currency-mismatch",
  "credit-note-completion",
  "mixed-tender",
] as const satisfies readonly string[];
export type LedgerReviewReason = (typeof LEDGER_REVIEW_REASONS)[number];
export interface LedgerReview {
  readonly missingFields?: readonly AiMissingField[];
  readonly id: string;
  readonly reason: LedgerReviewReason;
  readonly blockingScope: "financial";
  readonly documentId: string;
  readonly observationId: string | null;
  readonly purchaseId: string | null;
}
export interface LedgerEvidence {
  readonly purchaseId: string;
  readonly observationId: string;
  readonly relationship: "document";
}
export interface LedgerMatchDecision {
  readonly contentHash: string;
  readonly segmentIndex: number;
  readonly purchaseId: string;
  readonly decision: "same-purchase" | "different-purchase";
}
/**
 * A persisted open financial review that can block cash (corrections rule):
 * purchase-scoped, or linked through an entry's observation or, without
 * observation, its document. Never `payment-allocation-review`.
 */
export interface LedgerCashReview {
  readonly id: string;
  readonly observationId: string | null;
  readonly documentId: string | null;
  readonly purchaseId: string | null;
  readonly reason: LedgerReviewReason;
}
/** A persisted store-credit settlement proof (corrections creditProofSql rule). */
export interface LedgerCreditProof {
  readonly purchaseId: string;
  readonly currency: string;
  readonly totalMinor: string;
  readonly creditMinor: string;
}
/** Must be loaded exclusively for the trusted tenant by the persistence port. */
export interface LedgerSnapshot {
  /** User-associated source documents, without invented model observations or segment IDs. */
  readonly manualEvidence?: readonly {
    readonly contentHash: string;
    readonly purchaseId: string;
  }[];
  readonly observations: readonly LedgerObservation[];
  readonly purchases: readonly LedgerPurchase[];
  readonly events: readonly LedgerEvent[];
  readonly decisions: readonly LedgerMatchDecision[];
  /** Credit proofs of the snapshot purchases; payment state counts cash plus credit. */
  readonly creditProofs?: readonly LedgerCreditProof[];
  /** Open financial reviews that can block the snapshot's (and this document's) cash. */
  readonly reviews?: readonly LedgerCashReview[];
}
/** Insert-only candidate plan. Existing financial values and overrides stay intact. */
export interface LedgerPlan {
  readonly observations: readonly LedgerObservation[];
  readonly purchases: readonly LedgerPurchase[];
  readonly evidence: readonly LedgerEvidence[];
  readonly events: readonly LedgerEvent[];
  readonly reviews: readonly LedgerReview[];
  readonly expectedPurchases: readonly {
    readonly id: string;
    readonly version: number;
  }[];
  readonly paymentStates: readonly {
    readonly purchaseId: string;
    readonly expectedVersion: number;
    readonly paymentState: LedgerPurchase["paymentState"];
  }[];
}
