# T19 bounded FX API checkpoint

Status: page API locally verified and independently reviewed. T19 remains incomplete: full-period aggregation, settings/UI and integrated complete exports remain required. No provider request, migration or deployment occurred.

GET reporting/export and read-only POST page/export use the same canonical service rows, exact signed amounts and explicit page-only summary. POST supports the bounded Unicode cursor without relying on oversized URLs. Revaluation caps at three entries and requires recent authentication, exact origin and an actor/session/purpose-bound `fx-reporting` token. Stale settings return 409; unconfigured/unavailable reference service returns 503. The JSON reader keeps its 4-KiB default, with an explicit validated maximum of 40 KiB for these endpoints.

## Actual evidence

- Route RED: exit 1, one valid signed-session fixture received scaffold 503 instead of 200; `m1-runtime-checkpoints/fx-routes-red-v1.txt`.
- Unmixed GREEN: `pnpm --filter @invoxim/worker exec vitest run test/fx-routes.test.ts test/fx-service.test.ts test/auth-stream-bounds.test.ts test/restore-suppression.test.ts`, exit 0, 31 tests across four files, zero skips, 12.06 seconds; `m1-runtime-checkpoints/fx-restore-green-v1.txt`. Twenty-three tests cover FX/API/auth stream behavior; eight cover the separate restore helper.
- Implementer scoped Biome and Prettier passed. Whole-tree typecheck currently fails in separate in-progress Drive resumable code; `m1-runtime-checkpoints/types-v2-incomplete.txt`. No global typecheck/build/browser/full-MVP passing claim.
- Independent read-only reviewer `/root/discovery_review` approved the bounded page API after examining the route, nine route tests, contract, streaming body helper, dedicated mutation-token purpose and actual native evidence. No reviewer execution or edits.

The Worker composition mounts these routes with validated operator-selected FX configuration and the existing provider-neutral reference reader. That shared runtime change is recorded in a separate integration checkpoint; this commit does not claim whole-period totals or live readiness.
