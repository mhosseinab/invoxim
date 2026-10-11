# Product and UX contract

Version 1.1. `docs/13-presentation-and-onboarding.md` is the detailed contract for positioning, public example mode, onboarding, and first-use states. `docs/14-market-validation.md` separates competitor facts from hypotheses. No replacement brand has been selected.

## Navigation and presentation

Use five primary destinations: Home, Purchases, Recurring, Needs attention, and Settings. Keep internal review routes compatible; hide unimplemented features from active navigation. Lead with retrieval and purchase evidence, not charts. A compact desktop layout and a usable single-column mobile layout are enough. No separate design system package, marketing dashboard, or animated chart framework is necessary.

Use semantic HTML and native controls where practical. Money is right-aligned, currency is always clear, and negative net spending is valid. Color cannot be the only indication of a warning, refund, or payment status. Support keyboard navigation, visible focus, error association, reduced motion, and accessible chart/table alternatives. Target WCAG 2.2 AA, without claiming certification from an automated scan. [S32]

English UI first, with strings centralized for translation. Parsing must not assume English: include English and German receipts in the core evaluation set and French examples for decimal/date variation. Other scripts and unsupported layouts remain visible rather than silently discarded.

## Onboarding

Offer `/demo` before login: clearly labeled, read-only synthetic data; no mailbox/Drive/API/model calls or private-account cache access.

The normal path is Google sign-in (identity only), connect one mailbox, then one review-and-start card. Explain broad read-only permission before OAuth; callback records the selected account but does not scan mail. The review shows actual account, date range, currency/timezone, parser/inference destinations, allowance, retention, and hourly background behavior before an explicit idempotent Start import.

Default to 12 calendar months and process the recent 30-day portion first without dropping older history. Show ready purchases immediately while remaining history continues. Hosted processing is selected by default only if approved/configured; BYOK is optional advanced setup, not a required screen. A provider change requires appropriate renewed processing authorization.

Drive is optional and removed from the compulsory flow. Offer it after first value or through storage settings on explicit demand, with a clear warning that deleted unarchived originals cannot later be recovered. Additional inboxes can be connected any time without rerunning onboarding. No company profile, bank, credit card, analytics consent, or category setup gate.

Detailed states, copy, errors, range semantics, and API requirements: `docs/13-presentation-and-onboarding.md`. Declined authorization retains login; incomplete setup never enables unattended email reading.

## Home and spending overview

Home leads with search, import/coverage status, a real next action, and recent purchase records. Charts and the spending breakdown are secondary. Show source/evidence availability beside each purchase. Do not show zero spending as proof of no purchases when an import is incomplete or records are unpaid/uncertain.

Primary spending card: **Recorded spending**, with selected date range and reporting currency. Caption: “Based on connected receipts, not bank-verified.” Net equals included payment entries minus included completed-refund entries.

Supporting cards: payments; refunds; invoices with unpaid/unknown payment status; Needs Review count; records excluded from converted totals because FX is unavailable. Show import/sync incompleteness near totals, not only in a settings page.

Views: monthly series, category totals, top merchants. Every chart has an equivalent small table. Filters: date interval, category, merchant, original currency, source mailbox, payment state, review state, and optional manual Personal / Work / Unassigned tag (M1). Mailbox filters select evidence-linked purchases and still count each ledger entry once.

Default reporting dates use each ledger entry’s event date. When payment date is unavailable but a receipt establishes payment, use receipt date with a visible `document_date_fallback`; received date is the last fallback and triggers review. Historical backfills must not all appear as spending on import day.

## Purchases

Columns: date, merchant, category, documented paid/refunded/net amounts in original currency, payment state, evidence count, review indicator, and original/archive availability. Show document total separately, especially for installments or unpaid invoices. Do not label invoice total as spend. Optional Personal / Work / Unassigned tagging and filtering is M1. Default pagination is 50, maximum 100, with opaque cursor pagination and a deterministic tie-break ID.

Search merchant, invoice/order references, and user notes. Do not implement full-body email search. Normalize whitespace and case for matching, escape SQL wildcard characters, bound search input, and preserve the user’s original merchant label for display.

Detail begins with a readable lifecycle timeline and source-backed paid/refunded/net explanation. Period totals and lifecycle totals are explicitly labeled. Pending refunds do not reduce the net. Technical provenance is secondary under “Why this amount?”.

Detail view contains:
- Current fields, eligible ledger entries, refunds, and unresolved evidence.
- Source email provider/account, message date, attachment metadata, processing status, and original/archive availability.
- Why a value was accepted, which extractor/version produced it, and which fields the user corrected.
- Actions: edit, change category, mark payment/refund evidence manually, resolve duplicate, exclude, reprocess, archive available source, and open source/archive.

Do not open arbitrary URLs emitted by a model. Source links must be built/validated by the trusted provider adapter. For Gmail, avoid relying on fragile inbox-number URLs; use a verified account-aware link when available and otherwise provide a safe provider inbox/search route. Loss of source access does not delete the purchase.

A user edit has optimistic-concurrency versioning. If another tab or a job changed the same record, return a conflict and show the newer values. Offer “restore extracted value” per field. Reprocessing must not silently overwrite edits.

## Review

Review reasons are structured: missing/ambiguous amount or currency, unclear payment status, conflicting sources, possible duplicate, unreadable/password-protected/oversized file, unsupported format/capability, ambiguous date, missing FX, refund unmatched, provider failure, or source unavailable.

Separate **financial blockers** from **operational warnings**. A failed Drive upload is a warning and must not exclude a valid payment. Missing currency or a potential duplicate blocks adding the new candidate to trusted spending. Missing FX blocks only conversion, not original-currency reporting.

Show the exact decision needed, not a generic confidence percentage. Review actions have undo/reversal history. Do not demand that a user re-enter every field for a single missing value.

## Recurring

Separate “Suggested recurring” from “Confirmed subscriptions/recurring payments.” Users can confirm, dismiss, edit cadence, pause, and mark canceled. Suggestions may come from explicit subscription terms or repeated payment patterns; shopping regularly at one store is not sufficient proof of a subscription.

Show last evidenced payment, original currency, cadence, monthly equivalent, annual equivalent, and next expected date clearly labeled as an estimate unless an explicit future date is supported by source terms. Lead a charge-change card with the two comparable billed amounts and their source links. Never infer that a subscription is unused from its receipt. Forecasts never create spending entries.

A price-change flag compares the same service, original currency, billing interval, and comparable charge basis. Do not flag exchange-rate movement as a price increase. Discounts, tax changes, usage-based amounts, and plan changes require a reason/uncertainty label rather than a confident claim of an increased subscription price.

Missing invoices do not prove cancellation. One annual invoice can suggest annual recurrence only if the document explicitly says so; twelve months of import often cannot show two annual payments.

## Settings

Profile: timezone and reporting currency. Mailboxes: provider/address, connection state, imported interval, included folders/query mode, last attempted sync, last completed discovery, processing backlog, Sync Now, pause, disconnect, delete imported data option. Disconnect defaults to retaining extracted records.

Storage: Drive account, app-created folder, archive enabled/disabled, pending/failed count, retry, disconnect. Enabling later does not pretend previously deleted emails can be recovered; offer a bounded archive-backfill job for sources still available.

AI: hosted allowance and usage; BYOK provider/model; masked key presence; test-connection action using synthetic text; replace/delete key. Never display a saved key again. Show parsing destination separately from inference destination.

Data controls: export CSV/JSON; delete account with reauthentication and consequences; processor list and consent history. Existing Drive files remain in the user’s Drive on account deletion unless the user independently deletes them. Do not imply deleting the app deletes their entire cloud folder.

## Required empty/error states

Apply the copy/state matrix in `docs/13-presentation-and-onboarding.md` and `contracts/ux-copy.en.json`. Preserve first-record availability independently of full-history completion; completed setup and observed product activation are different states.

No mailbox; no receipts found; import pending; partial import; exhausted allowance; reauthorization needed; provider throttled; stale sync; no archived original; archive disconnected; source deleted; unsupported document; no rates for selected currency/date; stale edit conflict; offline browser; deleted account session. None should show fake demo spending in a real account.

## Out-of-scope boundaries

No balance, net-worth, bank reconciliation, tax deduction, legal invoice-validity, or complete-spending claims. No external links followed to download invoices from merchant portals in the MVP. An email containing only such a link is recorded as `external_invoice_link` and requires user action.


## Editing monetary details

Label the gross document total separately from paid/refunded event amounts, especially for installments and mixed tender. The edit form must ask which existing value is being corrected. Corrections preserve the event ID and override provenance; they do not create another charge. A EUR 100 purchase with EUR 50 paid so far displays both values without presenting EUR 100 as recorded spending.
