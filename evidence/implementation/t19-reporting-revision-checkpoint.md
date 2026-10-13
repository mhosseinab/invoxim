# T19 reporting revision foundation checkpoint

Task: T19 / FX-01–05 reporting integration prerequisite. Implementer: `/root/fx_reporting_revision`. Status: native compatibility GREEN; ready for independent coverage review/checkpoint. Full-period reporting remains incomplete. Initial assigned files: additive `packages/adapters/migrations/0005_reporting_revision.sql`, `apps/worker/test/fx-reporting-revision.test.ts`, this report. Root then explicitly expanded ownership after native compatibility RED and independent impact audit to five necessary writer files: `packages/adapters/src/fx/repository.ts`, `packages/adapters/src/purchases.ts`, `packages/adapters/src/security/vault.ts`, `packages/adapters/src/lifecycle/cleanup.ts`, `packages/adapters/src/lifecycle/connection-cleanup.ts`. Other writers' changes preserved. No commit created by this agent; orchestrator owns checkpoint integration.

## Implemented behavior and scope

One checked `profiles.reporting_revision INTEGER NOT NULL DEFAULT 1`, maximum 9007199254740991, read as `CAST(... AS TEXT)` canonical decimal. Existing populated profiles/new profiles start at 1. Reporting mutations do not advance the separate preference `profiles.version`. Null-safe UPDATE predicates avoid revisions on replayed unchanged values; INSERT/DELETE advance membership revisions. Ownership moves advance OLD and NEW tenant rows atomically; missing parent during deletion cascades has no authorized report and is tolerated. Explicit maximum RAISE(ABORT) prevents outer conflict-ignore from accepting a financial mutation without revision advancement. A monotonic guard rejects resetting an existing stamp backward.

Necessary deviation from ordinary guarded application writes: correction, pipeline, lifecycle and valuation writers are distributed and eligibility can change without entry version. Explicit database triggers cover their report inputs in the same atomic transaction, without inserting revision hooks into those financial writers or introducing tables/infrastructure. Native trigger metadata amplification required the narrowly authorized success-oracle repairs described below. No generic runtime trigger framework.

Projection dependency list, derived from current purchase views/export and FX repository:

- ledger_entries: id, user_id, purchase_id, observation_id, kind, amount_minor, currency, event_date, date_basis, eligible, origin, version.
- entry_valuations: user_id, entry_id, reporting_currency, profile_version, entry_version, calculation_version, policy_hash, policy_source, max_prior_age_days, original_kind, original_minor, original_currency, original_event_date, status, signed_minor, basis, reason, rate_id, version. Operational updated_at excluded.
- purchases: id, user_id, merchant_raw, invoice_ref, order_ref, document_date, total_minor, currency, category, payment_state, record_status, version, origin, lifecycle_delete_connection_id, lifecycle_recompute_connection_id.
- purchase_evidence: user_id, purchase_id, observation_id, relationship. manual_purchase_evidence: user_id, purchase_id, document_id.
- review_items: id, user_id, document_id, observation_id, purchase_id, reason, blocking_scope, status, created_at, version, missing_fields_json.
- observations: id, user_id, document_id, evidence_code, review_state, normalized_fields, structured_fields.
- documents: id, user_id, source_message_id, content_hash.
- source_messages: id, user_id, connection_id, provider_message_id, available.
- connections: id, user_id, provider, state. Ciphertext, sync cursors, lease/scheduling changes excluded.
- field_overrides: all current columns, including exported original/value JSON and revision.
- profiles: user_id, status, version, reporting_currency, timezone; revision-only increments cannot recursively invoke this focused trigger.

Public fx_rates UPDATE of existing snapshot content is rejected; current ordinary writes insert snapshots or replay existing rows. Referenced deletions remain FK restricted. Inserting public snapshots alone does not mutate an existing report. Future report fields/filters require explicit dependency updates; this does not certify future use-tag or additional export fields.

## Evidence

RED broker command: `pnpm --filter @invoxim/worker test:integration test/fx-reporting-revision.test.ts`. Root recorded actual exit 1 in `/tmp/invoxim-fx-revision-red-v1.txt`, read by implementer. Four tests: populated-upgrade passed; correction, eligibility without version, insert/delete failed because business stamp stayed `1`. Migration at RED had checked column only, no triggers; failure was missing invalidation, not missing API/import. Runtime duration 832 ms.

Executed locally, exit 0: `pnpm exec prettier --write apps/worker/test/fx-reporting-revision.test.ts`.

Executed locally, exit 0: Python sqlite3 in-memory clean 0001–0005 migration application and `PRAGMA table_info` validation of every explicit trigger UPDATE OF column. Result: 36 triggers, no unknown columns. This verifies SQLite syntax/schema only, not workerd/D1 semantics. No output data beyond synthetic schema/trigger counts retained.

First native GREEN attempt: same command, root broker exit 1; 28 passed / 5 failed / 33 total, 1.82 s, `/tmp/invoxim-fx-revision-green-v1.txt` read by implementer. Shared beforeAll fixture contamination caused ownership/deletion/max-state leakage; failed writes touched no original row, and maximum state poisoned subsequent checks. Tests repaired with unique fresh tenants in beforeEach while preserving a separate populated-upgrade fixture. No trigger or writer changes were made to disguise those failures. Native re-run v2: same command, broker exit 1, 31 passed / 2 failed / 33 total, 2.05 s, `/tmp/invoxim-fx-revision-green-v2.txt` read by implementer. With fresh tenants, SQL changes() correctly returned 1 while D1 meta.changes returned 2 (one purchase plus revision write). The original FX put meta.changes===1 success oracle falsely reported stale despite persisted valuation. This is a real compatibility RED, not a trigger syntax or fixture issue. Root performed inventory and obtained independent impact audit, then explicitly authorized the five scoped writer-success-oracle repairs to this implementer. Metadata test expectation corrected to exact amplification 2 with SQL financial rows still exactly 1; stored/conflict/stale FX business assertions preserved. Expanded compatibility RED: same command, root broker exit 1, 32 passed / 6 failed / 38 total, 2.15 s; `/tmp/invoxim-fx-mutation-oracles-red-v1.txt` read by implementer. Beyond FX, successful purchase edit/delete and vault disconnect falsely returned false; account/connection cleanup each mutated 50 direct rows yet failed to advance because metadata counted 100 changes. SQL changes()=1 / meta.changes=2 oracle passed. Only after these business failures, the five authorized source repairs appended RETURNING 1 AS applied, preserved every existing guard/binding, and consumed first()/all()/batch results to count direct changes. Single writes use non-null row presence; FX final batch requires exactly one returned row and retains its no-row conflict/stale fallback; bounded cleanup uses direct returned count <100, with stage2 zero-count logic unchanged. No additional queries. Native GREEN/regression now passed: root broker `/tmp/invoxim-fx-revision-compat-green-v1.txt`, exit 0, all 161 tests / 11 files, 27.15 s; implementer read log. Includes all 38 dedicated revision/writer-oracle tests with migration 0005 installed and FX repository/service/routes, database/adversarial, vault, legacy lifecycle and M1 regressions. Existing regression files retain baseline/historical fixtures; do not claim all real pipeline/correction writer paths ran under triggers. Dedicated test proves the pipeline adjacent SQL changes() witness, not a full pipeline commit under migration 0005. Tests request populated upgrade/new users, original-fact preservation, same-timestamp projection/filter mutations, tenant isolation/ownership movement, cross-tenant FK denial, no-op/stale financial CAS, atomic batch rollback, maximum fail-closed conflict-ignore, deletion cascades, pipeline adjacent changes(), FX put metadata success oracle and exact bounded invocation statements. Metadata oracle passed: submitted statements exactly 2, SQL direct changes exactly 1, D1 meta.changes exactly 2, rows_written at least 2. Synthetic console metadata did not appear in broker logs; exact rows_read/rows_written are not recorded. No zero-internal-cost claim.

Scoped ESLint, formatting, and diff checks passed (commands below). Root executed native regressions. Typecheck/build/full verify not run by this implementer. Independent migration coverage review: requested from root before checkpoint, not yet certified. Live providers/deployment: not performed.

## Effects and next work

Each affected report row adds one profile revision write (two profiles for permitted ownership moves). No new index is needed for those updates: profile primary key lookup bounds them. Native metadata oracle proves meta.changes amplification 2 and rows_written at least 2 for one affected purchase row; exact row-read/write values were not captured. SQL changes() excludes the revision write; native D1 meta.changes includes it. The affected writer metadata success oracles have now been repaired within explicit expanded ownership, native GREEN passed; independent adoption review remains pending. The 40-statement wrapper counts submitted statements, not SQLite trigger internals; do not interpret its count as zero internal cost.

No new processor, permission, raw content retention, infrastructure, paid service or credentials. Fixture data is synthetic. T19 whole-period aggregation, signed cursors, list/summary/export equality, UI and queued preference revaluation remain parent-owned requirements. This migration foundation alone cannot mark T19 complete.

Context7 was absent from exposed ALL_TOOLS. Official SQLite trigger and changes documentation checked as fallback: https://www.sqlite.org/lang_createtrigger.html and https://www.sqlite.org/c3ref/changes.html. Native pinned D1 execution remains the decisive proof of changes()/meta.changes behavior.

Local scoped verification after oracle repairs, exit 0: `pnpm exec prettier --write packages/adapters/src/fx/repository.ts packages/adapters/src/purchases.ts packages/adapters/src/security/vault.ts packages/adapters/src/lifecycle/cleanup.ts packages/adapters/src/lifecycle/connection-cleanup.ts`; `git diff --check -- packages/adapters/src/fx/repository.ts packages/adapters/src/purchases.ts packages/adapters/src/security/vault.ts packages/adapters/src/lifecycle/cleanup.ts packages/adapters/src/lifecycle/connection-cleanup.ts apps/worker/test/fx-reporting-revision.test.ts`.

Current primary documentation fallback also checked https://www.sqlite.org/lang_returning.html (direct mutations only, excludes triggers/cascades) and https://developers.cloudflare.com/d1/worker-api/prepared-statements/ (first/all retrieval). Pinned native GREEN remains decisive; no dependence on run() returning rows.

Final scoped checks, all exit 0: `pnpm exec eslint packages/adapters/src/fx/repository.ts packages/adapters/src/purchases.ts packages/adapters/src/security/vault.ts packages/adapters/src/lifecycle/cleanup.ts packages/adapters/src/lifecycle/connection-cleanup.ts apps/worker/test/fx-reporting-revision.test.ts`; `pnpm exec prettier --check` with the identical six-file list; `git diff --check --` with that identical list. No independent review performed by implementer.

Frozen SHA-256 identities:

| File | SHA-256 |
| --- | --- |
| packages/adapters/migrations/0005_reporting_revision.sql | c5f6d1b2995e23a41a6d62b9c523ecaade7ce6319d72a784ab7ad1137cf15eb1 |
| apps/worker/test/fx-reporting-revision.test.ts | 3978397b8ea23ca83a57c18aeecb7f15915bd6fd88cf8798169c50f5f5ececa7 |
| packages/adapters/src/fx/repository.ts | 3f031d4f39d568e90ea0226ac3b9804ff9ed0be0611f12e33d8da7dd9ef00dea |
| packages/adapters/src/purchases.ts | ccf69844696167d20c2d1f35ef6e7bea6a163292b535f8484d3788e3c1c97fdd |
| packages/adapters/src/security/vault.ts | 089d48e24fe08675c750d68f5e0114fb4c5df49c7987dfd5f392dc22e7f41c55 |
| packages/adapters/src/lifecycle/cleanup.ts | c39c611f4bf73ab695782933bfedd827f09393d5cc984e9f990e760c0bf6721a |
| packages/adapters/src/lifecycle/connection-cleanup.ts | 6b127c35475ba0fc968612137358113ebd28ba311231227e768b3cc6ab4a53dc |

Exact native GREEN command, supplied by executing root broker; exit 0, 161 passed / 11 files, zero skips, 27.15 s:

```sh
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/invoxim-fx-revision-compat-green.log pnpm --filter @invoxim/worker exec vitest run test/fx-reporting-revision.test.ts test/fx-repository.test.ts test/fx-service.test.ts test/fx-routes.test.ts test/database.test.ts test/database-adversarial.test.ts test/vault.test.ts test/vault-adversarial.test.ts test/lifecycle.test.ts test/lifecycle-adversarial.test.ts test/m1-lifecycle.test.ts > /tmp/invoxim-fx-revision-compat-green-v1.txt 2>&1
```

## Final integration evidence, 13 October 2026

Independent source reviewer trigger_metadata_audit approved the bounded revision foundation and direct-mutation result repair, preserving tenant/CAS/generation predicates and submitted statement counts. It required actual pipeline and immutable quote proof. A separate QA assignment added fx-revision-pipeline.test.ts; three actual commit tests passed immediately, while the quote fixture initially failed its 64-hex ID constraint before reaching the target. Corrected fixture only. Native rerun /tmp/invoxim-fx-revision-pipeline-v2.txt: exit0,4/4,1.70s, actual commitLedger path, payment projection and completion, replay/stale rejection, atomic rollback, shared <=40 budget, rejected changed rate/provenance and accepted no-op quote update.

Final Biome gate found import ordering and string concatenation in connection-cleanup; repaired without changing SQL text or guards. This supersedes earlier hashes for those two files. Final five-file native regression /tmp/invoxim-fx-revision-final-v1.txt exit0,85/85,14.29s (revision38, pipeline4, lifecycle and adversarial M1 regression). Earlier broader regression161/11 remains separately recorded, not added to imply distinct total cases. Final seven-file Biome, ESLint and Prettier exit0. Repository typecheck /tmp/invoxim-next-typecheck-v8.txt exit0,5tasks,1cached,9.444s.

This is a recoverable foundation checkpoint, not complete T19. Full-period accumulation, filter equality, list/export/UI integration and deployed migration/limits remain pending. No live schema change, reset, deployment or reference-provider request was executed.
