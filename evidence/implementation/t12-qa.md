# T12 independent QA evidence

Task: T12 extraction-to-ledger pipeline. QA: separate agent from the domain, database and runtime implementers. Status: PASS. Assigned focused tests and the full deterministic gate pass in the approved clean copied snapshot. No Git worktree/commit identity or OS/network sandbox is claimed. Final docs-only closeout remains a separate comparison.

## Write boundary and coverage

Changed only `packages/core/test/ledger-adversarial.test.ts`, `apps/worker/test/pipeline-adversarial.test.ts`, and `evidence/implementation/t12-qa*`. Production fixes were returned to implementers. Other writers' files were not modified.

18 domain tests cover LEDGER-01 through LEDGER-07 and LEDGER-09: order/invoice/receipt evidence equivalence, weak equal transactions preserved, distinct installment identities, revised-invoice conflict with manual category preservation, pending/unknown refunds and credit notes excluded, completed partial refunds with replay, excess/currency conflicts, statement exclusion, gross versus card/store-credit amounts, ambiguous mixed tender, exact/content/strong-event replay, missing event identity review, explicit different-purchase decisions, all six order/invoice/receipt permutations, and gross settlement from explicit redeemed credit with zero cash effect. Expected totals and event counts are independent literal integer oracles.

22 native workerd/D1 tests cover LEDGER-08 plus persistence/runtime integrity: identical evidence across two tenants; actual Gmail credential/content factory, MIME normalization and parser; actual hosted/BYOK AI provider factory and HTTP adapter with synthetic mocked network; native usage reservation/settlement/cache; two MIME documents containing three records; full staged progression and finalization under a fresh shared 40-statement meter per invocation; expired lease, changed generation, revoked consent, changed settings revision, deleting profile and unavailable source; old lease rejected after reassignment with a successful fresh-owner control; a late native trigger failure rolling back observations, purchase, ledger, review and job completion, followed by successful retry and inert replay; forged trusted-tenant context rejected with an authorized control; consent revocation while a model response is in flight preventing cached acceptance and all financial writes; refusal/timeout of document A continuing valid document B while retaining operational review and conservative timeout reservations; ZIP/GIF attachment metadata and operational review alongside a valid receipt; populated legacy observations with null structured fields preserving gross/payment and reviewing revised invoice/conflicting cash identity; live optimistic conflict retrying cached extraction without a second model call; and credit-only/mixed settlement updating an existing unpaid purchase to paid version 2 without mutating gross total.

The source pipeline intentionally spans durable parse/infer/reconcile jobs. Initial local focused output did not forward synthetic per-stage logging. The final CI run does: hosted two-document stages used [15, 33, 23, 33, 22] statements; BYOK stages [15, 35, 23]; refusal and timeout sibling stages [15, 35, 33, 21]. These are observed synthetic cases, not a platform-capacity claim; every invocation asserts the shared 40-statement bound. Each invocation shares one database meter across claim, checkpoints, real factories, inference persistence, reconciliation and completion checks. The two-document positive control requires five successful invocations and exactly two model calls. BYOK requires three successful invocations and one selected-key model call. Assertions measure every invocation at no more than 40 statements; they do not equate multiple stages with one invocation.

## Actually executed commands

- `pnpm --filter @invoxim/core exec vitest run test/ledger-adversarial.test.ts -t LEDGER-01`: exit 1; intended assertion expected one purchase, observed zero from the initial domain stub. `t12-qa-domain-red.txt`.
- `pnpm --filter @invoxim/core exec vitest run test/ledger-adversarial.test.ts`: exit 0; 18 tests passed. `t12-qa-domain-green.txt`.
- `WRANGLER_LOG_PATH=/tmp/invoxim-t12-qa-wrangler pnpm --filter @invoxim/worker exec vitest run test/pipeline-adversarial.test.ts -t 'native full pipeline'`: exit 1; parsed document staging failed with `PIPELINE_UNAVAILABLE` instead of completing. `t12-qa-pipeline-red.txt`.
- `WRANGLER_LOG_PATH=/tmp/invoxim-t12-qa-wrangler pnpm --filter @invoxim/worker exec vitest run test/pipeline-adversarial.test.ts`: latest exit 0; 22 native tests passed. `t12-qa-pipeline-green.txt`.
- `pnpm --filter @invoxim/core typecheck`: observed exit 0.
- `pnpm --filter @invoxim/worker typecheck`: latest exit 0. `t12-qa-typecheck.txt`.
- `pnpm exec eslint packages/core/test/ledger-adversarial.test.ts apps/worker/test/pipeline-adversarial.test.ts`: exit 0. `t12-qa-lint.txt`.
- `pnpm exec prettier --check packages/core/test/ledger-adversarial.test.ts apps/worker/test/pipeline-adversarial.test.ts`: exit 0. `t12-qa-format.txt`.

Initial native invocation emitted a harmless Wrangler log EROFS outside the writable roots; subsequent commands set a writable `/tmp` log path. Intermediate failures included QA fixture mistakes (missing required model choice index/assistant role and insufficient event-reference quote context); these were corrected to match the actual protocol and grounded source evidence, not counted as implementation defects.

## Returned implementation defects

1. Continuation source-mapping SQL had an excess SELECT placeholder: initial parse completed transient fetch/parsing, then staging returned `PIPELINE_UNAVAILABLE`. Database implementer corrected it; the positive control now traverses all stages.
2. Real D1 reconciliation rejected `loadSnapshot` SQL with `Expression tree is too large (maximum depth 100): SQLITE_ERROR`. Database implementer balanced the SQL conjunction grouping while preserving guards; all native cases now pass.
3. Repository metadata mapping violated `exactOptionalPropertyTypes` with `code?: string | undefined`. Database implementer corrected the mapping; worker typecheck now passes.

4. New indexed reconciliation SQL exceeded native D1's compound SELECT limit. `t12-qa-compound-select-red.txt` records the actual error; grouped CTE queries now pass all end-to-end cases.
5. Per-document refusal/timeout terminated the entire source; unsupported ZIP/GIF metadata was rejected at persistence. Four behavioral REDs in `t12-qa-document-red.txt` preceded the implementers' operational review/continuation fixes. All four now pass, including one model call per document and retained uncertain timeout reservation.
6. An external optimistic-version increment could satisfy the final anticipated-version fence while earlier guarded financial statements were skipped. `t12-qa-version-red.txt` records false completion. The database implementer fenced completion on actual guarded projection changes; a subsequent async exception escaped the runtime's returned promise (`t12-qa-version-rejection-red.txt`), corrected by the root implementer's awaited boundary. The native race now returns a typed retry, reloads the cached extraction, and succeeds without a second provider call.

Credit settlement tests were first executed after the domain fix and passed; `t12-qa-settlement-regression-green.txt` is regression GREEN, not manufactured RED. A later native settlement fixture initially returned a string instead of a record; the positive-control assertion identified schema rejection and the fixture was corrected. It is not an implementation defect.

No production edits were made by QA to fix these findings. This report is independent executed QA, not an independent read-only final release review.

## Privacy, cost and remaining gates

Only synthetic users, mail, receipts and keys were used. Every network call was mocked; no live provider connection, deployment, external cost or real-model quality is established. Persistence assertions reject retained quotes/full payment text. Tests create and remove only synthetic local fixtures and an injected local rollback trigger.

## Approved isolated-copy final verification

Snapshot: `/tmp/invoxim-t12-qa-final-9jxg7ws0/source`. Node v24.21.0, pnpm 12.6.0. Inventory contains 226 verification/contract/operator-document inputs and excludes dependencies, generated build/test caches, private env files, evidence and task-status metadata. Full per-file inventory: `t12-qa-final-snapshot.txt`.

Manifest SHA256: `e082739305961074f74f50247af46ca1e971fb9f415677a5738988dce809b4f2`.

| Actually executed final command | Observed result | Evidence |
|---|---|---|
| `pnpm install --frozen-lockfile` | Exit 0; 212 packages reused, zero downloaded; checked-in ignoreScripts policy retained | `t12-qa-frozen-install.txt` |
| `CI=true WRANGLER_LOG_PATH=/tmp/invoxim-t12-qa-final-9jxg7ws0/wrangler.log TURBO_TELEMETRY_DISABLED=1 WRANGLER_SEND_METRICS=false PLAYWRIGHT_BROWSERS_PATH=/tmp/invoxim-playwright-browsers pnpm verify` | Exit 0; boundaries, format, Biome, ESLint, all types/unit/workerd/build/browser gates | `t12-qa-verify.txt` |
| `CI=true WRANGLER_LOG_PATH=/tmp/invoxim-t12-qa-final-9jxg7ws0/wrangler.log TURBO_TELEMETRY_DISABLED=1 WRANGLER_SEND_METRICS=false pnpm db:check` | Exit 0; 40 tests across existing and adversarial DB cases and migration/pipeline cases | `t12-qa-db-check.txt` |
| `python3 /tmp/invoxim-t12-qa-snapshot.py compare` after all tests | Exit 0; zero tested-versus-initial and zero root-versus-tested differences | `t12-qa-source-match.txt` |

The final verify freshly executes **560 distinct tests**: 10 tooling, 45 contracts, 165 core, 333 workerd and 7 browser. The independent QA 18 core/22 workerd cases are included. Explicit db:check repeats 40 of those cases and is not another 40 distinct tests. Three existing money properties use 500 fixed-seed samples each (1,500 samples within the test count). Final suites report no skipped tests.

All five package typechecks, unit suites, workerd suite, frontend build, Worker dry-run build and browser suite execute freshly. Remote caching is disabled. Contract/core/adapter no-emit build tasks first execute during unit verification and later replay their same-run cached logs during integration/build; those hits are not separate executions. Copied non-Git checkout warnings and color/no-output warnings do not indicate deployed CI or missing test execution. Biome checks 169 supported files, no fixes/errors.

Root communicated independent read-only source approval before the freeze; this QA certificate does not impersonate that source reviewer. Live OAuth/provider smoke, model quality, public deployment, CPU/free-plan viability and broader release prerequisites remain separate. Docs-only closeout must preserve the tested executable inputs and receive its own comparison before task closure.

The subsequent approved documentation-only closeout passed independent diff, formatting and hash comparison. See `t12-qa-doc-closeout.md`; the original verified baseline certificate and its initial manifest above remain unchanged.
