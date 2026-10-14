# T07 implementation report

Task: T07 durable scheduler/job engine, M0. Status: review; implementation/scoped checks complete, source frozen for independent full verification. Identity: `t07-implementer-source-manifest.txt` records SHA-256 of every owned source file. No commit/deployment was created by this specialist.

Implemented bounded D1 outbox reservations, opaque queue IDs, atomic lease/fence and tenant/global concurrency, deadline/checkpoint cancellation, bounded retries/terminal outcome diagnostics, lost-delivery reconstruction, already-committed source recognition before ACK, active/consented periodic/manual scheduling, cooldown/coalescing, tenant cursor fairness, and invocation statement accounting. Missing handler pauses truthfully. No ingestion, AI budget/settings implementation, provider calls, credentials, infrastructure, deployment, or scheduler UI is claimed.

Owned files: `packages/core/src/jobs/{types,engine}.ts`; `packages/adapters/src/jobs/{store.ts,README.md}`; migration `0006_jobs.sql`; `apps/worker/src/job-runtime.ts`; `apps/worker/test/jobs.test.ts`; this task's implementer evidence. Root owns shared exports, configured Worker entry/routes/bindings, and backlog. QA owns adversarial tests; reviewer remains read-only.

Acceptance exercised in real workerd/D1: JOBS-01–07 and ONBOARD-13, through eight own cases and eighteen independent QA cases. Own cases include populated upgrade/index plans, duplicate claims, false-pause fence ACK, manual cooldown/awaiting-import, lease-bounded uncooperative handler, new periodic job plus cursor, pending tenant followed by cold tenant, and minimum production query budget cancellation/recovery/dispatch. QA's source tests include native queue behavior and actual financial commit before transport crash/replay; independent final copied-snapshot evidence is pending root certification.

## Executed evidence

All Vitest commands set `WRANGLER_LOG_PATH=/tmp/invoxim-t07-wrangler.log WRANGLER_SEND_METRICS=false` and run `pnpm --filter @invoxim/worker exec vitest run` with the listed files.

- `test/jobs.test.ts`: initial actual RED exit 1, one behavioral failure: two simultaneous deliveries yielded two claim owners instead of one. `t07-implementer-red.txt`.
- Same file: actual pause-fence RED exit 1, one pass/one failure: missing-handler finish lost its D1 fence but ACKed. `t07-implementer-red-ack.txt`. GREEN exit 0, two passes: `t07-implementer-green-ack.txt`.
- Same file against preserved pre-fix store: actual pending cursor RED exit 1, six passes/one failure: budget exhausted before advancing processed tenant. `t07-implementer-red-pending-budget.txt`.
- `test/jobs.test.ts test/jobs-adversarial.test.ts`: final GREEN exit 0, 26 passes (8 own/18 QA). `t07-implementer-green-final.txt`. Earlier 21/24-case snapshots remain accurately named interim evidence.
- `pnpm exec prettier --check packages/core/src/jobs packages/adapters/src/jobs apps/worker/src/job-runtime.ts apps/worker/test/jobs.test.ts`: exit 0, `t07-implementer-format.txt`.
- ESLint via package `exec eslint`: adapters `src/jobs`, core `src/jobs`, worker `src/job-runtime.ts test/jobs.test.ts`: all exit 0, `t07-implementer-lint-{adapters,core,worker}.txt`.
- `pnpm --filter @invoxim/{adapters,core,worker} typecheck`, executed separately: all exit 0, `t07-implementer-types-{adapters,core,worker}.txt`.
- `pnpm --filter @invoxim/core build` then adapters build: both configured scripts exit 0, `t07-implementer-build-{core,adapters}.txt`. These package scripts run TypeScript validation; the root/QA full verification owns Worker bundle and frontend/E2E evidence.

Scoped tests discovered D1 rejects six compound SELECT terms. Candidate selection now uses three bounded-ID branches through a partial dispatchable index; temporary debugging preserved the original safe error boundary, and final sources expose no raw database error. No primary-service result is inferred from mocks or local synthetic tests.

## Effects and remaining certification

Migration adds priority/dispatch/manual timing metadata, scheduler/profile recovery cursors, and indexed tenant/lease/consent/pending reads. It adds no user content or new destination. Production budgets 24–40 count actual D1 executions in this module; at 40 stage ceilings are 8/8/14 with 10 reservation headroom, at 24 they are 8/8/4 with 4. One expired lease and two recovery identifiers, one scheduled connection, at most five dispatch tenants/two slots each are processed per invocation. Fresh store per entry is mandatory. These bounds do not prove deployed Free-plan CPU/cost viability. Future provider persistence must account for the rest of the invocation budget. Smaller synthetic budget 16 proves fail-closed dispatch progress but omits full invalid-ready cleanup.

Root confirmed current primary D1 documentation: 50 queries per Free invocation / 1000 Paid. No paid-plan assumption or live resource was introduced. Core ports remain provider-agnostic and Worker bindings remain operator configuration.

Independent reviewer has supplied findings throughout; duplicate send reservation, actionable recovery selection, pending scheduling race, ACK barrier, and cursor headroom were repaired with runtime evidence. Formal frozen re-review, root migration audit, clean full `pnpm verify`, and final cross-task certification remain root/QA work. No additional source changes are planned unless those checks produce a reproducible finding.
