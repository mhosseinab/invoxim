# Data model, invariants, and reconciliation

This is a logical schema specification. Generate concrete Drizzle migrations only after T01 verifies the pinned auth/runtime combination. Prefer explicit columns for indexed/status/financial fields; use small versioned JSON only for validated provenance and connector-specific cursor state.

## Tables

| Table | Required fields and constraints |
|---|---|
| Auth-library tables | Generated from pinned Better Auth configuration; do not invent internal columns. App FKs map to its stable user ID. Encrypt any retained provider tokens. |
| `profiles` | `user_id` unique/FK; `status` active/deleting; reporting currency; IANA timezone; onboarding version/completed timestamp; optional pilot-measurement opt-in/version (default false); timestamps. Setup completion is not activation. |
| `connections` | ID, user, kind mailbox/storage, provider, provider subject, display address, state, generation, scopes, encrypted credentials with key version, next sync; unique `(user_id, kind, provider, provider_subject)`. |
| `sync_states` | ID, user, connection, scope/folder key, sync kind, run key (`live` for incremental), slice key (`recent`, `older`, or `live`), frozen interval, page token, history/delta cursor, last discovery timestamp, stage; unique `(user_id, connection_id, scope_key, sync_kind, run_key, slice_key)`. Parent import FK for backfill slices; independent live cursor. |
| `import_runs` | ID, user, connection, consent ID, connection generation, frozen start/cutoff/timezone, request fingerprint, stage, real counters, first usable record timestamp, started/completed timestamps, safe pause reason; unique start-request key scoped to user. No mailbox body or prompt. |
| `processing_consents` | ID, user, mailbox connection, disclosure version, inference/parser destination IDs, AI settings revision, accepted/revoked timestamps, background-sync authorization. Versioned public policy/processor references, not raw personal data. |
| `source_messages` | ID, user, connection, provider message ID, received timestamp, minimal sender domain/subject only when useful, candidate/processing status, generation; unique `(user_id, connection_id, provider_message_id)`. |
| `documents` | ID, user, source message, provider part/attachment key, content hash, MIME, byte length, received/doc date references, parse state; unique source-part key. No raw blob or full parsed text. |
| `observations` | ID, user, document, logical segment index, extraction fingerprint/version, normalized validated fields, evidence codes, review state; unique `(user_id, document_id, segment_index, extraction_fingerprint)`. No unfiltered model response. |
| `purchases` | ID, user, merchant raw/normalized, invoice/order refs, document date, total minor/currency when known, category, manual `use_tag` personal/work/unassigned (M1, default unassigned), payment state, fulfillment state, record status, version. |
| `purchase_evidence` | User, purchase, observation, relationship; unique evidence association, composite FKs. |
| `ledger_entries` | ID, user, purchase nullable, observation/source event ref, kind payment/refund, non-negative integer amount, currency, event date, date basis, eligibility, version; unique business event key per user. |
| `field_overrides` | User, entity type/ID, field, validated override value, revision, edited timestamp; preserve on reprocessing. |
| `review_items` | ID, user, related entity IDs, reason, blocking scope, status, decision metadata; dedupe active reason/entity combination. |
| `merchant_rules` | User, canonical merchant, category, explicit user rule, version; no global learning from private user corrections. |
| `recurring_series` | ID, user, merchant/service identity, currency, cadence, anchor, suggestion/confirmed/dismissed/paused/canceled state, last evidence, manual override/version. |
| `recurring_entries` | User, series, ledger entry; unique link so a payment is not counted twice within a series. |
| `archive_objects` | ID, user, document, storage connection, planned remote file ID, remote ID, state, hash/size, archived timestamp/error; unique `(user_id, document_id, storage_connection_id)`. |
| `fx_rates` | Shared public reference data only: source, from/to currencies, requested/effective dates, exact decimal rate string, retrieval time, version. No user financial information. |
| `entry_valuations` | User, ledger entry, reporting currency, converted minor, FX rate ID, calculation version; unique entry/currency/version. |
| `jobs` | ID, user, type, source/entity IDs, connection generation, unique dedupe key, status, dispatch/retry/lease/fence fields, outcome codes. |
| `usage_events` | User, job/attempt key, provider/model, input/output/other billed units where supplied, usage source, reserved/actual cost, state, timestamps; unique attempt key. No prompt content. |
| `usage_buckets` | User or global bucket key, period, allowance, reserved/spent units; atomic conditional reservations. |
| `ai_settings` | User, mode hosted/BYOK, approved provider ID/model, encrypted key/key version, settings revision, consent version. |
| `audit_events` | User, actor type, entity, action, timestamp, revision/reason codes; no raw documents or secrets. |
| `oauth_states` | Hashed one-time state, user/session/purpose binding, encrypted PKCE verifier as needed, nonce, fixed callback, expiry/consumed state. |

Auth-library sessions and anti-abuse/rate-limit storage are separate from mailbox credentials. Do not stuff multiple mailboxes into the login provider’s single account record.

All tenant-owned relationships use composite `(user_id, id)` referenced keys where supported, plus application authorization. Child tenant IDs cannot point to a different user’s parent. Index tenant/date, tenant/merchant, tenant/review state, source message uniqueness, due jobs, and active connection sync time. Add indexes based on actual query plans, not every possible combination.

## Money representation

All domain money arithmetic uses BigInt minor units or an exact decimal library. API amounts are canonical decimal integer strings, for example `"1299"`; currency is a validated ISO currency code. A missing amount is null, not zero. Currency exponent comes from a pinned, reviewed currency table; test 0-, 2-, and 3-decimal currencies.

D1 amounts use INTEGER with a proposed per-entry bound of 9,000,000,000,000 minor units. Convert to a JavaScript number for D1 binding only after checking `Number.isSafeInteger` and the business bound. Negative values are represented by the entry kind, not a double-negative combination. Invalid/huge amounts go to review.

Do not receive SQLite aggregate money as an imprecise JavaScript number. Return a CAST-to-text integer total with checked SQLite overflow handling, or reduce bounded chunks using BigInt. An overflow is a typed reporting error, never silent rounding. JSON must not serialize BigInt directly.

Discounts and taxes are components of the document total, not additional purchases. Do not automatically add tax to a displayed total that already includes it. Mixed-category baskets use one category in the MVP; no line-item ledger expansion.

## States

Purchase payment state: `unknown`, `unpaid`, `partially_paid`, `paid`. Fulfillment state: `unknown`, `ordered`, `fulfilled`, `canceled`. Refund progress is represented by separate evidence/ledger entries, not by deleting purchase history.

Document process state: `discovered`, `queued`, `processing`, `extracted`, `needs_review`, `unsupported`, `source_unavailable`, `failed`. Archive state is independent: `not_requested`, `pending`, `uploading`, `archived`, `failed`, `source_unavailable`, `disconnected`.

Job state: `ready`, `leased`, `retry_wait`, `paused_budget`, `paused_auth`, `completed`, `terminal`, `canceled`. Terminal does not mean successful; it means automatic retries stop.

Review blocking scope: `financial`, `conversion_only`, or `operational`. This avoids one generic boolean suppressing valid spending because a file upload failed.

## Payment/refund rules

A receipt explicitly showing paid/payment received can produce a payment entry if amount, currency, event identity, and date are accepted. An invoice alone cannot. An order confirmation must explicitly evidence a charged/paid amount before it counts. Bank settlement is never claimed.

“Refund requested/approved/pending” and a credit note are not a completed refund. Only explicit completed-refund evidence or a user’s manual confirmation adds a refund entry. Refunds are non-negative magnitudes with kind `refund`, counted on their own event date. Prior-period purchases can have current-period refunds, so a month can be net negative.

Support partial payments/refunds as distinct events. Do not automatically create a charge for an order-total plus installment invoices. Treat ambiguous allocation as review. Refund currency mismatches cannot be netted in original-currency totals; convert each independently when rates exist. Store-credit issuance stays outside cash-spending totals unless the user explicitly classifies it; it is not an automatic bank refund.

When a refund arrives before its purchase, create an unmatched refund review item. The user can confirm it as a standalone evidenced refund if the transaction is clear; later linking must not add a second refund. A refund exceeding known payments is a conflict, not an automatic clamp.

## Deduplication layers

1. Source identity: repeated delivery of a provider message/attachment is one source record.
2. Content identity: exact bytes hash within the same user can reuse extraction and link evidence. Multiple identical-looking documents with different evidence must not be blindly discarded.
3. Business identity: merchant legal identity plus explicit invoice/order/payment reference, currency, amount, and compatible document type identifies a candidate match.
4. Weak similarity: merchant/amount/date alone creates a possible-duplicate suggestion. It never auto-merges.

A purchase may have an order email, invoice PDF, payment receipt, and shipping email. Link them without adding a new ledger entry for each. An order number can contain multiple legitimate invoices or installments. A revised invoice with changed amount cannot overwrite the old value without reconciliation.

Keep explicit manual “different purchase” and “same purchase” decisions so rescanning does not reopen or undo them. User merges preserve evidence; unmerge must restore distinct event identity safely. Cross-inbox dedupe is allowed within a user only; matching documents belonging to different users remain fully isolated.

## Re-extraction and edits

Fingerprint = tenant-scoped document identity + parser/extractor/schema versions + provider/model configuration revision. Reprocessing creates a new validated observation/version, not duplicate ledger effects. Resolve into a candidate patch; apply only fields not manually overridden. Conflicting new evidence opens review.

Edit and merge actions use expected record versions. Updates increment versions atomically. Audit records contain field names/reason codes and allowed normalized values only, not copied email text. An unchanged re-extraction has zero financial effect.

## Dates, FX, and recurrence

Store source timestamps as UTC instants and invoice/payment dates as date-only values with basis/locale provenance. A date such as `03/04/2026` is ambiguous without a supported locale/context; do not guess. User timezone affects timestamp-derived reporting boundaries, not a date printed on an invoice.

Use the rate on the event date, or the latest preceding available reference date. Never use a future rate to fill a missing past date. Store both dates and the source. Frankfurter exposes dated reference-rate APIs; choose an explicit provider such as ECB for consistency rather than silently switching blended sources. [S28] Unsupported currencies and stale/missing data remain unconverted. Cached exact rates and calculation versions make reports reproducible.

Convert each ledger entry, round once to the reporting currency using half-away-from-zero on its signed value, and sum those rounded values. Do not convert a netted original-currency total using today’s rate. Changing reporting currency creates different valuations without mutating original entries.

Recurring suggestions use explicit terms, or at least three monthly/weekly payments with plausible intervals and stable service identity. Two annual payments may suggest yearly cadence; one needs explicit annual terms. Use calendar arithmetic with a preserved anchor day (end-of-month clamping), not fixed 30-day months. Forecast equivalents are estimates and never ledger entries.


## Document totals versus paid/refunded amounts

`total` is the gross document/order total. `paymentAmount` is the amount actually paid in the evidenced event, `refundAmount` is the evidenced refund amount, and `storeCreditAmount` is credit redeemed, if stated. These are separate nullable magnitude strings. Payment/refund completion is still controlled by the evidence enums. A pending refund can have a known amount without generating a refund entry. Never substitute `total` for an ambiguous installment or mixed-tender amount.

For a receipt clearly stating the full total was paid, paymentAmount can equal total when the evidence establishes that relationship. For EUR 100 total with EUR 70 paid by card and EUR 30 store credit redeemed, the cash-spending event is EUR 70, not EUR 100 plus EUR 30. Keep the gross purchase total for the detail view. An ambiguous split goes to financial review. For a EUR 100 order with one EUR 50 installment, record only the EUR 50 payment event. Model output must include input-grounded evidence for the chosen payment/refund magnitude.

## Presentation and onboarding projections (v1.1)

Connections need a scheduling state independent of authorization: `awaiting_import`, `active`, or `paused`. A verified token does not authorize a background import by itself. An OAuth callback stores credentials and verified identity without scheduling mailbox discovery. Every import/sync entry point checks current tenant/connection generation, granted scopes, active processing consent, and destination revision before making content requests.

The first explicit Start import creates/reuses a parent `import_runs` row, links accepted consent, and atomically activates the connection's authorized schedule. Backfill slices reference that run. Recent/older discovery, document extraction, and incremental sync still use existing durable `jobs`; no new workflow service is needed. Stage counters are projections from durable source/job states, not client-supplied values. No percentage claims from an unknown denominator.

Onboarding UI state is derived from the authenticated profile, selected connection, consent/readiness, and active import. Do not persist a conflicting wizard step as the source of truth. Persist only useful checkpoints/preferences and the explicit acceptance record. Refresh or a second device must reconstruct the same pending run. Store `onboarding_completed_at` once an authorized first import is accepted, even if no receipt is found later; product activation is a separate opt-in observation.

`use_tag` is one manual purchase-level classification, not an inferred business identity or accounting ledger. Whitelist it in edits, preserve it on extraction, and apply identical filtering in list/summary/exports. An unassigned record remains visible. A tag never alters payment eligibility, currency, or tax treatment.

Only if optional pilot measurement is enabled, add `pilot_events`: ID, user FK, allowlisted event type, server timestamp, random action token; unique `(user_id, event_type, action_token)`. Retain at most 30 days, cap event volume, and purge on opt-out/deletion. No entity ID, mailbox address, financial value, subject, search string, fingerprint, IP, or raw payload. The same tenant constraints apply; no cross-tenant reads from app APIs. Operational import timestamps are separate from optional product-usage analytics. Details: `docs/14-market-validation.md`.
