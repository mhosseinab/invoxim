import { copy } from "../copy";
export const privateCopy = {
  ...copy,
  home: "Your purchase records",
  purchases: "Purchases",
  connections: "Connected inboxes",
  loading: "Loading your records…",
  unavailable:
    "Your private workspace is unavailable right now. Try again or explore the example.",
  signedOut: "Sign in to continue to your private workspace.",
  loginUnavailable:
    "Sign-in is unavailable right now. You can still explore the example.",
  signIn: "Sign in",
  failed:
    "We could not load your records. Try again; no example data has been substituted.",
  invalidFilters:
    "Check your filters. The start date must be on or before the end date.",
  refresh: "Refresh records",
  search: "Search records",
  partial: "Older history may still be importing.",
  noRecords:
    "No purchase records are ready yet. Check your inbox coverage below.",
  noMatch: "No purchase records match these filters.",
  noMailbox:
    "No inbox is connected. Existing records remain available. Mailbox setup is not available on this screen yet.",
  noEvents:
    "No documented payment or completed refund is included in this range.",
  noLifecycle: "No payment has been confirmed for this purchase.",
  notConverted:
    "Currencies are shown separately. Currency conversion is not configured.",
  period: "Payment and completed-refund event dates in the selected range.",
  lifecycle: "Across this purchase history",
  sourceDeleted: "The source message was deleted.",
  sourceDisconnected: "This mailbox is disconnected.",
  sourceNotImplemented:
    "Opening originals is not available yet. No archived copy is provided on this screen.",
  pendingRefund: "Refund pending. Not deducted from recorded spending.",
} as const;
export const reviewQuestions: Record<string, string> = {
  "incomplete-financial-facts":
    "Which required financial details are missing from this evidence?",
  "payment-allocation-review":
    "Was an additional payment made for the remaining amount?",
  "unknown-payment": "Was this invoice paid?",
  "ambiguous-event": "Does this evidence describe a separate payment?",
  "invoice-conflict": "Which invoice version describes this purchase?",
  "event-conflict":
    "Which source describes the correct amount and date for this event?",
  "mixed-tender":
    "How much was paid with cash or a card, rather than store credit?",
  "refund-currency-mismatch": "Which currency was the refund completed in?",
  "refund-exceeds-payment": "Does this refund belong to this purchase?",
  missing_amount: "What amount does this document show?",
  missing_currency: "Which currency does this document use?",
  unknown_payment: "Was this invoice paid?",
  ambiguous_payment: "Does this evidence describe a separate payment?",
  conflicting_total: "Which document total is correct?",
};

export const missingQuestions = {
  merchant: "Which merchant issued this document?",
  currency: "Which currency does this document use?",
  total: "What total does this document show?",
  documentDate: "What date is shown on this document?",
} as const;
