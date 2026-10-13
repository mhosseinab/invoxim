# T19 bounded report read fence — 2026-10-13

Status: focused native acceptance/regression and typecheck GREEN; independent read-only review approved with no actionable finding. Broader integration remains outside this seam. This is a bounded FX-05 increment; full T19 remains incomplete and source FX runtime remains disabled.

Writer `/root/fx_report_writer` owns `packages/adapters/src/fx/period.ts` and this report. Independent QA `/root/fx_period_acceptance_qa` owns the new `apps/worker/test/fx-report-read.test.ts`. Root owns routes/contracts/purchase views/export integration and brokers native tests, build/browser verification and remote actions.

The service adds `beginRead(context, { filters, actorKey, stamp })` and `assertCurrent(context, snapshot)`. Both reverify the existing authenticated period stamp, trusted tenant/session scope, canonical filters, conversion policy and expiry. Begin returns an internal readonly snapshot derived from the signed stamp; final assertion checks its currency against signed profile data. Forged/malformed snapshot fields raise `INVALID_FX_INPUT`; a changed or inactive current profile returns stale/false. Each method admits one tenant-scoped active-profile SELECT, with no ledger/valuation/rate reads, signing issuance or provider calls. SQL errors retain the existing sanitized unavailable error. Existing period continuation, stamp issuance, traversal, rounding and aggregation behavior remain intact; only time/scope/error validation is extracted for reuse.

## Evidence

- Root executed `pnpm --filter @invoxim/worker exec vitest run test/fx-report-read.test.ts` against deliberately unavailable typed stubs: exit 1, fourteen failures in one file, duration 1.87 seconds. `/tmp/invoxim-fx-report-fence-red.txt` was inspected and confirms failures on the missing seam, rather than setup/import failure.
- Root executed `pnpm --filter @invoxim/worker exec vitest run test/fx-report-read.test.ts test/fx-period.test.ts test/fx-period-routes.test.ts`: terminal 23256 exit 0, thirty tests in three files passed, duration 8.46 seconds. `/tmp/invoxim-fx-report-fence-green.txt` was inspected; root confirms fourteen new fence acceptance cases plus sixteen period/service-route regressions. These use synthetic local native workerd/D1 fixtures, not live provider evidence.
- Writer executed `pnpm exec prettier --write packages/adapters/src/fx/period.ts`: exit 0. Initial formatting check found a wrap difference; it was corrected.
- Writer executed `pnpm exec prettier --check packages/adapters/src/fx/period.ts`: exit 0, all matched files formatted.
- Writer executed `pnpm exec biome check packages/adapters/src/fx/period.ts`: exit 0, one file checked, no fixes applied.
- Writer executed `pnpm exec eslint packages/adapters/src/fx/period.ts`: exit 0.
- Writer executed `git diff --check -- packages/adapters/src/fx/period.ts`: exit 0.
- Root's typecheck (`turbo run typecheck`, as shown in the log) included this source increment: all five tasks successful, four cached, duration 4.778 seconds. `/tmp/invoxim-start-diagnostics-types-green.txt` was inspected and root confirmed the included source scope. This is the root-brokered result, not a writer-executed check.
- Independent read-only reviewer `/root/outlook_runtime_map` approved this seam with no actionable finding, as reported by root. The trusted actor and snapshot must remain internal, and callers must reserve the fence statements; these integration limitations remain applicable.
- Build/full verify/browser checks and broader integration remain root-owned and are not claimed by this seam report. Native acceptance/regression and typecheck results above were brokered by root.

Canonical rules and money/backend/D1 skills were read. Context7 tools are unavailable in this session; implementation reuses existing local schema, signing and D1 APIs without introducing a new dependency surface.

## Effects and exclusions

No schema/migration, storage, credentials, permission, processor, infrastructure, deployment or outbound-cost change. No original bytes or receipt content is retained by this seam. It consumes two profile reads across begin/final fences, leaving the remaining statement budget to the caller's bounded read and settlement operations. It does not mint a report stamp; existing period reads remain the sole issuance path.

The caller supplies the actor binding from a trusted session and keeps the snapshot internal; snapshot fields cannot establish a new caller identity. The caller must reserve one statement for each fence plus any bounded read and settlement work. The seam does not create a database snapshot or make unrelated multi-query reads atomic.

Route/export adoption, list/summary/export equality, preference-driven revaluation, frontend behavior, live FX provider quality and deployment remain outside this writer's scope. No full T19 or production-readiness claim is made.
