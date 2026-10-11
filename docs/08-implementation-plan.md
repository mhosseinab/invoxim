# Implementation plan

Version 1.1. Canonical task data is `.agents/backlog.json`. Tasks below are in dependency order, not numeric ID order. All statuses are planned/not started; no application work is claimed. Apply T00 to the actual repository before scaffolding or updating existing code.

M0 remains a private, multi-tenant Gmail slice. M1 completes the agreed MVP; M2 requires separate public-release approval. New T27–T30 refine presentation/onboarding and optional validation. At most four specialist subagents; keep shared-file ownership explicit.

## T00: Inspect repository, sources and toolchain

Milestone: M0. Depends on: none. Implementer: orchestrator. Reviewer: principal-reviewer.

Record actual repository/tool versions, role discovery and permission constraints; produce blockers and next task. No product redesign.

Read: `START_HERE.md`, `AGENTS.md`, `docs/10-decisions-and-release-gates.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: FOUND-01, FOUND-02, FOUND-03.

Required evidence: Inspection report and task graph validation.

## T01: Prove the narrow Cloudflare runtime stack

Milestone: M0. Depends on: T00. Implementer: cloudflare. Reviewer: architect.

Synthetic spike for stable Better Auth/Drizzle/D1, Pages proxy cookies, queue handler and document-conversion capability. Remove discarded spike code.

Read: `docs/02-architecture.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: RUNTIME-01, RUNTIME-02, RUNTIME-03, RUNTIME-04.

Required evidence: Real workerd evidence and a short compatibility decision record; flag live credentials separately.

## T02: Scaffold monorepo and truthful CI

Milestone: M0. Depends on: T01. Implementer: backend. Reviewer: principal-reviewer.

Create pnpm/Turborepo apps/packages, strict configs, boundary checks and real verification scripts. Preserve existing files.

Read: `docs/07-engineering-quality.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: FOUND-03.

Required evidence: Clean install, package boundaries, deliberate failing-check proof, lint/typecheck/build logs.

## T27: Freeze truthful presentation, capability and copy contract

Milestone: M0. Depends on: T00. Implementer: orchestrator. Reviewer: principal-reviewer.

Confirm v1.1 changes and actual implementation state; map public claims/CTAs to capabilities and specify the minimal display/start contracts. No new scope interview or invented market validation.

Read: `docs/13-presentation-and-onboarding.md`, `docs/14-market-validation.md`, `contracts/ux-copy.en.json`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: PRESENT-01, PRESENT-04.

Required evidence: Copy/capability checklist, fixture arithmetic expectations and scoped handoff; discovery validation, not fabricated red tests.

## T03: Implement shared contracts and money kernel

Milestone: M0. Depends on: T02, T27. Implementer: backend. Reviewer: database.

Strict Zod/JSON parity, BigInt money, calendar/date basis, domain types and exact safe serialization. Add bounded display/disclosure/start DTOs and capability projections; keep consent facts distinct from UI readiness.

Read: `docs/03-data-model.md`, `contracts/README.md`, `contracts/onboarding-view.schema.json`, `contracts/ux-copy.en.json`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: MONEY-01, MONEY-02, MONEY-03, MONEY-04, MONEY-05, MONEY-06, MONEY-07, PRESENT-03.

Required evidence: RED/GREEN financial fixture and property-test evidence.

## T04: Implement D1 schema and tenant repositories

Milestone: M0. Depends on: T03. Implementer: database. Reviewer: security.

Versioned migrations, composite tenant relationships, unique source/evidence identities, indexed read paths and job-compatible fences. Include import parent/slice identity, processing-consent references, and scheduling state; no conflicting persisted wizard state.

Read: `docs/03-data-model.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: DB-01, DB-02, DB-03, DB-04.

Required evidence: Clean/upgrade migrations and hostile tenant queries tested in workerd.

## T05: Implement Google login and isolated sessions

Milestone: M0. Depends on: T04. Implementer: backend. Reviewer: security.

Google login, same-origin session handling, allowlisted signup, CSRF, preferences and logout. Do not conflate mailbox authorization.

Read: `docs/06-security-and-privacy.md`, `docs/12-api-contracts.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, ONBOARD-01.

Required evidence: Two-tenant session tests and consent state replay tests; live login blocked until credentials supplied.

## T06: Implement credential vault and OAuth state

Milestone: M0. Depends on: T04. Implementer: backend. Reviewer: principal-reviewer.

AES-GCM keyring with tenant/purpose AAD, encrypted provider credentials, refresh CAS, one-use bound state and redaction.

Read: `docs/06-security-and-privacy.md`, `docs/04-email-and-storage.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: SECRETS-01, SECRETS-02, SECRETS-03, SECRETS-04.

Required evidence: Ciphertext swap/rotation/race tests; settings and logs contain no keys.

## T07: Implement durable scheduler and job engine

Milestone: M0. Depends on: T04, T06. Implementer: cloudflare. Reviewer: database.

D1 job outbox, bounded Cron dispatcher, queue consumers, leases/fencing, retries, idempotency, quota-aware fairness and connection-generation cancellation.

Read: `docs/02-architecture.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: JOBS-01, JOBS-02, JOBS-03, JOBS-04, JOBS-05, JOBS-06, JOBS-07, ONBOARD-13.

Required evidence: Duplicate/lost delivery, lease takeover and crash-after-commit failure injection.

## T08: Implement independent Gmail consent adapter

Milestone: M0. Depends on: T05, T06. Implementer: integrations. Reviewer: security.

Separate verified mailbox identity, read-only OAuth scopes, refresh/reconnect/disconnect and two mailbox accounts per user. Callback leaves awaiting_import and makes no mail-content/discovery calls. Handle partial scope denial and preserve login identity.

Read: `docs/04-email-and-storage.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: AUTH-02, GMAIL-04, GMAIL-06, SECRETS-04, ONBOARD-02, ONBOARD-15.

Required evidence: Contract tests for login A/mailbox B, consent denial, missing refresh token and account mismatch.

## T09: Implement Gmail backfill and incremental discovery

Milestone: M0. Depends on: T07, T08. Implementer: integrations. Reviewer: qa.

Fixed-cutoff 12-month scan, independent incremental state, pagination, metadata-only staging, history expiry recovery, search coverage and import progress. Process the last 30-day slice first within the full approved range; use parent/slice progress, no assumed provider ordering, and share idempotency with live sync.

Read: `docs/04-email-and-storage.md`, `docs/13-presentation-and-onboarding.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: GMAIL-01, GMAIL-02, GMAIL-03, GMAIL-04, GMAIL-05, GMAIL-06, GMAIL-07, GMAIL-08, RECENT-01, RECENT-02, RECENT-03, RECENT-04, RECENT-06, RECENT-09.

Required evidence: Contract fixtures for cursor recovery/new mail during import/rate limits and duplicate accounts.

## T10: Implement inert MIME and document parsing

Milestone: M0. Depends on: T03, T07. Implementer: integrations. Reviewer: security.

Bounded MIME parsing, safe text extraction, exact attachment identity, verified text-PDF adapter, capability routing and unsupported states. No raw persistence.

Read: `docs/05-ai-and-evaluations.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: DOCUMENT-01, DOCUMENT-02, DOCUMENT-03, DOCUMENT-04, DOCUMENT-05, DOCUMENT-06.

Required evidence: Synthetic multipart and generated PDF/image/resource-limit fixtures; no external asset fetch.

## T11: Implement provider-agnostic AI, BYOK and budgets

Milestone: M0. Depends on: T03, T06, T10. Implementer: ai. Reviewer: security.

Approved endpoint registry, hosted/BYOK settings, strict response/evidence validation, bounded repair, atomic metering and consent. No arbitrary proxy. Provide actual destination/readiness/allowance disclosure; stale consent or unavailable hosted processing cannot silently choose another provider.

Read: `docs/05-ai-and-evaluations.md`, `contracts/README.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: AI-01, AI-02, AI-03, AI-04, AI-05, AI-06, AI-07, AI-08, ONBOARD-10.

Required evidence: Malformed/injection/SSRF/capability/budget race tests; synthetic endpoint smoke and masked settings.

## T12: Implement extraction-to-ledger pipeline

Milestone: M0. Depends on: T09, T10, T11. Implementer: backend. Reviewer: database.

Connect discovery to bounded extraction; deterministic exact duplicate logic, observations/evidence, payment/refund states and financial review blockers.

Read: `docs/03-data-model.md`, `docs/05-ai-and-evaluations.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: LEDGER-01, LEDGER-02, LEDGER-03, LEDGER-04, LEDGER-05, LEDGER-06, LEDGER-07, LEDGER-08, LEDGER-09.

Required evidence: Order/invoice/receipt, installments, credit note, reissued invoice and cross-tenant duplicate tests.

## T13: Implement purchase-first Home, detail timeline and connection status

Milestone: M0. Depends on: T05, T12. Implementer: frontend. Reviewer: accessibility.

Purchase/evidence-first Home and detail timeline, searchable records, source-backed paid/refunded/net presentation, coverage and meaningful review states. Keep charts secondary. T29 owns the integrated onboarding flow.

Read: `docs/01-product-and-ux.md`, `docs/12-api-contracts.md`, `docs/13-presentation-and-onboarding.md`, `contracts/ux-copy.en.json`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: UI-01, UI-02, UI-03, UI-04, HOME-01, HOME-02, HOME-03, HOME-04, HOME-05, HOME-06.

Required evidence: Responsive keyboard E2E, import continuing without open tab, totals and pagination checks.

## T14: Implement corrections and review actions

Milestone: M0. Depends on: T12, T13. Implementer: backend. Reviewer: qa.

Versioned overrides, user-confirmed payments/refunds, exclusion, deterministic merge/unmerge and safe review resolution.

Read: `docs/01-product-and-ux.md`, `docs/03-data-model.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: EDIT-01, EDIT-02, EDIT-03, EDIT-04, EDIT-05.

Required evidence: Replay preserves overrides; conflict, merge round-trip and idempotent confirmation tests.

## T15: Implement basic export, disconnect and deletion

Milestone: M0. Depends on: T05, T07, T12. Implementer: backend. Reviewer: security.

CSV/JSON structured export, confirmed deletion, session/job fencing, retained-data options and privacy-safe cleanup.

Read: `docs/06-security-and-privacy.md`, `docs/12-api-contracts.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: LIFECYCLE-01, LIFECYCLE-02, LIFECYCLE-03, LIFECYCLE-04, LIFECYCLE-05, LIFECYCLE-06.

Required evidence: Cross-tenant export, spreadsheet injection, in-flight deletion and no-raw-data inspection.

## T28: Build landing and isolated read-only example

Milestone: M0. Depends on: T02, T27. Implementer: frontend. Reviewer: accessibility.

Lightweight truthful landing and /demo with synthetic presentational adapter, release-aware CTAs and no private loaders, model calls or database writes.

Read: `docs/13-presentation-and-onboarding.md`, `contracts/ux-copy.en.json`, `test-design/fixtures/presentation-demo.json`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: PRESENT-02, DEMO-01, DEMO-02, DEMO-03, DEMO-04.

Required evidence: Browser/network proof of demo isolation, exact synthetic totals, capability guards and mobile/keyboard screenshots.

## T29: Implement resumable consent-safe onboarding

Milestone: M0. Depends on: T08, T09, T11, T13, T27. Implementer: frontend. Reviewer: security.

Integrate login/connect/review-start, actual destination/allowance disclosure, idempotent server-authorized import start, resumable progress and first-record access. Coordinate any backend routes under assigned ownership. No forced Drive/BYOK or pre-Start scanning.

Read: `docs/13-presentation-and-onboarding.md`, `docs/12-api-contracts.md`, `contracts/onboarding-view.schema.json`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: ONBOARD-03, ONBOARD-04, ONBOARD-05, ONBOARD-06, ONBOARD-07, ONBOARD-08, ONBOARD-09, ONBOARD-11, ONBOARD-12, ONBOARD-14, RECENT-05, RECENT-07, RECENT-08, RECENT-10, ACCESS-01, ACCESS-02.

Required evidence: State projection and API guard tests; Playwright refusal/wrong-account/two-tab/reload/paused/no-results paths; explicit absence of pre-consent content requests.

## T16: Verify private Gmail vertical slice

Milestone: M0. Depends on: T13, T14, T15, T28, T29. Implementer: qa. Reviewer: principal-reviewer.

Run all M0 gates against integrated build; obtain explicit consent for actual staged OAuth smoke. Report incomplete/live-blocked checks honestly. Verify v1.1 demo, explicit Start, progressive history, copy/capability accuracy and first-record flow; internal speed targets are measured, not guaranteed.

Read: `docs/10-decisions-and-release-gates.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: FOUND-01, FOUND-02, FOUND-03, RUNTIME-01, RUNTIME-02, RUNTIME-03, RUNTIME-04, MONEY-01, MONEY-02, MONEY-03, MONEY-04, MONEY-05, MONEY-06, MONEY-07, DB-01, DB-02, DB-03, DB-04, AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, SECRETS-01, SECRETS-02, SECRETS-03, SECRETS-04, JOBS-01, JOBS-02, JOBS-03, JOBS-04, JOBS-05, JOBS-06, JOBS-07, GMAIL-01, GMAIL-02, GMAIL-03, GMAIL-04, GMAIL-05, GMAIL-06, GMAIL-07, GMAIL-08, DOCUMENT-01, DOCUMENT-02, DOCUMENT-03, DOCUMENT-04, DOCUMENT-05, DOCUMENT-06, AI-01, AI-02, AI-03, AI-04, AI-05, AI-06, AI-07, AI-08, LEDGER-01, LEDGER-02, LEDGER-03, LEDGER-04, LEDGER-05, LEDGER-06, LEDGER-07, LEDGER-08, UI-01, UI-02, UI-03, UI-04, EDIT-01, EDIT-02, EDIT-03, EDIT-04, EDIT-05, LIFECYCLE-01, LIFECYCLE-02, LIFECYCLE-03, LIFECYCLE-04, LIFECYCLE-05, LIFECYCLE-06, LEDGER-09, PRESENT-01, PRESENT-02, PRESENT-03, PRESENT-04, DEMO-01, DEMO-02, DEMO-03, DEMO-04, ONBOARD-01, ONBOARD-02, ONBOARD-03, ONBOARD-04, ONBOARD-05, ONBOARD-06, ONBOARD-07, ONBOARD-08, ONBOARD-09, ONBOARD-10, ONBOARD-11, ONBOARD-12, ONBOARD-13, ONBOARD-14, ONBOARD-15, RECENT-01, RECENT-02, RECENT-03, RECENT-04, RECENT-05, RECENT-06, RECENT-07, RECENT-08, RECENT-09, RECENT-10, HOME-01, HOME-02, HOME-03, HOME-04, HOME-05, HOME-06, ACCESS-01, ACCESS-02.

Required evidence: M0 completion report with command evidence, security review and known limitations. Not full-MVP completion.

## T17: Implement Outlook mail adapter

Milestone: M1. Depends on: T16. Implementer: integrations. Reviewer: qa.

Delegated read consent, account-type support, recursive folder inventory, immutable IDs, per-folder delta and reset recovery.

Read: `docs/04-email-and-storage.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: OUTLOOK-01, OUTLOOK-02, OUTLOOK-03, OUTLOOK-04, OUTLOOK-05.

Required evidence: Personal/work account protocol fixtures, moved/archive mail and opaque continuation tests.

## T18: Implement optional Google Drive archive

Milestone: M1. Depends on: T16. Implementer: integrations. Reviewer: security.

Separate drive.file consent, user receipts folder, preallocated upload ID, exact originals, bounded opt-in backfill and failure UX. Request archive access only on user action; normal Drive offer occurs after real first value, with on-demand Settings access beforehand.

Read: `docs/04-email-and-storage.md`, `docs/13-presentation-and-onboarding.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: DRIVE-01, DRIVE-02, DRIVE-03, DRIVE-04, DRIVE-05, DRIVE-06, LATE-DRIVE-01, LATE-DRIVE-02.

Required evidence: Lost response/409/quota/revocation/source-missing tests; archive failure does not change money.

## T19: Implement historical FX reporting

Milestone: M1. Depends on: T16. Implementer: backend. Reviewer: database.

Frankfurter v2 adapter with stated rate source, exact snapshots, rate age bounds, per-event conversion and preference revaluation.

Read: `docs/03-data-model.md`, `contracts/README.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: FX-01, FX-02, FX-03, FX-04, FX-05.

Required evidence: Weekend/missing-rate/per-entry-rounding/refund-date tests and list-summary-export equality.

## T20: Implement recurring estimates and changes

Milestone: M1. Depends on: T19. Implementer: backend. Reviewer: qa.

Evidence-based recurrence suggestions, original currency comparison, monthly/yearly forecasts, user confirmation/dismissal and cautious increase detection. Supply evidence-linked comparable charge pairs for UI; never infer unused service or treat an estimated next date as a confirmed charge.

Read: `docs/03-data-model.md`, `docs/01-product-and-ux.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: RECUR-01, RECUR-02, RECUR-03, RECUR-04, RECUR-05, RECUR-UX-01.

Required evidence: Month-end anchors, variable bills, annual terms and override persistence; forecasts never add spending.

## T21: Complete MVP settings, review and dashboard UX

Milestone: M1. Depends on: T17, T18, T19, T20. Implementer: frontend. Reviewer: accessibility.

Complete provider/Drive/AI controls, reporting currency, recurring UI, recoverable failures, source/archive links and accessible charts/tables. Complete delayed Drive prompt and purchase-first layout; add manual Personal/Work/Unassigned tag and identical list/summary/export filters without accounting expansion.

Read: `docs/01-product-and-ux.md`, `docs/13-presentation-and-onboarding.md`, `contracts/ux-copy.en.json`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: UI-01, UI-03, UI-04, RELEASE-04, RECUR-UX-02, TAG-01, TAG-02.

Required evidence: Cross-feature keyboard/mobile E2E; consistent totals, consent, empty, failure and review states.

## T22: Expand extraction corpus and run evaluations

Milestone: M1. Depends on: T16. Implementer: ai. Reviewer: qa.

At least 120 labeled synthetic/approved cases including 40 held out; generated PDF/MIME/image fixtures and exact numeric/security challenges.

Read: `docs/05-ai-and-evaluations.md`, `test-design/README.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: AI-01, AI-02, AI-03, RELEASE-01.

Required evidence: Deterministic report plus separately approved live-model report with denominators, costs and error taxonomy.

## T23: Run security and data-integrity hardening

Milestone: M1. Depends on: T21, T22. Implementer: security. Reviewer: principal-reviewer.

Adversarial tenant/OAuth/SSRF/input/log/dependency review; mutation and property checks; confirm no unsafe feature bypass.

Read: `docs/06-security-and-privacy.md`, `docs/07-engineering-quality.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: DB-01, DB-04, AI-03, AI-07, SECRETS-01, LIFECYCLE-02, LIFECYCLE-06, RELEASE-02.

Required evidence: Reproducible findings, fixes by implementer, independent re-review; no unresolved unapproved high/critical findings.

## T24: Implement deploy, monitoring and recovery runbooks

Milestone: M1. Depends on: T16. Implementer: observability. Reviewer: cloudflare.

Isolated envs, redacted metrics, operator caps/kill switch, resource thresholds, deployment smoke and deletion-aware restore simulation.

Read: `docs/09-operations-and-costs.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: JOBS-03, RELEASE-03, RELEASE-05.

Required evidence: Runbook exercises and restore suppression evidence; record missing operator inputs without inventing infrastructure.

## T30: Add bounded opt-in pilot measurements and validation worksheet

Milestone: M1. Depends on: T16. Implementer: observability. Reviewer: security.

Implement off-by-default first-party content-free pilot event controls, opt-out/deletion purge and accurate timing definitions. Provide an owner-run benchmark worksheet; do not claim a live pilot or competitor evaluation was executed.

Read: `docs/14-market-validation.md`, `docs/09-operations-and-costs.md`, `test-design/market-benchmark-template.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: PILOT-01, PILOT-02, PILOT-03, PILOT-04, PILOT-05, PILOT-06.

Required evidence: Event allowlist/tenant/rate-limit/retention/deletion tests and honest empty benchmark report; no third-party analytics or fabricated product-market fit.

## T25: Verify complete private MVP

Milestone: M1. Depends on: T17, T18, T19, T20, T21, T22, T23, T24, T30. Implementer: qa. Reviewer: principal-reviewer.

Run all M1 gates on integrated build, verify live prerequisites and document supported formats/provider limitations and measured budgets.

Read: `docs/10-decisions-and-release-gates.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: RELEASE-01, RELEASE-02, RELEASE-03, RELEASE-04, RELEASE-05, RELEASE-06, FOUND-01, FOUND-02, FOUND-03, RUNTIME-01, RUNTIME-02, RUNTIME-03, RUNTIME-04, MONEY-01, MONEY-02, MONEY-03, MONEY-04, MONEY-05, MONEY-06, MONEY-07, DB-01, DB-02, DB-03, DB-04, AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, SECRETS-01, SECRETS-02, SECRETS-03, SECRETS-04, JOBS-01, JOBS-02, JOBS-03, JOBS-04, JOBS-05, JOBS-06, JOBS-07, GMAIL-01, GMAIL-02, GMAIL-03, GMAIL-04, GMAIL-05, GMAIL-06, GMAIL-07, GMAIL-08, DOCUMENT-01, DOCUMENT-02, DOCUMENT-03, DOCUMENT-04, DOCUMENT-05, DOCUMENT-06, AI-01, AI-02, AI-03, AI-04, AI-05, AI-06, AI-07, AI-08, LEDGER-01, LEDGER-02, LEDGER-03, LEDGER-04, LEDGER-05, LEDGER-06, LEDGER-07, LEDGER-08, UI-01, UI-02, UI-03, UI-04, EDIT-01, EDIT-02, EDIT-03, EDIT-04, EDIT-05, LIFECYCLE-01, LIFECYCLE-02, LIFECYCLE-03, LIFECYCLE-04, LIFECYCLE-05, LIFECYCLE-06, OUTLOOK-01, OUTLOOK-02, OUTLOOK-03, OUTLOOK-04, OUTLOOK-05, DRIVE-01, DRIVE-02, DRIVE-03, DRIVE-04, DRIVE-05, DRIVE-06, FX-01, FX-02, FX-03, FX-04, FX-05, RECUR-01, RECUR-02, RECUR-03, RECUR-04, RECUR-05, LEDGER-09, PRESENT-01, PRESENT-02, PRESENT-03, PRESENT-04, DEMO-01, DEMO-02, DEMO-03, DEMO-04, ONBOARD-01, ONBOARD-02, ONBOARD-03, ONBOARD-04, ONBOARD-05, ONBOARD-06, ONBOARD-07, ONBOARD-08, ONBOARD-09, ONBOARD-10, ONBOARD-11, ONBOARD-12, ONBOARD-13, ONBOARD-14, ONBOARD-15, RECENT-01, RECENT-02, RECENT-03, RECENT-04, RECENT-05, RECENT-06, RECENT-07, RECENT-08, RECENT-09, RECENT-10, HOME-01, HOME-02, HOME-03, HOME-04, HOME-05, HOME-06, ACCESS-01, ACCESS-02, LATE-DRIVE-01, LATE-DRIVE-02, RECUR-UX-01, RECUR-UX-02, TAG-01, TAG-02, PILOT-01, PILOT-02, PILOT-03, PILOT-04, PILOT-05, PILOT-06.

Required evidence: Full release report tied to commit/build, commands, fixtures, evidence and explicit blocked items.

## T26: Evaluate public-release prerequisites

Milestone: M2. Depends on: T25. Implementer: orchestrator. Reviewer: security.

Review verification/assessment, disclosures/processors, privacy, security, cost, operational ownership and owner approval. Do not auto-launch. Audit release-aware presentation and disclosed processing claims against actual deployment; no claims of proven market fit.

Read: `docs/10-decisions-and-release-gates.md`, `docs/14-market-validation.md`.

Test first: Before behavior changes, add a named failing behavioral test from the linked cases and confirm its intended failure. For discovery/configuration tasks record actual validation instead.

Acceptance IDs: RELEASE-06.

Required evidence: Gate D decision: approved with evidence or blocked with precise prerequisites. No billing build.
