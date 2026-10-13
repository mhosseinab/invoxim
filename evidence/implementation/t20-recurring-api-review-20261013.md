# Independent T20 recurring API increment review

Task: bounded user-selected recurring API increment and actual Worker composition. Reviewer: separate standalone QA agent. Decision: approve the reviewed increment; no blocking source findings. This does not mark T20 or the full MVP complete and does not establish deployed behavior.

## Scope and identity

Reviewed current uncommitted source/diff for `packages/adapters/src/recurring/service.ts`, `packages/contracts/src/recurring-api.ts`, `apps/worker/src/recurring-routes.ts`, `apps/worker/test/recurring-routes.test.ts`, and final composition changes in `apps/worker/src/index.ts`, `packages/adapters/src/index.ts`, and `apps/worker/CONFIGURATION.md`.

Only this report was written by the reviewer. No production code, fixtures, tests, deployment, native browser or heavy test process was changed or launched.

## Findings and assessment

No P0/P1/P2 findings in the bounded reviewed increment. Prior P3 test-label concern is resolved: API tests now use descriptive T20-API IDs rather than claiming unrelated canonical acceptance cases.

Routes obtain tenant and session identity from the verified profile/session service; request bodies and headers cannot choose tenant authority. Mutations require exact application origin, recent authentication, and an actor/session/purpose-bound recurring token before consuming bounded JSON. Strict schemas reject unknown authority fields, duplicate entry selections and malformed input. Tokens from other purposes, accounts, sessions or expired time windows are tested as rejected.

The supplied database wrapper is shared by authentication and service operations and caps execution at 40 statements. Native request tests cover maximum 20-member creation and maximum 10-record pagination with the outer meter, rather than only a standalone repository budget. SQL parameters remain bounded and tenant-scoped.

List/detail/write/preview responses pass strict response schemas, use no-store responses, cap JSON size, and disclose non-snapshot keyset pages. Automatic suggestions are explicitly unavailable; selection is required. Existing service projections retain unknown pricing and do not fabricate stable automatic identity. Forecasts are estimates and no reviewed recurring operation writes ledger events or calls external providers. Stale evidence has no projection, rejects confirmation and still allows explicit cancellation. The source preserves manual decision version checks.

Actual Worker mounting now precedes the auth fallback. The composition constructs the service only when `RECURRING_ENABLED` exactly equals the string `true`; absence and other values are disabled by source logic. Authentication and database availability remain checked before service creation. The adapter barrel exports the real service. Public recurring capability remains false, and configuration documentation explicitly distinguishes this bounded API from the unfinished UI/discovery/full acceptance work.

## Evidence actually inspected

- `/tmp/invoxim-recurring-routes-green-v1.txt`: native runner output reports 24 tests passing across 3 files, 7.87 seconds; pre-mount API suite evidence.
- `/tmp/invoxim-recurring-mount-red-v1.txt`: two intended Worker-composition failures: enabled request returned 503 rather than 200, and disabled response returned `not_implemented` rather than `recurring_not_configured`. Thirteen other tests were skipped by that focused RED run, not claimed passing.
- `/tmp/invoxim-recurring-mount-green-v1.txt`: unfiltered runner output reports 26 tests passing across 3 files, 7.75 seconds, including actual `worker.fetch` mount tests with synthetic authenticated sessions and real bound D1.
- `/tmp/invoxim-next-typecheck-v7.txt`: 5 successful tasks, 0 cached, 9.008 seconds.

The orchestrator supplied execution and completion status. This reviewer inspected the artifacts; it did not execute those suites or independently capture their process exit codes. Read-only source/diff/artifact commands were executed through `exec_command`. No claimed live Google/provider connection, runtime deployment or real-user data was involved.

## Coverage and remaining gates

The reviewed API tests cover T20-API list, mutations, preview limitations, stale evidence, authorization, input validation, query budgets, configuration and Worker mounting. They are bounded regression IDs. They do not by themselves complete canonical RECUR-01 through RECUR-05 or RECUR-UX-01; month-end/annual recurrence, comparable source pairs, tax/usage variation, resync persistence and full UI acceptance require their own evidence.

Remaining: final repository format/lint/build/regression evidence from its executor, reviewed migration/activation prerequisites, recurring UI, evidence-backed automatic terms/identity/pricing and full T20 acceptance. No deployment or live recurring operation was reviewed. Original deployed login P1 is outside this increment and remains unresolved by this report.

Security/privacy/cost effects: new API access is authenticated and disabled by default; no new credential or processing destination, provider call, ledger charge, public capability claim or real-data artifact is introduced. Activating the flag does not replace server authorization or migration/release gates.
