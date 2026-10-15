# Local lifecycle backend

`LIFECYCLE_ENABLED=true` enables authenticated, no-store structured export and lifecycle commands. Mutations require the exact configured origin, a server-verified session created within one hour, explicit confirmation, and the displayed version/generation. Command keys are scoped to tenant and route; a changed body conflicts. Their minimal results expire through bounded scheduled maintenance after seven days.

Export uses the same reader and filters as purchases/summary. The basic schema exports implemented purchases, exact string money, eligible/excluded cash events, source references, and allowlisted structured observation summaries. It distinguishes lifecycle from selected-period effects. No credentials, raw bodies, bytes, evidence quotes, model transcripts, absent recurring series or absent corrections are invented. Limits are 500 purchases, 2,000 events/evidence and 2 MiB; an oversized export fails and requires narrower filters. CSV separates event kind/date/basis from unsigned cash magnitude and neutralizes formula-leading text.

Disconnect atomically fences the connection generation, cancels live jobs (fence bump), stops sync, revokes processing consent and removes local ciphertext. Financial records remain. Source-data deletion requires a fresh preview fingerprint. It does the same fencing and sync cancellation and inserts a connection-scope `lifecycle_deletions` row in the same batch, then advances through the bounded cleanup stages below. A purchase supported by another mailbox remains. An event's backing observation transfers only to an identical content/segment/structured observation supporting the same purchase. Cash that loses its backing is made ineligible before erasure. The retained purchase is then recomputed, and a `payment-allocation-review` opens when its remaining support no longer balances. User-owned Drive files are untouched.

## Connection cleanup stages (`connection-cleanup.ts`)

Stage integers are fixed. Each unit runs one stage. A unit touches at most 100 rows and advances when it applies fewer than 100 (stage 2 advances only when it applies none). Every statement re-checks the deletion row's request/stage and that the connection is still `disconnected`. Before every stage except 9, `cleanupM1Leaves` first drains one leaf table (see below). While a leaf drain applies, the unit stays at its stage.

| Stage    | Effect                                                                                                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0        | Move ledger entries from a target observation to an identical alternate observation                                                                                                                                                                 |
| 1        | Mark purchases supported only by this connection for deletion (`lifecycle_delete_connection_id`)                                                                                                                                                    |
| 2        | Mark source purchases actively merged into a marked purchase                                                                                                                                                                                        |
| 3        | Retained purchases with target-backed cash or store-credit paid evidence: `payment_state='unknown'`, version bump, `lifecycle_recompute_connection_id`                                                                                              |
| 4        | Remove legacy open `source-deletion:<purchase>` `incomplete-financial-facts` reviews on marked purchases                                                                                                                                            |
| 5        | Make source entries backed by target observations ineligible                                                                                                                                                                                        |
| 6-8      | Erase `field_overrides`, `correction_audit`, `ledger_entries`                                                                                                                                                                                       |
| 9        | Recompute one retained purchase per unit (`connection-recompute.ts`)                                                                                                                                                                                |
| 10       | Detach surviving review items from erased purchases/observations                                                                                                                                                                                    |
| 11-22    | Erase `review_items`, `ledger_match_decisions`, `purchase_merges`, `manual_purchase_evidence`, `purchase_evidence`, `purchases`, `observations`, `ai_extractions`, `documents`, `discovery_source_jobs`, `discovery_run_sources`, `source_messages` |
| after 22 | Delete the `lifecycle_deletions` row and report completed                                                                                                                                                                                           |

## Connection recompute (`connection-recompute.ts`)

Stage 9 SQL only projects facts for one purchase marked `lifecycle_recompute_connection_id`:

- cash entries, with eligibility, origin, observation/document, evidence code and `accepted` (accepted observation and no pending connection deletion);
- the open financial reviews that can block that cash: purchase-scoped, linked through an entry's observation or, without observation, its document, excluding `payment-allocation-review`;
- credit proofs from `corrections/allocation.ts` `creditProofSql`;
- open `payment-allocation-review` items.

Cash support is decided in TypeScript by core `settlementEvents` and `evaluateCorrectionSettlement`, the same rule corrections and ingestion use. `allocationReviewStatus` (with source evidence removed) decides whether to open or resolve the allocation review. The reads are bounded and fail closed. More than 1,000 cash entries, 200 reviews or 200 credit proofs projects `unknown` instead of evaluating. The final write is version- and marker-guarded. If a resolving unit reads 100 open questions (its read limit), it resolves 99 and keeps the marker and `unknown` state for the next unit.

## Leaf tables (`m1-leaf-cleanup.ts`) and account stages (`cleanup.ts`)

`m1LeafTables` lists the newer leaf tables, children first:

- archive: `archive_upload_sessions`, `archive_backfill_items`, `archive_dispatch`, `archive_document_order`, `archive_backfill_runs`, `archive_objects`, `archive_folders`, `archive_settings`;
- recurring and valuations: `recurring_entries`, `recurring_series`, `entry_valuations`;
- Outlook: `outlook_inventory_states`, `outlook_folders`;
- storage: `storage_oauth_intents`, `storage_refresh_leases`.

A unit checks which of these tables exist in the schema and deletes at most 100 rows from the first one that has matching rows. A changed request or profile blocks the unit instead of falling through to parent erasure.

Under connection scope, archive rows are matched by mailbox or storage connection. `archive_settings` is disabled and detached rather than deleted. `recurring_series` is not erased. `entry_valuations`/`recurring_entries` are erased only from stage 6, for entries being erased.

`accountTables` lists the account stages in fixed order, ending with `account`. Leaf tables are drained from account stage 8 (`ledger_entries`) onward. The last unit deletes the auth `user` row.

`apps/worker/test/lifecycle-schema-completeness.test.ts` fails when a `user_id` table is covered by neither list (`profiles` and `lifecycle_deletions` are handled outside them), or when a listed leaf table is missing from the schema.

Account deletion marks the profile deleting and revokes sessions, jobs, schedules and credentials atomically with a durable local cleanup intent. A missing independent-journal binding fails before this barrier. A configured journal outage leaves access disabled and cleanup awaiting journal acknowledgment. Physical deletion starts only after independent acknowledgment and erases at most 100 selected leaf rows per scheduled unit, ending with the auth user/profile graph. Application D1 cleanup metadata is not the independent deletion journal.

`DELETION_JOURNAL` is an operator-reviewed service binding, with `DELETION_JOURNAL_SECRET` supplied through server secrets. The internal service protocol is POST to `/v1/deletions`, schemaVersion 1 and only pseudonymous user ID, deletion timestamp and opaque request ID; bearer authorization and request-key idempotency; 204 must mean independently durable acceptance. Calls have a five-second bound and refuse redirects. The application provisions no journal resource and cannot certify its independence, durability or restore behavior. The former test-only `restore.ts` restore-suppression helper and its test were deleted (OD-4, HYG-2), so the repository contains no restore procedure. Missing operator resource/contract and an isolated restore drill remain release gates.

`LIFECYCLE_GOOGLE_REVOCATION_ENABLED=true` plus a valid server credential keyring enables the fixed Google revocation adapter only when the confirmed request explicitly selects `revokeProviderAccess: true` (omitted means false). It decrypts at most ten owned Google credentials transiently, fences locally before sending, and reports best-effort success/failure separately. No token enters response, D1 cleanup metadata or journal. Google revocation can invalidate related grants across the provider project, including other mailboxes, storage and login; explicit opt-in is required. Captured credential generation/version is checked again after the local fence before sending. [Google token revocation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke) documents the endpoint and grant implications. Other providers are not silently substituted. Actual OAuth revocation is an operator smoke test, not established by synthetic transport fixtures.

The scheduler must invoke `createLifecycleCleanup(existingInvocationDatabase, journal).runOne()` with the same shared 40-query meter. No pending cleanup is fabricated as completed. The proposed 24-hour active-data erasure target requires a separately validated scheduler cadence, workload and recovery drill; the local tests do not prove that production target or physical erasure from provider backups.
