# T19 bounded FX reporting service checkpoint

Status: verified service increment; T19 remains incomplete. Native D1 persistence and the consolidated baseline remain authoritative. No migrations, remote calls or deployment performed.

Implemented tenant/profile/filter/policy-bound pagination, exact per-entry conversions and persisted historical snapshots, explicit pending coverage and page-only subtotals. Reporting pages cap at twenty entries; revaluation caps at three. Missing rates remain unconverted. Routes, preferences, full-period totals, exports and UI remain outside this increment.

## Executed evidence

Root ran native workerd through the Worker Vitest configuration with telemetry disabled:

- Initial RED: `vitest run test/fx-service.test.ts test/outlook-coordinator.test.ts`, exit 1, four deliberate stub failures; `m1-service-checkpoints/services-red-v1.txt`.
- Cursor RED: `vitest run test/outlook-coordinator.test.ts test/outlook-content.test.ts test/fx-service.test.ts`, exit 1, six failures including the Unicode cursor regression; `m1-service-checkpoints/content-cursor-red-v1.txt`.
- Final GREEN: `vitest run test/outlook-content.test.ts test/outlook-coordinator.test.ts test/outlook-state.test.ts test/fx-service.test.ts test/fx-repository.test.ts test/fx-reference.test.ts test/operational-metrics.test.ts`, exit 0, 106 tests across seven files, 7.91 seconds, zero skips. Of these, twelve are FX service tests; `m1-service-checkpoints/services-green-v3.txt`.
- `pnpm --filter @invoxim/adapters typecheck`: exit 0; `m1-service-checkpoints/adapters-types-v2.txt`.
- Scoped Biome with `--error-on-warnings`, ESLint and Prettier checks: exit 0. Source whitespace check: exit 0.

Independent read-only reviewer `/root/discovery_review` inspected the service, tests and final log. No required FX findings. The reviewer separately found an Outlook continuation issue; it is outside this FX checkpoint and remains under repair.

Reviewed service SHA-256: `a0f02d263fcce43903f665e37194ca3853a8b96ddb728cfbfc524e57843ba8d7`.
Reviewed test SHA-256: `39216b97cee8b80ebf9094fbeaa7b4b238a8ee0a84738aecf18283b959ac5a72`.

Whole-repository verification, Worker typecheck, build, browser tests and live reference-provider smoke tests are not certification of this increment. They remain required at final integration. Existing frozen restoration certificates are historical evidence.
