# T04 independent database QA

Status: scoped QA passed. Separate QA agent `/root/runtime_qa` authored and executed adversarial tests; the database implementer fixed production defects. The independent source/security reviewer makes a separate approval decision. No QA edits to production, migrations, configuration, manifests, interfaces or backlog were made.

## Source and isolation identity

Final parent-authorized copied synthetic snapshot: `/tmp/invoxim-t04-qa-post-barrier-917l8rhi/source`; 84 files, including all three SQL migrations, opaque core TenantContext, adapters, root manifests/lock, local D1 harness and both database suites. Ordered SHA-256 manifest identity: `55b9f0d8b375e9c6a186b661c85f2754a92c5a324d599ed10dc2fd1bf8ef81d7`. [Per-file manifest](t04-qa-final-snapshot.txt); [comparison](t04-qa-source-match.txt) confirms zero differences from frozen writer sources after execution.

Dependencies/generated outputs were excluded before fresh installation. This is an approved `/tmp` copy, not a Git worktree or commit snapshot; it does not certify OS sandbox isolation. No source in the writer checkout was exercised by this final run. Workerd isolates are real local D1 test environments, not generic SQLite mocks or remote D1.

## Actual final commands and results

Run from the final snapshot:

```sh
pnpm install --frozen-lockfile
CI=true WRANGLER_LOG_PATH=/tmp/invoxim-t04-qa-post-barrier-917l8rhi/wrangler.log PLAYWRIGHT_BROWSERS_PATH=/tmp/invoxim-playwright-browsers TURBO_TELEMETRY_DISABLED=1 WRANGLER_SEND_METRICS=false pnpm verify
CI=true WRANGLER_LOG_PATH=/tmp/invoxim-t04-qa-post-barrier-917l8rhi/wrangler.log WRANGLER_SEND_METRICS=false pnpm db:check
```

All exited **0**. Evidence: [frozen install](t04-qa-final-install.txt), [full verification](t04-qa-final-verify.txt), [standalone DB gate](t04-qa-final-db-check.txt).

Fresh full verification passed **117 tests**: 7 boundary/tooling, 39 core, 39 contracts, 25 workerd (20 database plus 5 existing transport/public-config), 7 Playwright. The three core properties execute an additional 1,500 generated cases, included within 39 core tests: seeds 20261011/20261012/20261013, 500 each. All five package typechecks, formatting, ESLint and boundary checks passed. Core/contracts/adapters builds executed freshly as prerequisites and their logs were cached later within this command; their test runs were fresh. Frontend build, Pages Function compilation and Worker bundle dry-run executed freshly. Remote caching was disabled; no remote CI or deployment execution is claimed. Standalone `db:check` independently reran the two database files and passed 20/20, with two actual workerd isolates.

Fresh frozen installation succeeded with committed ignoreScripts policy and no script approval, policy bypass or command override. The parent-reported stale existing-checkout esbuild/workerd build-policy failure was not reproduced by this clean final install.

## Acceptance and invariant coverage

- **DB-01:** real composite D1 foreign keys reject tenant-A purchase/evidence association with tenant-B observation, cross-tenant document/source parent insertion, and ledger/evidence parent substitution. Hostile attempted changes preserve original joined evidence. Observation JSON rejects missing/wrong-type schema version and unapproved retained transcript field.
- **DB-02:** concurrent promises against real D1 reuse one canonical tenant/message/part/observation identity and one payment; replay after completion is stale. The same natural source/event identity can exist independently in another tenant. Distinct concurrent sources with identical purchase/event facts cannot duplicate a payment. A different-purchase event replay rejects one commit and rolls back its phantom source/purchase.
- **DB-03:** migrations install on empty local D1; the implementer fixture populates the first application version before applying the scheduling/index upgrade. Tests preserve existing null amount, record/source data, default awaiting-import scheduling and discovered direct-SQL documents; actual EXPLAIN assertions select purchases_tenant_date and ledger_tenant_currency_id; PRAGMA foreign_key_check is empty. This exercises SQL migration behavior, not Wrangler production migration tracking or a real historic deployment upgrade.
- **DB-04:** every repository operation receives a synthetic opaque context. Hostile victim IDs cannot list/read joined detail/update/delete another tenant’s purchase or commit another tenant’s job; victim detail remains equal. This is repository scoping proof, not session authentication. Exact reporting returns `9018000000000000` from 1,002 entries of 9,000,000,000,000 minor units, above JavaScript safe integer; another tenant receives zero. Refund-only USD reporting yields net `-1200`; over-bound entry insertion rejects. Unknown total/currency remain null.
- **Atomicity/fences:** a late second-ledger primary-key failure rolls back earlier source/document/observation/purchase/ledger writes and leaves the job leased; original accepted entry remains. Invalid lease, stale fence, expired lease, changed connection generation, revoked/future/non-background consent return stale without durable financial/source results. This tests the exposed commit primitive, not a lease-claim/reassignment dispatcher.
- **Immutable financial boundaries:** reused event key with changed amount, changed source-part hash, changed normalized merchant under the same fingerprint, or an existing purchase’s changed total/currency/date/payment state all reject with COMMIT_CONFLICT and preserve canonical results. Exact financial replay after a manual merchant edit succeeds while preserving merchant/version 2. Existing needs_review observation rejects a new ledger event and leaves review/job/original ledger state intact.
- **Lifecycle:** accepted fenced commit produces source processing_status processed and document parse_state extracted; direct discovered rows retain discovered defaults. The shared primitive does not imply a complete extraction/reconciliation workflow.

QA-owned [database-adversarial.test.ts](../../apps/worker/test/database-adversarial.test.ts) has 14 tests; implementer-owned database.test.ts has six. The latter was inspected and independently executed rather than rewritten. Existing browser checks passed exact synthetic money/evidence, local-only requests, static sentinel independence, keyboard/reduced-motion/axe and normal/CSS zoom-2 reflow at 360 CSS px. CSS zoom is not native zoom; sentinel storage is not real signed-in cache/logout proof. Unchanged T01 runtime spike was not rerun.

## Actual RED findings and resolution

Independent diagnostic source was copied before each relevant fix. The following failures were returned to the implementer, who repaired production code without QA weakening assertions:

| Evidence | Severity | Actual result | Behavioral failure |
|---|---|---|---|
| t04-qa-diagnostic-red.txt | P1 | exit 1; 6 pass / 2 fail | Changed event amount and same-part content hash both incorrectly committed. |
| t04-qa-diagnostic-red-phantom.txt | P1 | exit 1; 6 pass / 3 fail | Different-purchase concurrent event replay fulfilled both commits. |
| t04-qa-diagnostic-red-observation.txt | P1 | exit 1; 7 pass / 4 fail | Same fingerprint with changed normalized merchant also incorrectly committed. |
| t04-qa-diagnostic-green.txt | resolved | exit 0; 11 pass | Earlier immutable identity fixes independently rechecked. |
| t04-qa-diagnostic-red-status.txt | P2 | exit 1; 10 pass / 1 fail | Completed accepted commit left source/document discovered. |
| t04-qa-diagnostic-red-purchase.txt | P1 | exit 1; 10 pass / 2 fail | New evidence with changed canonical purchase total silently committed; lifecycle failure persisted. |
| t04-qa-red-review-barrier.txt | P1 | exit 1; 13 pass / 1 fail | Existing needs_review observation accepted a new financial event. |

Diagnostic workdirs were `/tmp/invoxim-t04-qa-diagnostic-et2is04f/source` for the diagnostic-prefixed runs and `/tmp/invoxim-t04-qa-final-qhau2yu0/source` for review-barrier RED. Exact diagnostic command was `CI=true WRANGLER_LOG_PATH=<snapshot-parent>/wrangler.log WRANGLER_SEND_METRICS=false pnpm --filter @invoxim/worker exec vitest run test/database-adversarial.test.ts` from the copied snapshot recorded in each Vitest log. Initial clean diagnostic install exited 0; its log is t04-qa-diagnostic-install.txt. The expanded financial tuple and manual-edit positive regression were added after the focused changed-total RED and all variants executed in final GREEN. `t04-qa-pre-barrier-verify.txt` was a genuine earlier full pass, but freeze reopened for the review barrier; it is explicitly not final certification. Its old source/install manifests are retained under the same pre-barrier prefix. Final post-barrier evidence supersedes it.

## Scope, risk and remaining gates

No unresolved reproducible defect remains in the assigned checks. Root/full-MVP release approval is outside this QA decision. Source review, live OAuth/provider/model/Drive, deployment/staging proxy smoke, real account deletion, complete scheduler/reconciliation and future auth composition are separate gates. Test contexts are explicit synthetic casts, not factories for request authority. DB exists only as a local Miniflare test binding for this task; no production resource or provider connection was created. No bytes, real messages, transcripts, credentials or real personal data were uploaded. No migration was applied remotely; Worker build was a dry-run. No cost/Free-plan performance, row-scan volume, CPU/resource viability or live integration claim is made.

QA changes are limited to the assigned adversarial test and t04-qa evidence files. Final browser port 4175 is free. Read [t04-qa-plan.md](t04-qa-plan.md) as the original plan, not a result.
