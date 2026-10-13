# T19 full-period reporting integration recommendation

Date: 2026-10-13. Reviewer: `/root/fx_period_plan`, separate architecture agent. Status: **recommendation only; T19 remains incomplete**. Assignment permits this evidence file only. No source edits, test execution, migrations, provider requests, deployment, or child agents.

## Requirements and inspected evidence

Read root AGENTS.md, architect role, seven canonical rules, architecture/D1/money/runtime skills, BLUEPRINT.md, relevant architecture/data/operations/API/contracts documents, T19 backlog scope and FX-01–05 acceptance cases. Financial cases are synthetic expected inputs, not execution evidence.

Inspected:

- `packages/adapters/src/fx/service.ts`: select at line 165, row-only final fence at 218, page read at 238; limit 20 reads and 3 revaluations.
- `packages/adapters/src/fx/repository.ts`: get at 145, put at 214; historical snapshots, original-field/profile/entry/policy matching, public-rate hash validation and fenced batch.
- `apps/worker/src/fx-routes.ts`, `packages/contracts/src/fx-reporting.ts`: explicit `summaryScope: page`; authenticated 40-statement wrapper; POST cursor transport.
- `packages/adapters/src/purchase-views/index.ts`: shared filter conditions at 80; export snapshot at 277; summary at 452. Original-currency summary uses up to 25 keyset chunks of 4,000 events with BigInt. Export has explicit 500-purchase/2,000-event limits. No reporting-currency integration.
- Purchase/lifecycle routes, lifecycle export encoder/contracts, correction transaction/store/operations, pipeline repository financial commit, lifecycle graph/connection cleanup/recompute/leaf cleanup, consolidated SQL baseline and FX service/route test source.
- Existing service checkpoint report: it reports 106 passing tests in a previous increment and explicitly excludes full-period integration. This reviewer read that report, not its complete execution logs; it is not evidence that this proposed increment passes.

## Findings

**P1 — missing full-period integration.** The FX page/export response is honestly page-scoped, while purchase summary/export still reports conversion not configured. Reading 21+ entries exposes the gap: a page subtotal is not the filtered period. The full-period deliverable cannot be certified from current endpoints.

**P1 — no fence across a complete report traversal.** Service cursor fingerprints contain tenant/profile/filter/policy but no ledger or valuation revision. `stillCurrent` checks only returned entries. Correction of an earlier entry, insertion behind the cursor, deletion of an unseen entry, or revaluation of a previously pending entry can mix states across pages. A page can also use different valuations before/after a concurrent valuation write without changing its ledger versions. Profile version alone does not cover these writes.

**P1 — selection differs between FX and purchase views.** FX selects eligible tenant entries directly; purchases exclude merged and lifecycle-marked records, apply purchase/document-or-event membership filters, and then apply event-date/currency filters. A standalone FX sum cannot simply be attached to the existing purchase summary. Null purchase entries need an explicit treatment; existing purchase views omit them. Preserve that established purchase selection for purchase/list/export equality rather than silently adding orphan events to its summary.

**P2 — current summary schema cannot represent a whole period.** `fxConversionSummarySchema` caps converted plus unconverted entries at 1,000 and embeds every unconverted row. Enlarging this array is not a bounded full-period design. Whole-period summary needs scalar totals and coverage counts; missing originals remain in paginated rows/export.

## Recommended smallest correct path

Keep one Worker, native D1, existing valuation table, exact conversion functions, existing financial writers and purchase filter semantics. Add no reporting service deployment, materialized financial aggregate, report job engine, R2, snapshot copies, or generic repository. Use optimistic report revisions: concurrent relevant writes cause 409 and a fresh traversal. This gives a consistent report at a revision, not an immutable historical snapshot that survives edits.

### 1. One tenant revision, atomically maintained

Add `profiles.reporting_revision INTEGER NOT NULL DEFAULT 1`, with integer/type/range CHECK and fail-closed overflow at the chosen exact integer maximum. Read it as CAST-to-text, expose a canonical decimal string, never wrap or reset it. Do not increment profile `version` for each ledger write: that would unnecessarily invalidate every valuation. Keep current profile-version semantics separate.

Use focused D1 triggers to update the revision in the same database transaction as each relevant row mutation. This is a material but necessary schema choice: financial writes are spread across correction, pipeline and bounded lifecycle paths, and some eligibility changes do not bump entry version. Triggers avoid fragile hand-maintained application hooks in every writer. They do add write amplification and require runtime proof before adoption.

Trigger coverage must follow the actual report projections/predicates:

| Input table | Required invalidation |
| --- | --- |
| ledger_entries | Insert/delete and changes to ownership, purchase association, kind, amount, currency, event date/basis, eligibility, origin, observation, version |
| entry_valuations | Insert/delete/update of matching valuation content/key; pending-to-valued and missing-to-converted changes count |
| purchases | Insert/delete and changes to displayed fields, filter fields, version, record status and lifecycle hide/recompute markers |
| purchase_evidence, manual_purchase_evidence | Membership/provenance changes affecting mailbox filters, counts and exported evidence |
| review_items | Membership/reason/status/scope/entity changes affecting review filters, displayed questions or counts |
| observations, documents, source_messages, connections | Only projection/join/filter/source-availability fields consumed by the report/export; exclude operational cursors, next-sync, refresh leases and ciphertext-only changes |
| field_overrides | Exported override mutations |
| profiles | Status, version, currency/timezone changes checked explicitly in the report stamp; a focused trigger may also advance reporting revision for these fields |

Generate no broad arbitrary-table mechanism. Define the trigger set explicitly in SQL, and document its projection dependency list. Ownership-changing updates, if possible, must invalidate both OLD and NEW tenants; otherwise enforce immutable ownership. Profile deletion leaves no authorized report; cascaded trigger updates must safely tolerate the missing parent. Trigger failure rolls back the enclosing writer, never returns a successful financial mutation without revision advancement. A future report filter, including use_tag when implemented, must extend this list.

Public rate snapshots are immutable in ordinary code: insert-only does not alter existing valuations. Do not make aggregate readers select fresh rate-cache results instead of stored valuations. If rate mutation is later allowed, invalidate every affected valuation tenant or reject the mutation; present get recomputes and validates quoted rates.

Use a new ordered additive migration after the current latest migration (do not edit/replay the existing initial baseline). Existing profiles receive revision 1; subsequent triggers cover new users without a second tenant table or lifecycle table registration. Prove clean install and populated upgrade.

### 2. One validated report stamp and common event projection

Report stamp binds trusted tenant, profile version/currency/timezone, reporting revision, canonical PurchaseFilters, FX policy hash/calculation version and protocol version. Include it in list cursors, period traversal continuations and exports. A stamp is not authorization: authenticate and require an active profile on every request.

Reuse `conditions()` and `matchesPeriod()` knowledge from purchase views through one small explicit internal query helper. Do not duplicate a looser filter implementation in FX routes. Preserve document-or-event purchase membership, event-date monetary inclusion, currency behavior, excluded/merged/lifecycle semantics and existing ordering. Show document-only/unpaid purchases even if they contribute no eligible monetary events. Source-backed filters use tenant joins.

Fetch bounded event chunks with matching valuations/rate metadata in a single joined query per chunk, not repository.get N+1 calls. Preserve the repository's exact match predicates and rate/snapshot validation. Extract its row decoder/validation as a local helper reused by get and bulk reporting; do not build a generic data mapping framework. A stale valuation is pending. An actual validated unconverted snapshot carries its closed missing/unsupported/stale reason. Filter eligibility before counting conversion coverage.

Keep current primary-bound `db.prepare` reads through the shared wrapper for this increment. Official D1 docs confirm reads without Sessions execute on primary. If replication sessions are introduced later, use a single sequentially consistent session starting on primary and check its revision before and after; bookmarks provide monotonic ordering, not a snapshot.

Every multi-statement report request reads/checks the stamp before its data work and after it. Revision and active/profile state must still match. No partial success on mismatch. With atomic trigger increments and primary reads, equal revisions bracket an unchanged report state; no `MAX(updated_at)`, event counts, maximum IDs, or D1 bookmark should be called a ledger revision. A write after the final check makes the response an older coherent revision, which is acceptable; the next request with that stamp must reject it.

### 3. Full-period reduction with bounded continuation

Reuse the existing keyset event scan and BigInt reduction. For converted events add signed per-entry minor values into separate paid/refunded magnitude BigInts; derive net exactly. Do not SQL SUM money, cast a large sum to Number, convert original-currency net, or use today's quote. Historical payment and refund dates remain independent.

Reduce bounded chunks within one invocation. Reserve statements for authentication, first/final stamp checks, metadata counts and query headroom, using the existing wrapper's remainingStatements; set a measured row/CPU bound as well. Do not let an arbitrary full-period size consume all 40 statements or unbounded memory.

For larger periods return an explicit `in_progress` continuation carrying the last event ID, scalar accumulated totals/counters and report stamp; only terminal completion emits `summaryScope: period`. This is a traversal of the complete original filter, never an implicit narrowed date range or a page subtotal relabeled as a period. Do not use the current max-1,000 summary with an unconverted array. Use scalar converted/pending/unconverted/reason counts (exact decimal counters if the protocol admits counts above safe Number); expose original missing/pending rows through list/export pages. Completion of scanning and completion of valuation are separate states: a complete scan can still have pending values and incomplete coverage.

If totals travel in a stateless continuation, authenticate the complete canonical payload with a purpose-specific HMAC using the existing server secret/signing convention. A bare fingerprint is insufficient: clients could forge accumulated money. Bind tenant/session, filters, revision, profile/policy and expiry; strictly bound canonical decimals, IDs and payload size; verify before accepting any accumulated value. Replaying the same continuation produces the same result at the same revision; clients must replace that step rather than append it twice. This requires a narrow cursor signing/verifying seam at the existing service/root boundary, not new infrastructure or credentials. Use POST for long cursors and never log tokens containing financial aggregates.

### 4. Integrate the actual purchase list, summary and export

Purchase list rows get a clearly named reporting-period projection and coverage alongside preserved original/lifecycle values. Summary's reporting result comes from the same event projection/reducer. All requests in one list/summary/export comparison carry the same report stamp; independent unstamped requests during writes are not guaranteed equal and must not be advertised as such.

Integrate reporting values and coverage into `/api/export`, including exact per-event signed converted minor, original amounts, historical rate source/date/decimal/calculation provenance and matching full-period summary. Extend CSV safely with explicit reporting fields and preserve spreadsheet escaping. Export records outside the event period may remain as lifecycle provenance but must not contribute to period totals. Apply identical filters and exclusion decisions everywhere.

Keep existing bounded whole-file export for datasets it can completely represent; overflow remains an explicit error. Add revision-fenced export continuation for a full filtered dataset above those bounds, sharing report selection and stamp. Buffer or stage pages only on the authorized client until a final validation confirms the revision and complete traversal; do not publish a downloadable final artifact from a failed partial traversal. Export continuation may carry scalar totals but must not embed unbounded prior rows. A paged transport can deliver a full export; a first page called a full export cannot.

Revaluation is a separate operation, still <=3 events/provider lookups per invocation and still using entry/profile/policy CAS. Do not invoke revaluation from list/summary/export. Each stored valuation advances report revision; thus reading while revaluation runs legitimately yields 409/restart rather than mixed coverage. A revaluation traversal cannot blindly use the strict report revision cursor, because its own writes advance it: retain its current mutation-specific traversal and entry/profile fencing, then start a fresh reporting traversal. Preserve original entries on profile changes. Queue/background preference revaluation remains a T19 acceptance gap if only user-driven pages exist.

## Proposed implementation ownership

Orchestrator should assign non-overlapping ownership before edits:

- Database implementer: one additive revision/trigger migration and migration/native rollback tests; docs/03-data-model.md projection dependency list.
- Backend implementer: adapters purchase-views/fx service+repository row decoder, a small report cursor module if needed; contracts purchase/fx-reporting/lifecycle; Worker purchase/fx/lifecycle routes and composition; core lifecycle export encoder and pure reporting reducer if shared. No edits to correction/pipeline/lifecycle financial writers are expected with proven triggers.
- QA: named workerd tests below plus integration budget instrumentation; inspect required regression suites for existing writer changes()/meta.changes behavior under triggers.
- Frontend implementer only if the handoff includes delivery UI: list/summary report stamp propagation, pending coverage, complete export assembly and restart UX. Otherwise report UI as outstanding, not implemented.
- Architecture/reviewer: read-only re-review of actual diff and QA evidence. This evidence file is the only file owned by this review.

## Required acceptance evidence (planned; none executed here)

1. FX-01/04: weekend prior rate and payment/refund on different months; source/date/exact quote persisted; list full traversal, period summary and JSON/CSV export agree under the same stamp.
2. FX-02/05: converted, missing/unsupported/stale and pending entries across multiple chunks; original values remain visible, no rate 1, no pending zero, all coverage counts equal. Change profile during lookup/report/export; old writes fenced, old cursors 409, fresh report preserves originals.
3. FX-03: half-minor values and negative refund rounding; independent exact oracle; totals above JS safe integer and above SQLite signed-integer aggregate limits remain correct decimal strings. Cover more than 1,000 entries so current schema limitation cannot hide.
4. Entire period beyond one invocation and beyond current whole-export limits; 40-statement ceiling includes real authentication/profile reads, all batch statements and final fences. Chunk/CPU/payload limits and terminal empty chunk work at exact boundaries. Revaluation still performs <=3 lookups/events.
5. Concurrent correction/delete/insert before and behind cursor; move an event into/out of period, toggle eligibility without entry-version change, merge/split, change purchase date/category/review/mailbox support; each invalidates continuation. Pending-to-converted and unconverted-to-converted valuation changes also invalidate. Include same-timestamp mutations proving timestamps cannot fence.
6. Native migration/trigger tests: populated upgrade and new user, INSERT/UPDATE/DELETE and cascades, both ownership sides or immutable ownership rejection, atomic batch rollback, stale writer no-op, idempotent replay, fail-closed revision maximum, missing parent deletion. Existing pipeline changes() guard and FX put meta.changes must still behave correctly under triggers. Record rows read/written and trigger amplification.
7. Cross-tenant filters/cursors/exports; forged HMAC sums, counters, IDs, changed filters/policy/expiry/session; invalidation during multi-statement export; incomplete page sequences never produce a complete artifact. Read-only endpoints make no reference-provider calls. Missing/corrupt snapshots fail safely.
8. Regression: corrections/pipeline/lifecycle suites, reporting route tests, contracts and CSV escaping; required verify/typecheck/lint/format/build. Browser coverage only for actual included UI. Live FX-provider smoke remains separate operator evidence.

QA evidence was requested through `/root`; it was not supplied during this review. No acceptance case is certified by this plan.

## Unresolved requirements and maintenance effects

Confirm whether full report/export must complete despite continuous concurrent financial writes. The minimal optimistic plan guarantees coherence and detects writes but can repeatedly restart on a busy tenant. Guaranteed stable downloadable snapshots during ongoing edits require explicitly approved snapshot persistence/versioned history and cleanup; that is a larger follow-up, not an invented D1 guarantee.

Current requirement explicitly mandates queued preference revaluation in docs/12-api-contracts.md. The continuation reader does not implement that background behavior; its scheduling/job ownership must be assigned separately within T19, reusing existing bounded jobs rather than a new reporting engine.

Trigger cost: one revision-row write per affected row, potentially several per logical batch. Extra D1 writes, index/scan costs and restarts require measurement. Sensitive cursor payloads remain transient; no new originals, raw content, external processor, infrastructure or paid service. Shared filter/valuation row helpers remove repeated knowledge but create two concrete maintenance obligations: keep projection-trigger coverage aligned with every future filter/export field, and keep bulk valuation validation identical to repository.get. Add an indexed query plan only if measured joins/order need it; existing tenant/date/purchase and valuation primary indexes are starting points, not proof of bounded scan costs.

## Execution record and decision

Reviewer executed only read/search commands (`cat`, `sed`, `rg`, `git status --short`) and wrote this recommendation via apply_patch. Read commands generally exited 0; one combined read included an erroneous nonexistent redundant skill path and exited 1, corrected by the earlier successful required skill read. No verification suite was run. Parent-supplied writer changes visible in git status were preserved. No commit created by reviewer.

Context7 capability was not exposed in ALL_TOOLS. Official Cloudflare documentation fallback checked D1 batch rollback and primary/sequential read semantics: [D1Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/). These docs do not certify local trigger/changes()/budget behavior; QA must prove that on pinned workerd.

Decision: **recommend this minimal revision-fenced integration; request changes before claiming T19 full-period equality**. Evidence path: `evidence/implementation/t19-period-integration-plan-20261013.md`.
