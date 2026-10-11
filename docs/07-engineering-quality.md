# Engineering quality and verification

## Quality principles made concrete

SOLID: functions/modules each own a coherent responsibility; provider wire formats stay in adapters; tests can substitute ports; no massive service depending on every provider. Open/closed does not require a dynamic plugin marketplace. Interface segregation means narrow consumer needs, not an interface for every class.

DRY: centralize currency semantics, category definitions, authorization rules, and schemas. Do not merge unrelated code just because a few lines look alike. Duplication in independent test expectations can be valuable; expected values must not be produced by the implementation under test.

KISS: a modular monolith, one main Worker, one application D1 database, a durable job table, and explicit adapters. No domain-event platform, saga framework, generic CRUD generator, or distributed lock product without demonstrated need.

YAGNI: no billing, banks, teams, mobile clients, embeddings, universal IMAP bridge, or speculative enterprise abstractions. The agreed full MVP is not “scope creep”; it remains in the backlog even when the first slice is smaller.

## Required TDD cycle

For each behavioral task:

1. Write acceptance examples and the smallest failing test. Include relevant negative paths, not only a happy-path snapshot.
2. Run it and record the intended failure. A failure due only to a misspelled import or missing test environment is not evidence that the business case was tested.
3. Implement the smallest behavior that passes. Do not change expected values to match a bug.
4. Refactor with tests passing. Add boundaries only when they improve a real use case.
5. Run the affected unit/integration/contract/E2E/security checks and then the repository gate appropriate to the milestone.
6. Submit independent review and attach redacted evidence.

For an empty project, an initial missing export can establish the first RED, but follow it with an assertion-level failure before claiming the behavioral contract is exercised. Config/docs-only tasks use schema/build/link validation rather than meaningless tests.

## Required implementation scripts

The application build must create these scripts; they do not exist in this blueprint yet:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:contracts
pnpm test:security
pnpm test:e2e
pnpm test:a11y
pnpm test:mutation
pnpm test:eval:offline
pnpm test:eval:live        # explicit opt-in, configured synthetic data only
pnpm check:boundaries
pnpm check:secrets
pnpm check:deps
pnpm db:check
pnpm build
pnpm verify              # deterministic required merge gate
pnpm verify:release      # broader staging, recovery, compatibility evidence
```

Use Vitest for pure-domain tests and Cloudflare’s Vitest integration for real workerd behavior/bindings. [S23] Plain Node mocks cannot establish that D1, Web Crypto, service bindings, queues, or the chosen auth package work in Workers. Use Playwright for real browser flows, and an accessibility checker plus manual keyboard review.

## Type and code policy

`strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`; justify any exception. No unexplained `any`, `@ts-ignore`, double-cast to force compatibility, swallowed error, magic monetary constant, or floating promise. Validate unknown data at every boundary with Zod and typed errors. Do not assert that provider JSON is a trusted interface.

Parameterized SQL only. Avoid `SELECT *` for user-facing queries and accidental credential exposure. HTTP handlers translate transport details and call use cases; they do not contain provider refresh flows, reconciliation rules, or raw SQL assembly.

Prefer explicit immutable inputs/results and injected clocks/IDs for deterministic tests. No process-global mutable tenant, secret, or request context in a Worker isolate. Bound concurrency and clean up aborted fetches. Public errors have stable codes, no raw vendor stack traces.

Pin dependencies and package-manager/runtime versions after compatibility checks. Commit a lockfile. Review install scripts and licenses; no curl-pipe-shell installers. Depend on stable versions unless an owner-approved compatibility reason requires otherwise. Security updates need relevant regression tests, not only an automated version bump.

## Test layers

### Unit and property tests

Money parsing/formatting; 0/2/3 decimal currencies; rounding; date/timezone/calendar arithmetic; net spending; dedupe rules; payment vs invoice; refund/cancellation; override merge logic; recurrence estimation; retry/backoff calculation.

Property tests should prove idempotent reconciliation, tenant-independent outcomes, non-negative stored magnitude with explicit direction, net totals invariant under evidence ordering, and unchanged results after replay. Generate collision/move/duplicate cases with deterministic seeds.

### Workerd and persistence integration

Real migrations; FK ownership; unique constraints; D1 batch rollback/fencing; concurrent claims; outdated leases; optimistic edits; deletion generation; pagination; queue ack/retry behavior; encrypted token storage; date queries; safe aggregate conversion. Exercise the selected runtime, not a different SQLite adapter.

### Provider contracts

Record/replay **synthetic** responses for Gmail/Graph pagination, token rotation, rate limits, expired cursors, multiple attachments, folder moves, invalid MIME, and Drive 409/quota errors. Contracts assert request scope/headers/paths and behavior, not vendor implementation internals. Live smoke tests are separate and explicitly authorized.

### Browser/E2E

Two users cannot view or mutate one another’s data; login vs connection account separation; onboarding without storage; resumable import after tab closes; filtering without duplicates; manual correction; original unavailable; allowance pause; recurring suggestions; safe export; delete account with active job. Avoid real Google browser automation in ordinary CI. Use a test identity adapter isolated from production, and separately perform real OAuth smoke tests.

### Security

IDOR across reads/writes/merges/archive/export/job actions; OAuth callback replay/mix-up; poisoned AI output; embedded URL attacks; BYOK SSRF; XSS; malicious MIME; log/trace leaks; CSV injection; revoked-key use; delete/disconnect races; unauthorized source relationship changes. A mock “denied” repository is not proof that the production query is scoped.

## Coverage and mutation gates

Proposed thresholds: core business/security modules at least 90% branch and line coverage; changed executable code at least 90% line coverage. Exclude generated auth/schema/types and configuration with documented reasons. Report coverage denominator and files. No blanket exclusion of difficult modules.

Target mutation score at least 80% for focused monetary/reconciliation/authorization predicates. Investigate every surviving safety-critical mutant even if the overall score passes. Mutation tests can run on changed critical modules per PR and the whole critical set before release; do not force costly whole-repo mutation runs for a CSS-only change.

Do not use a 100% number to imply exhaustive correctness. A known untested critical edge case blocks release regardless of aggregate coverage. Any temporary waiver needs owner/reviewer approval, exact risk, expiry, and a tracked task; agents cannot approve their own waiver.

## CI, reproducibility, and supply chain

Required merge workflow: frozen-lockfile install, schema/boundary checks, format/lint/typecheck, deterministic unit/workerd/provider/security/eval tests, build, focused E2E/a11y, secret/dependency scanning, migration checks, and evidence artifacts. Run browser/mutation/full E2E as appropriate to changed risk; all required milestone gates must run before completion.

Use minimum workflow permissions; do not expose production secrets to untrusted PR code. Pin CI actions by verified immutable revision. Cache only public dependencies/build artifacts, never customer data or provider tokens. No `continue-on-error` around required tests. Unknown scanner results are investigated, not silently ignored.

CI produces JUnit/JSON reports, coverage, failing screenshots/traces containing synthetic data only, migration evidence, and a build manifest. Define flaky-test handling: reproduce with recorded seed; quarantine only with an approved issue and alternate risk coverage. Re-running until green is not a fix.

## Performance and accessibility acceptance

Measure, do not fabricate: with 10,000 synthetic ledger entries for one tenant, common list/summary queries should target p95 under one second in staging at modest concurrency, with indexes and scan counts reported. Frontend should remain usable at 360px width and with keyboard-only input. Target WCAG AA contrast/focus/error handling. [S32]

Sync completes under an operator-defined budget, not an unbounded latency promise. Capture request CPU, peak input sizes, D1 rows read/written, queue age, and model latency; a remote model’s waiting time is not Worker CPU time. Treat the Free plan as a measured compatibility target, not an architectural guarantee.

## Review and completion evidence

The implementer provides: task ID; acceptance cases; RED command and failure summary; GREEN commands/outcomes; changed files; schema/API/privacy effects; known limitations; and test artifacts. The QA role validates independently in an isolated worktree when available. The principal reviewer inspects the actual diff and evidence, not just a generated summary.

Severity: P0 data leak/unauthorized access/financial corruption; P1 reproducible correctness/security/reliability defect; P2 maintainability or edge-case issue with bounded impact; P3 minor style/documentation. No open P0/P1 at milestone completion. Do not bury critical findings below praise or style comments.

Read-only review adapters may not execute shell commands; use an independent QA executor for test evidence. If the harness cannot provide independent roles, label the review as self-review and do not claim otherwise. A separate review context reduces blind spots but is not proof the review is correct.

## Presentation and activation quality gates (v1.1)

The UI is incorrect if its claims, counts, or controls disagree with capabilities and financial state, even when typecheck and visual snapshots pass. Add component tests for every copy/state combination, state-projection tests, and Playwright paths covering sample isolation, identity/mailbox separation, explicit Start guards, denial/retry, refresh, two-tab Start, partial history, no results, budgets, and source/archive unavailability.

Check preview/mobile/keyboard layouts with synthetic data and reviewable screenshots; test provider callback focus and restrained progress announcements. No automatic redirection when the first result arrives while the user is reading. Validate schema/copy-key parity and run static secret/content checks on bundled examples.

TDD must cover the recent/older boundary exactly, including DST/month-end/clamped ranges and replay overlap with live sync. No test may weaken consent, financial inclusion or tenant boundaries to hit a time-to-first-result goal. Performance targets and pilot activation percentages are unproven goals; record actual measurements and failures separately from release test results.
