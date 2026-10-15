# Exact domain kernel

Pure portable domain rules; no infrastructure, persistence, mailbox access or inference transport. `@invoxim/core` exports source TypeScript (`exports: ./src/index.ts`) for consumer bundlers; `typecheck` runs `tsc --noEmit` and no independent bundle is emitted. `src/index.ts` is a barrel of re-exports only; every rule lives in its own module.

## Money

`src/money.ts` owns `parseMoney`, `parseMinor`, `formatMinor` and `ENTRY_MINOR_BOUND`. `ENTRY_MINOR_BOUND` is the contracts `MINOR_BOUND` (9,000,000,000,000 minor units), not a separate literal. `parseMoney` turns a non-negative decimal magnitude string into minor units, enforcing the currency's minor digits (`EXCESS_MINOR_DIGITS`) and the bound (`AMOUNT_OUT_OF_RANGE`); a null amount stays null (unknown, not zero). `parseMinor` parses an unsigned minor-unit integer string, bounded by default. `formatMinor` produces exact signed decimal text without locale grouping. Currency precision comes from the contracts registry (`minorDigits`); unsupported codes throw `UNSUPPORTED_CURRENCY`.

`convertMinor` (`money-conversion.ts`) uses positive exact decimal rates (up to 13 integer and 18 fraction digits, the same shape as the contracts `fxRateDecimal`) and half-away-from-zero rounding per signed entry.

## Ledger totals

`ledgerTotals` takes already accepted payment/refund minor strings with an eligibility flag, skips ineligible entries, validates dates, currency and bounds, and returns integer strings (`paidMinor`, `refundedMinor`, `netMinor`). The optional period is half-open: `{ startDate, endExclusive }` includes the start day and excludes the `endExclusive` day; a reversed or empty period throws `INVALID_RANGE`. This differs deliberately from the inclusive `from`/`to` purchase-view filters in adapters; no production code converts one shape into the other. Mixed currencies throw `CURRENCY_MISMATCH`; valuation happens elsewhere with no rate-one fallback. These reductions do not deduplicate event identities: persistence must enforce idempotency before supplying accepted entries.

## Ingestion planning and payment state

`planLedgerIngestion` turns a persistable AI result plus a tenant-scoped snapshot into an insert-only plan of observations, purchases, cash events, reviews and payment-state updates. An invoice or order is not payment: only `explicitly-paid` evidence creates a payment event and only `completed` refund evidence creates a refund event. Cash events use payment/refund magnitudes, never the document total, and keep the printed calendar date. Unknown payment state and missing financial facts become reviews. A credit note, even one reporting a completed refund, raises `credit-note-completion` review and never creates a refund by itself. Store-credit and mixed-tender amounts that do not reconcile with the total raise `mixed-tender` review. The planner returns a plan only; persistence and idempotency belong to the adapters.

Payment state has one rule shared by ingestion, corrections and the lifecycle connection recompute:

- `settlementEvents` (`corrections/settlement.ts`) marks a cash entry as supported only if it is ledger-eligible (not excluded or merged), has cash proof (user-confirmed, or an accepted observation with matching paid/refund/manual evidence code) and is not blocked by an open financial review (`restorationEligibility`). Proven cash on an ineligible entry never raises payment state.
- `evaluateCorrectionSettlement` sums supported same-currency payments plus the largest compatible store-credit proof and calls `derivePaymentState` (`ledger/payment-state.ts`, internal, not re-exported from the barrel). Zero support yields `unknown`, or `unpaid` when the stored state was `unpaid` and there is no supported refund.
- In `planLedgerIngestion` a stored `paid` is not retained: with zero currently supported cash and credit it recomputes to `unknown` (OQ-A). Cash whose observation or document has an open financial review is excluded (OQ-B). Cash from a connection with a pending lifecycle deletion counts as unaccepted and does not support paid (OQ-C). Exceptions: a user override of `paymentState` is kept, and a current document that is a complete settlement proof yields `paid`.

`OverriddenField` is a typed union of the purchase fields a user can correct (`merchant`, `category`, `documentDate`, `totalMinor`, `currency`, `invoiceNumber`, `orderReference`, `paymentState`). Extraction never overwrites them; a `totalMinor` or `currency` override counts as a financial correction for settlement and conflict checks.

Review vocabularies are `as const` arrays checked with `satisfies` and their unions derived from them: `LEDGER_REVIEW_REASONS` (ledger), `CORRECTION_REVIEW_REASONS` (ledger reasons plus operational `document-review`, which per OD-2 does not block financial restoration), `REVIEW_ACTIONS`, `REVIEW_BLOCKING_SCOPES` and `REVIEW_STATUSES`. The contracts `PURCHASE_REVIEW_REASONS` list is pinned to `CORRECTION_REVIEW_REASONS` by a core test.

## AI validation

AI output is a candidate, never an authoritative fact. `ai/validation.ts` is a facade over split modules:

- `candidate.ts`: byte bound, JSON parse and schema check shared by both validators (`parseCandidate`), plus the mapping to the persistable provenance shape (`toPersistable`).
- `grounded.ts`: `validateExtraction` for text inputs; evidence quotes must appear in the identified input parts and dates, references, amounts and payment/refund semantics are checked against the text.
- `model.ts`: `validateModelExtraction` for model-interpreted originals; evidence must cite known input parts, without interpreting their language or markup.
- `persistable.ts`: `validatePersistableAiResult`, the storage boundary that rejects hidden transcript fields.

Both validators return `needs-review` when tax, payment, store credit, or payment plus credit exceeds the total, and when a document type in `NON_CASH_DOCUMENT_TYPES` (non-purchase, cancellation, statement, unknown, credit-note) claims cash evidence. Shared regexes are named in `ai/patterns.ts`.

## Documents

`createDocumentTextExtractor` (`documents/extractor.ts`) selects bodies and attachments under `DOCUMENT_LIMITS`. One internal `convertPdf` performs every PDF conversion call with the shared fallback: a missing or failing converter yields `needs_review`/`converter_unavailable` instead of throwing. MIME types are normalised once and body vs attachment role comes from one `partRole` rule.

## FX and recurring

`convertFxEntry` values one ledger entry against a supplied historical quote snapshot. A missing, mismatched, wrong-source, future-dated or older-than-`maxPriorAgeDays` quote (`fxRateAgeDays`) leaves the entry unconverted with an explicit reason; there is no rate-one fallback. `sumFxConversions` sums already-rounded valuations without double-counting repeated entry IDs. `monthlyAnchor` clamps a month-end anchor without losing its original day. `deriveRecurringSuggestion` produces annual estimates and price comparisons as suggestions only; they never create ledger events. Its eligibility check deliberately repeats the adapter SQL pre-filter so the pure function stays correct without it.

Supported currencies are the reviewed SIX subset EUR/USD/GBP/CHF (2 digits), JPY (0), KWD (3), published 2026-09-17, defined once in `@invoxim/contracts`. Other ISO currencies fail closed until independently reviewed. The reference and hash were recorded in the T03 currency-reference evidence file, which is no longer in the tree (removed in fe99887; see Git history). No live rates or provider connections are supplied.
