export interface CorpusCase {
  id: string;
  partition: "development" | "holdout";
  family: string;
  language: "en" | "de";
  clean: boolean;
  representation:
    | "plain"
    | "html"
    | "mime"
    | "png"
    | "jpeg"
    | "pdf"
    | "invalid-utf8";
  source: string;
  preset: string;
  response: "complete" | "truncated" | "refusal";
  expected: {
    parser: string;
    validation: "accepted" | "needs-review" | "not-run";
    events: {
      kind: "payment" | "refund";
      amountMinor: number;
      currency: string;
    }[];
    replayEvents: number;
  };
  seedPayment?: boolean;
  duplicateSource?: boolean;
}
export interface OfflineOutcome {
  parser: string;
  validation: "accepted" | "needs-review" | "not-run";
  events: {
    kind: "payment" | "refund";
    amountMinor: number;
    currency: string;
  }[];
  replayEvents: number;
  providerRequests: 0;
  costMinor: 0;
}
export interface OfflineSummary {
  readonly label: "preset-candidate application conformance; not model quality";
  readonly cases: number;
  readonly clean: { readonly accepted: number; readonly denominator: number };
  readonly challenges: {
    readonly accepted: number;
    readonly reviewed: number;
    readonly parserBlocked: number;
    readonly denominator: number;
  };
  readonly falseCashCases: number;
  readonly missingCashCases: number;
  readonly incorrectFinancialCases: number;
  readonly refusals: number;
  readonly truncatedResponses: number;
  readonly providerRequests: 0;
  readonly costMinor: 0;
}
