# Presentation and onboarding specification

Version 1.1. This is the implementation contract for public presentation, first use, progressive import, and the initial product experience. It refines the existing MVP, not a new marketing platform. Read with `docs/01-product-and-ux.md`, `docs/12-api-contracts.md`, and `contracts/ux-copy.en.json`.

## 1. Product message and initial audience

Working name: Inbox Ledger. The owner has not selected a replacement name. Keep `product.displayName` configurable; do not rename packages, publish domains, choose a trademark, or invent a logo as part of this revision.

Position the product as **purchase records across inboxes**, not comprehensive personal finance, bookkeeping, or an AI chat assistant. Initial audience hypothesis: digitally active individuals and solo freelancers with several inboxes, online purchases, and recurring services. Personal use remains supported; no business profile is required.

Approved headline: **Your purchase records, across inboxes.**

Approved supporting copy: **Find receipts, see what you paid and what was refunded, and keep your purchase history organized. No bank connection needed.**

Prioritize three jobs in this order:
1. Find a purchase and its supporting receipt.
2. Understand documented payments and refunds without counting every email as another charge.
3. See comparable recurring-charge changes, when the M1 feature is actually enabled.

AI is an implementation method. It is not the headline, onboarding task, or first navigation destination. Price and privacy are important constraints, not evidence that the product is unique. Competitive findings and hypotheses are in `docs/14-market-validation.md`.

## 2. Claims and release-aware presentation

One server-derived capability view controls marketing copy, onboarding actions, and in-app navigation. Feature flags cannot authorize an API operation by themselves: backend guards still enforce release mode, provider readiness, consent, and budgets.

| Statement | Rule |
|---|---|
| Multiple inboxes | Allowed once multiple Gmail connections actually work; name the enabled providers, not all planned ones. |
| Outlook support | Show as available only after T17 plus relevant release tests pass and operator credentials are configured. |
| Keep originals in your Google Drive | Active feature only after T18 is enabled. Before then, roadmap wording may say it is planned, never that archiving happened. |
| Recurring-charge changes | Advertise as available only after T20/T21 pass. A labeled example is not proof of live functionality. |
| Free beta | Only with the real allowance and paused-at-limit behavior visible. Do not promise unlimited use, permanent free service, or future prices. |
| No card required | Allowed while no card or checkout is required. Do not add payment details just to improve a conversion funnel. |
| Read-only mailbox access | Explain the permission accurately. Gmail's read-only permission covers the mailbox, not a receipts-only subset. App filtering limits actual processing. [S01] |
| No advertising use or sale of email data | A required product practice to verify, not an accusation about competitors. Do not publish unsupported processor promises. [S45] |
| Local-only / zero-knowledge / only you can read it | Prohibited for the agreed hosted architecture. |
| Every expense / all receipts / bank verified / guaranteed savings | Prohibited. |
| Exact setup or extraction speed | Do not publish before measurement. The five-minute target is an internal experiment, not an SLA. |

Before public availability, provide an accurate homepage, operator/contact information, terms, privacy, and processing destinations on the operator's verified domain. Do not fabricate legal entity details or a compliance badge. Google documents homepage and in-context authorization requirements. [S44]

## 3. Landing page

Build one lightweight responsive page, not a CMS. Block order:

1. Header: working wordmark, How it works, Privacy, and Sign in. No giant integrations grid.
2. Hero: approved headline and supporting copy; primary CTA depends on release access; secondary **Try an example**.
3. Realistic product example: one synthetic purchase with paid/refunded/net values and linked source documents. Persistent **Example data** label.
4. Three short outcome blocks: find receipts; understand payments/refunds; review recurring changes if enabled.
5. Three-step explanation: sign in; connect a mailbox; review purchase records while older history imports.
6. Trust explanation: what access is granted, what is processed/stored, and how to disconnect/export/delete. Link to full processing details.
7. Short FAQ: supported providers, incomplete spending coverage, originals, AI processing, allowance, and deletion.
8. Footer: actual operator/contact, privacy, terms, and capability/version information where useful.

Primary CTA in allowlist mode: **Sign in to the beta**. Unapproved identities get an explanation and access to the example, not a working mailbox connection or a fake waiting-list success. No waiting-list collection service is added. In approved public mode use the Google sign-in control and an honest start label consistent with provider branding.

No invented customers, testimonials, user counts, savings, security certificates, comparison superiority, live transaction counters, or “trusted by” logos. Provider marks indicate a supported integration only and must follow its branding requirements before publishing. No third-party tracking pixels, session replay, promotional animations, or confetti.

## 4. Example mode: see the product before authorizing email

Route `/demo` is publicly readable static synthetic data with an always-visible **Example data. Nothing from your inbox.** banner. It requires no login, mailbox, Drive, model call, or database write. Use the same presentational purchase components and validated display DTOs as production, supplied through an explicit read-only fixture adapter.

The fixture includes an order/invoice/payment/refund chain for a EUR 120 purchase, a documented EUR 30 refund, an unpaid EUR 80 invoice, and two distinct same-price purchases. The first record's lifecycle net is EUR 90. All totals are deterministic and independently checked. See `test-design/fixtures/presentation-demo.json`.

Opening synthetic evidence shows local text explicitly labeled synthetic. It must never open a real user's inbox or Drive link. Search/filter work on the small static dataset. Editing, real sync, account settings, or connecting storage are disabled/explained; choosing to connect leads to normal authenticated onboarding.

Do not persist demo purchases in an account, include them in reports, or count example usage as activation. No authenticated API prefetch is allowed from `/demo`, even for an already signed-in visitor. Keep separate route/query-cache keys and clear private query data on logout/account change; do not import production `testkit` into the web bundle. Copy reviewed public fixture values into a small production demo module with a parity test.

## 5. First-use flow

Use three app-owned phases: **Sign in → Connect → Review and start**. External provider screens may add interactions; do not advertise a fixed click count. Show the user's current account/connection and a way back. Each phase persists or reconstructs safely on refresh.

### Phase A: sign in

Google identity scopes only. Copy: **Signing in creates your private workspace. It does not connect your inbox.**

Do not ask for company name, tax details, income, bank access, credit card, a category setup exercise, an AI API key, or marketing preferences. A profile survey is not a prerequisite to a receipt list. Returning users go to their existing home, not through a new wizard.

### Phase B: connect one mailbox

Lead with a short explanation before opening provider authorization:

**Connect the inbox where you receive receipts.**

**We ask for read-only access to this mailbox so we can look for purchase-related messages. This permission is broader than receipts alone. The app limits processing to purchase-related messages and cannot send or delete email with this connection.**

Provider-specific copy must match the actual granted scopes. Account selection should make it clear that the mailbox may differ from the Google login account. Use a top-level provider redirect; do not build an embedded consent browser. [S44]

Connect one mailbox first. An unobtrusive **Add another inbox** remains available, including during import, but connecting several is not an onboarding prerequisite. Keep the configured limit visible when reached.

OAuth callback verifies identity/scopes and stores the connection in `awaiting_import` scheduling state. It **does not enumerate messages, fetch email bodies, invoke the parser/model, or start recurring synchronization**. Provider identity/token validation is allowed. Next, show the actual selected address and the import review.

A canceled/denied mailbox flow returns to Connect with the app login intact. Do not repeatedly reopen authorization, treat refusal as a login failure, or claim a successful connection when read permission was not granted. A wrong account can be removed/switched before import without processing any messages. Reconnecting an existing mailbox does not make a duplicate connection or restart history automatically.

### Phase C: review and start

One compact review card, not four more setup screens:

| Always visible | Default / behavior |
|---|---|
| Mailbox | Verified selected address and provider, with Change action. |
| Import range | Last 12 calendar months, displayed as actual dates; **Change** opens start-date controls. |
| First results | Recent 30 days processed first, then the rest of the selected range. This is ordering, not a 30-day import limit. |
| Currency and timezone | EUR and browser IANA timezone; readable summary with inline Change. Unsupported detection uses configured fallback visibly. |
| Processing destination | Actual selected inference provider/model and any document-conversion provider, with retention/data-use details. Not a generic “our AI” label. |
| Hosted allowance | Remaining document allowance/reset information when known, plus “History imports use this allowance. Processing pauses at the limit.” Global-cap limits are explained without exposing operational secrets. |
| Originals | **Originals stay in your email unless you enable a Drive archive.** Do not imply a durable copy exists. |
| Background work | New receipts checked hourly after start, even when the browser is closed; pause/disconnect controls remain available. |

Hosted AI is the default only when approved, configured, and available. **Use your own AI key** is an optional collapsed advanced control, not a required onboarding step. Its destination and any operator-funded parser must still be disclosed. If hosted processing is unavailable, show why and offer only configured BYOK options or example mode; no hidden fallback or forced signup to an AI vendor.

Primary action: **Start import**. Adjacent copy explicitly states that the action authorizes the shown processing and hourly checks. Record the accepted disclosure version, destinations, mailbox, interval, and settings revision server-side. Keep this functional authorization separate from any optional pilot measurement consent. No prechecked advertising/analytics box.

Start is idempotent. The server atomically validates scope, selected account, consent version, processing readiness, range, and generation; creates or reuses an import run; enables the approved schedule; then returns its ID. Double-clicks, callback replay, stale tabs, and refresh must not start duplicate imports. Changed destinations/disclosures before Start produce a refreshed review, not silent acceptance.

Drive is **not a wizard step**. A collapsed explanation may link to storage settings for people who deliberately want archiving before import, but the normal path defers that decision. The detailed Drive offer appears after the user has seen a real purchase or asks for an unavailable original.

## 6. Progressive import and honest progress

For each selected mailbox, create one parent import run with frozen interval `[start, cutoff)` and two non-overlapping slices. Recent slice: `[max(start, cutoff minus 30 calendar days), cutoff)`. Older slice: `[start, recent.start)`; omit if empty. Range calculations use the confirmed timezone and calendar rules. A date-only inclusive end selected by a user becomes next-day exclusive. Provider search rounding is handled by the adapter and must not silently drop boundary messages.

Scan recent slices before old-history slices. Within a provider page, prioritize candidate extraction promptly; do not wait for complete historical discovery. A page result's order is not assumed to be chronological. If needed, use bounded date slices to achieve recent-first ordering. Existing per-tenant fairness and live incremental synchronization remain in effect; a new user's first result does not justify starving other users.

The source identity and reconciliation pipeline are shared across both slices and incremental discovery. Parent completion requires both slices and their queued processing to reach documented terminal outcomes. “Scan finished with 3 items needing attention” is different from “all receipts imported.” A rejected candidate is not a lost receipt.

Show stages and truthful counts:
- Looking for recent purchase emails.
- Reading likely receipts.
- N purchase records ready; M items need attention.
- Continuing through older emails in the chosen range.

Counts refer to distinct concepts: candidate messages, processed documents, purchase records, payment events, review items. Never use them interchangeably. Do not show a percentage while the denominator is unknown. A slice may have a known processed/queued fraction, but it is labeled as that slice, not the entire mailbox. Do not fabricate an ETA.

As soon as a validated purchase is ready, make **View purchase records** available. Opening the dashboard does not cancel import. An unpaid invoice is a useful record but contributes no documented payment. Record-readiness and payment-readiness are separate facts.

If the user stays on the progress page, keep it stable with a clear action; do not interrupt reading with an automatic redirect. Opening a ready record supplies the first meaningful product task. No compulsory tutorial overlay or step-completion celebration.

A five-minute time-to-first-useful-result is an internal target on a labeled representative workload, not a release guarantee. Measure both backend availability and user-viewed evidence separately. Preserve failed/paused/no-match outcomes in the denominator; do not report only fast successes.

## 7. First home and ongoing presentation

Default app navigation: **Home, Purchases, Recurring, Needs attention, Settings**. In M0 hide unimplemented Recurring from active navigation or label it in a separate roadmap area; never show empty fake results. Retain `/overview` as a redirect if an existing build uses it.

Home order:
1. Search: **Find a receipt or purchase**.
2. Coverage/status strip: connected mailbox count; which range is still importing; paused/reconnect warnings; view details.
3. Most useful next action, only when real: open the latest purchase, review one blocking item, or inspect a comparable recurring-charge change.
4. Recent purchases with **Paid**, **Refunded**, **Net recorded**, currency, and evidence availability. Unpaid invoices visibly say **Not counted as spending**.
5. A compact **Recorded spending** summary with date/currency/coverage caption.
6. Category/monthly/merchant charts below the purchase list or inside the Spending section, not as a gate before seeing records.

The purchase detail leads with the buyer's explanation, not extraction internals. Show merchant/date, document total where relevant, documented payments/refunds and lifecycle net, then a chronology of supporting source events. Label lifetime purchase figures separately from period-based Home totals. A current-month refund for an old purchase belongs to this month's ledger summary without moving its old payment.

A simple timeline contains supported events only: order received; invoice issued; payment documented; refund requested/approved; refund documented. Pending-refund evidence changes the timeline, never the net. Each monetary event links to the actual source or a clear unavailable state. Technical provenance can live behind **Why this amount?**; no stored full document text is added to enable the timeline.

Do not present distinct same-day/same-price purchases as “duplicates removed” without strong evidence. User-confirmed edits and exclusions are labeled and reversible. Source count is not purchase count. Review should ask one specific question, such as “Was this invoice paid?”, without making the user re-enter valid fields.

Refund follow-up is an evidence status, not a promise to recover money, a merchant chase service, or a timer that invents a refund deadline. No automated cancellation or refund requests are added.

## 8. Deferred setup, without losing access

After the first real purchase is opened, show at most one dismissible **Save originals to your Google Drive** card when archiving is actually available and still disabled. Offer **Connect Drive** and **Not now** equally clearly. Describe that only still-available source documents can be archived later. For M0, explain the absence of a saved copy without advertising a working Drive button.

Connect Drive independently, show its account/folder, and use the narrow app-created/file-specific access. Explain that this does not grant access to the user's entire Drive. The app can manage files it created or that were explicitly shared with it; do not claim Google enforces a folder-only boundary. [S04]

Disconnection leaves existing Drive files and extracted records unless the user separately deletes them. App account deletion leaves user-owned Drive files by default. Clearly separate “Stop syncing this mailbox”, “Delete imported records”, and “Delete my app account”.

Additional inboxes remain a first-class control on Home and in Settings, not an upsell. AI advanced settings remain available without repeated prompts. Optional Personal / Work / Unassigned tags are M1 additions: one tag per purchase, manual assignment only initially, no tax or bookkeeping claims, no business setup, and corrections survive reprocessing.

## 9. Recovery states and copy behavior

| State | What the user sees / can do |
|---|---|
| Logged in, no mailbox | Connect a mailbox or view the example; no fabricated zero-spend result. |
| Mailbox connected, not started | Review account/range/destination and Start import; no background reads yet. |
| Recent search found nothing, history pending | No recent purchase records found yet; older search continues. Not “you spent nothing.” |
| Full requested scan found no matching records | No matching purchase records found in this range; show coverage, adjust dates, add inbox, or explicitly broaden search. |
| Only unpaid or uncertain records | Show usable records and the reason no payments count; not an empty success dashboard. |
| Budget exhausted | Existing records stay available. Explain pause/reset when known and configured BYOK option; no fake Upgrade checkout. |
| Parser or hosted AI not configured | State unavailable processing, keep example/existing records accessible, block real extraction. |
| Authorization canceled | Keep app session; retry only on explicit user action. |
| Wrong Google/Microsoft account | Show actual account and Change action; no scan of the wrong account before Start. |
| Reauthorization needed | Keep records; explain that new sync paused; reconnect the same account without duplicate import. |
| Browser closed/refreshed/back button | Resume from server state; no duplicate run or loss of consent evidence. |
| Delayed/throttled work | Real stage, last progress time, backoff reason when safe; no fake percentage or promises. |
| Missing/deleted source, no archive | Extracted record remains; **Original unavailable** and precise reason, not a broken download button. |
| Drive declined/full/disconnected | Extraction and financial results continue; archive warning is separate. |
| Disclosure or processor changed | Pause affected extraction; review updated destination/terms; never reuse stale authorization for a new recipient. |
| Session expired/account deleting | Reauthenticate or sign out; clear cached private data. Never replay delayed writes into a deleted account. |

All user-facing strings come from central keys. See `contracts/ux-copy.en.json`; exact dynamic values must be supplied from trusted display DTOs, never an LLM response. Technical exception text is not copy.

## 10. Visual, mobile, and accessibility contract

Use a restrained, readable interface: light neutral surface, dark text, a single action accent selected after contrast checks, and clear spacing. No financial trading-terminal appearance, gradients as a substitute for hierarchy, cartoon banking imagery, or chart-only homepage. This is a proposed visual treatment, not a finalized brand.

Desktop: single centered onboarding column around 560 CSS px; product content with a practical maximum width; table for records. Mobile at 360 CSS px: single-column onboarding; card rows instead of horizontally scrolling critical fields; full readable currency/amount; primary action within normal document flow. Essential privacy/destination text must not disappear below an inaccessible overlay or an offscreen fixed footer.

Type hierarchy: legible body around 16 CSS px, short headings, tabular numerals for money; descriptive labels instead of icons alone. Test zoom/reflow at 200% and the equivalent narrow viewport, keyboard order, visible focus, accessible names, high-contrast/forced-colors behavior, and reduced motion. Target WCAG 2.2 AA. [S32]

Focus follows user actions, not each polling update. Announce milestone/status changes with a polite live region, not every processed message. After OAuth return, put focus on the connection result heading. Show inline errors with linked field labels. Receipt statuses must use text in addition to color. Every chart has an equivalent table. Keep private data out of E2E videos/screenshots; use synthetic fixtures.

## 11. Implementation boundaries and evidence

T27 owns the claim/capability/copy contract. T28 implements landing and read-only example mode. T09 handles recent-first import semantics. T13 builds purchase-first Home/detail. T29 integrates the resumable onboarding and consent start. T18/T20/T21 complete delayed Drive, recurring changes, and simple tags. T30 supplies privacy-limited pilot measurement and the benchmark worksheet.

Use the existing router, schema library, job engine, and component primitives. No onboarding SaaS, analytics SDK, feature-flag service, survey engine, or new microservice. New database fields/routes are specified in the data/API documents. One typed reducer or pure projection of server state is enough; a general workflow framework is not.

Require browser evidence for the example-to-connection path, login A/mailbox B/storage C, refusal/retry, refresh, two-tab Start, partial import, no results, quota pause, source loss, and mobile/keyboard operation. Validate visible copy against actual capabilities and real DTOs. New case IDs are mapped in the backlog. This document does not claim those application tests have run.
