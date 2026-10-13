# T19 bounded purchase FX reader — 2026-10-13

Status: root-brokered native GREEN; final typecheck and independent review pending. This is a bounded FX-01–05 adapter increment, not full T19. FX runtime remains disabled; Worker routes, shared DTOs and export encoder adoption remain root-owned work.

Writer `/root/fx_report_writer` owns only new `packages/adapters/src/fx/purchase-reporting.ts`, new `apps/worker/test/fx-purchase-reporting.test.ts` and this report. Existing modules were read but not edited.

The reader accepts a trusted `TenantContext`, internal `beginRead` snapshot and up to 500 unique selected purchase IDs. Tenant SQL authority comes from the context, never the snapshot actor or token. IDs bind through one `json_each` value; matching uses established purchase `conditions`, event `matchesPeriod` and persisted `decodeFxValuation`. A single joined SELECT admits at most 2,000 eligible period events plus an overflow sentinel. Overflow raises `FX_REPORT_READ_LIMIT` before decoding/reduction; there is no truncated subtotal. Invalid inputs raise `INVALID_FX_INPUT`; corrupt snapshots or SQL failures raise sanitized `FX_REPORT_UNAVAILABLE`.

The result contains exact decimal-string per-purchase summaries, selected-purchase aggregate coverage and event identity/version with pending or validated valuation results. Each rounded payment/refund contributes independently through BigInt reduction; original amounts and dated public rate provenance remain available. Zero-event selected purchases receive explicit empty reporting summaries. Missing/mismatched valuations stay pending; validated unconverted valuations retain closed reasons. No provider lookup, revaluation, signing issuance, persistence, schema or infrastructure is introduced.

## Evidence

- Root confirmed deliberate-stub behavioral RED: 10 failures and 1 pass across 11 cases, exit 1, duration 2.02 seconds. `/tmp/invoxim-fx-purchase-reporting-red.txt` was inspected; failures are the missing `FX_REPORT_UNAVAILABLE` implementation, not setup/import failure. The corrupt-value unavailable oracle already passes against the stub and is not counted as missing behavior evidence.
- Root ran `pnpm --filter @invoxim/worker exec vitest run test/drive-archive-job.test.ts test/onboarding-provider-readiness.test.ts test/fx-purchase-reporting.test.ts test/fx-period.test.ts`: exit 0, 28 tests across four files passed, duration 8.68 seconds. `/tmp/invoxim-m1-composition-green.txt` was inspected and root confirms all eleven new reader cases passed. This also includes existing period regression and adjacent root-owned composition checks; the writer did not execute those checks.
- Final typecheck, broader regression/build/full verification and independent review are pending root-brokered evidence. An earlier passing global typecheck preceded the final helper change and is not treated as final-source evidence.
- Writer ran `pnpm exec prettier --write packages/adapters/src/fx/purchase-reporting.ts apps/worker/test/fx-purchase-reporting.test.ts`: exit 0. Subsequent source formatting also exited 0.
- Writer ran `pnpm exec biome check packages/adapters/src/fx/purchase-reporting.ts apps/worker/test/fx-purchase-reporting.test.ts`: exit 0, two files checked with no fixes applied.
- Writer ran `pnpm exec eslint packages/adapters/src/fx/purchase-reporting.ts apps/worker/test/fx-purchase-reporting.test.ts`: exit 0 after fixing unused arguments in the deliberate stub; implementation also passes.
- Writer ran `git diff --check -- packages/adapters/src/fx/purchase-reporting.ts apps/worker/test/fx-purchase-reporting.test.ts`: exit 0.

Eleven passing synthetic native fixtures cover half-minor payment/refund rounding at distinct historical dates, explicit pending/missing coverage and zero-event purchases, selection equality, tenant scoping, one bulk statement between fences, caller rejection after a financial mutation, stale original snapshots, corrupt stored amounts, the exact 2,000-event boundary with totals above the JS safe-integer limit, explicit 2,001-event overflow and 500-ID JSON binding/501-ID input rejection. Their execution is root-brokered; this writer launched no native/heavy/browser/remote checks.

## Caller requirements and limitations

The caller must obtain the snapshot with `beginRead`, reserve the final fence statement and discard the entire result if `assertCurrent` fails. This reader does not authenticate the snapshot, create a database snapshot or certify a multi-query route on its own. It uses one statement, making begin + bulk + final three statements; list/export metadata work and settlement headroom remain caller responsibilities.

The aggregate covers only the selected purchase IDs. It is a whole-period summary only when the caller proves its bounded export contains the complete purchase selection. An input ID that has no qualifying owned events receives a zero summary; the reader does not certify purchase existence or authorize disclosing purchase metadata. Root uses already owned selected rows to establish those facts.

The 2,000-event combined limit preserves existing bounded export capacity but is stricter than the existing list reader's potential per-purchase lifecycle-event envelope. Dense list reporting must fail explicitly rather than silently narrow filters or return zeros. Native timing/statement evidence does not certify deployed CPU headroom for worst-case quoted event counts. No route/export equality, frontend continuation, preference-driven queued revaluation, live provider quality, deployment activation or full T19 claim is made.

Canonical rules and money/backend/D1 skills were read earlier in the assignment. Context7 tools are unavailable in this session; this increment reuses local schema, JSON1 and D1 patterns already present in the repository.
