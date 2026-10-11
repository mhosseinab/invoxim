# Decisions and release gates

## Frozen product decisions

Hosted Cloudflare application; multi-user isolation from the first migration; one personal workspace per user; multiple connected inboxes; Google authentication now and Apple later; Gmail then Outlook; OAuth connection UX; default 12-month import; automatic hourly sync and manual sync; AI extraction/categorization with corrections; dashboard and recurring detection; EUR-default multi-currency reporting; optional user-owned Google Drive for originals; no R2; hosted AI plus BYOK; metering without billing; agent-first monorepo and TDD.

Do not reopen these choices because a generated starter template prefers another stack. An actual incompatibility needs a short evidence-backed decision record with the smallest alternative.

## Proposed defaults, not owner commitments

React/Vite, Hono, Better Auth/Drizzle, three mailboxes/user initially, the named category list, exact text/file limits, the job lease implementation, conservative AI caps, the placeholder product name, and the initial monochrome/accessible dashboard treatment are implementation defaults. Adjust within the agreed constraints when tests or verified limitations justify it. Record material changes rather than quietly changing semantics.

No paid external connector is a dependency. No open-source license or public source-code publication is authorized by this package. A future open-source release may improve inspectability but cannot make a hosted operator unable to access data.

## Operator inputs that cannot be invented

| Input | Work possible without it | What remains blocked |
|---|---|---|
| Google OAuth project/client, allowed test identities, verified app/domain settings | Auth/mail adapter contracts and synthetic tests | Real login/mail/Drive smoke tests |
| Microsoft application registration for intended account types and exact callbacks | Graph adapters and protocol fixtures | Real Outlook connection and tenant-policy confirmation |
| Cloudflare account, resource permissions, deployment domain, approved plan | Local workerd tests, schema, UI, worker build | Staging/prod smoke tests and plan-specific cost validation |
| Approved parser and AI provider/model with acceptable data terms and known pricing | Deterministic fixtures, provider interfaces, disabled-state UX | Real extraction evaluation and hosted free allowance |
| Encryption keyring and safe rotation process | Encryption interface/tests with disposable local keys | Real stored credentials |
| Privacy notice, processor terms, support/contact identity, restricted-scope requirements | Draft content, consent screens, technical minimization | Unrestricted public signup and public privacy claims |
| Independent deletion journal/recovery policy | Restore simulation using synthetic markers | Safe production backup restore |

Mark blockers precisely. "Needs Google client secret for live consent test" is useful. "Everything works" based on mocks is not.

## Gate A: implementation can start

T00 confirms the repository state, tool versions, documents, task graph, and relevant current documentation. T01 proves the narrow Cloudflare runtime/dependency choice with synthetic data. No real credentials or external payment is required to start domain/UI work.

## Gate B: private Gmail vertical slice, milestone M0

A real authenticated user is isolated from a second test tenant; two Gmail mailboxes can attach to that user; resumable import and hourly sync work; supported receipt/PDF extraction yields validated structured records; uncertain/unpaid/duplicate documents are not silently counted; corrections survive replay; the simple dashboard matches ledger totals; basic export/disconnect/account deletion work; raw data does not persist in logs/queues/D1; hosted/BYOK selection and budget boundaries exist; the actual runtime smoke test and scoped security review are recorded.

A test-user allowlist is a rollout control, not a single-user architecture. No claim that M0 includes Outlook, full recurring analysis, or all document formats. Unsupported scanned PDFs produce visible review status rather than invented values. M0 is a useful intermediate delivery, not the complete requested MVP.

## Gate C: complete private MVP, milestone M1

M0 plus Outlook folder/delta coverage, optional Drive archiving/backfill, historical FX and missing-rate handling, recurring estimates/price-change review, complete review/edit/merge/exclusion UX, exports/deletion retention handling, capability-tested PDF/image routes, and the release test/evaluation matrix. Complete all M1 task dependencies. A critical feature cannot be crossed out just to finish a weekend.

The synthetic starter fixtures in this package are not the completed evaluation corpus. Expand and execute the documented corpus and holdout plan; record denominators and unsupported cases. Test isolated tenants and account A/B/C consent combinations. Record actual deployed-runtime constraints and costs.

## Gate D: public release, milestone M2

Require owner approval and all applicable OAuth verification/security-assessment requirements, provider user-data rules, model/parser processing terms, consent/privacy disclosures, data-deletion/restore controls, security review, abuse limits, cost caps, operational ownership, and monitored rollback. Gmail restricted-scope and server-processing requirements are externally controlled. [S01, S02, S29] A weekend codebase is not a waiver.

No billing checkout, organization accounts, marketing automation, bank sync, or automatic subscription cancellation is required for M2. Later monetization should build on metering without changing financial record semantics.

## Decision record format

For a material deviation, record: question, agreed constraints, verified evidence/source date, options, smallest recommended change, privacy/cost/quality effect, tests, approval state, and consequences. Do not use a decision record to rubber-stamp a choice after coding it. Unresolved choices use safe defaults and remain visibly blocked where necessary.

## v1.1 presentation/onboarding decisions

Approved adaptation: present purchase records and evidence, not complete personal finance; try-before-authorization synthetic example; compact sign-in/connect/review-start flow; recent-first ordering within the unchanged 12-month import; defer optional Drive and advanced AI configuration; show actual destinations/allowance before processing; keep charts secondary. Add M1 manual Personal / Work / Unassigned tags and evidence-linked recurring comparisons. No replacement brand, price, public launch, or license is selected.

Gate B additionally requires truthful capability-based landing/demo, no real account data in the demo, callback-without-scan proof, recent/older parent import coverage, idempotent explicit Start, readable payment/refund timeline, partial/no-results/paused states, and mobile/keyboard first-use evidence. Drive remains M1 and cannot be a disguised M0 requirement.

Gate C additionally requires optional post-value Drive, comparable recurring-change evidence, consistent manual-use-tag filters/exports, and tested opt-in pilot-measurement controls. T30's worksheet may remain unrun when no actual pilot has occurred; do not fabricate users or make claimed market fit a technical release gate.

Gate D additionally reviews all public copy against current capabilities, actual operator/processor disclosures, and verified claims. No “only free option”, “receipt-only Gmail permission”, zero-knowledge, guaranteed savings, or invented testimonials. Google permission and developer-policy requirements remain external prerequisites. [S01, S04, S44, S45]

Illustrative audience, 30-day prioritization, five-minute first-result target, and small-pilot thresholds are documented design/validation assumptions, not proven market facts or guaranteed performance. Changed copy must not change consent or financial semantics implicitly.
