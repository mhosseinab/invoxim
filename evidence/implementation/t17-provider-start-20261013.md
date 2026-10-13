# T17 provider-aware explicit Start — 2026-10-13

Status: implementation checkpoint under verification; not full T17 completion, live OAuth approval or deployed Outlook processing.

## Scope and contracts

Internal `OnboardingImportSeed` distinguishes actual Gmail history anchors from Outlook folder bootstrap. `OnboardingStartPreparationPort` receives trusted provider/connection/generation and an AbortSignal. Resume passes null preparation state instead of a fabricated empty history anchor.

The adapter captures only Gmail's actual anchor through its existing discovery factory. Outlook preparation returns a bootstrap marker without opening Gmail or making Graph calls. Start's atomic batch retains the consent claim, profile/settings updates, recent-first parent states and initial job. Outlook parent cursors are null; the existing post-consent Outlook runner inventories folders and creates bounded folder children. Gmail's delayed-cutoff catch-up behavior remains unchanged.

Prepared Start carries provider and exact scopes from the owned database connection. The atomic claim compares those snapshots along with connection generation, credential version, active profile/session and AI selection. Provider-specific read-only scopes reuse the established Outlook authorization validator. The configured provider list also gates availability, so an available Gmail runtime cannot advertise Start for a disabled Outlook runtime.

Signed review now binds the mailbox provider and SHA-256 digest of its exact serialized scopes. `prepareStart` requires those values to still match before any preparation or Start writes. Previously issued review tokens without these fields require a fresh review; authorization is not silently broadened.

The onboarding view and processing disclosure both use the configured provider list. A globally ready Gmail runtime cannot enable Start for an unconfigured Outlook connection. Explicit empty provider configuration disables all providers; omitted legacy configuration retains the established Gmail default.

Resume rebinds generation-scoped Outlook children for the accepted run and live synchronization while preserving cursors, page progress and completed states. A unique-key collision must roll back all writes. No state is falsely marked complete or discarded.

## Owned files and integration

Writer owns core onboarding types/service; adapter onboarding read/repository/start/token/view/import-preparation; shared discovery import-plan and its existing Gmail service caller; onboarding unit/native tests and shared QA fixture. Root owns Worker composition/readiness, barrels, release checks, commits and deployment. No schema migration, credentials, provider requests or remote changes were performed by this writer.

Relevant skills read: AI/mail boundaries from earlier task context, OAuth/mail sync, product presentation/onboarding, backend/contracts and D1 data integrity. Canonical rules and task-relevant onboarding/data/API documents informed this checkpoint. No new external API behavior was introduced beyond established adapters.

## Actual verification

- Initial core RED: root-brokered `pnpm --filter @invoxim/core exec vitest run test/onboarding-start-preparation.test.ts`, exit 1, seven behavioral failures. Evidence: `/tmp/invoxim-outlook-start-core-red.txt`.
- Initial native RED: root-brokered `pnpm --filter @invoxim/worker exec vitest run test/onboarding-outlook.test.ts`, exit 1, five behavioral failures; 1.92 s. Evidence: `/tmp/invoxim-outlook-start-native-red.txt`.
- Initial native GREEN trial plus onboarding regressions: exit 1, two failures / 38 passes / 40 cases, 16.92 s. Evidence: `/tmp/invoxim-outlook-start-native-green.txt`. The failures demonstrate the generation rebind did not occur and the collision did not abort; no passing checkpoint is claimed.
- Light local SQLite diagnostic reproduced parameter concatenation: numeric `1.0` forms `outlook:1.0:%`, while string `1` forms the stored `outlook:1:%`. The three generation parameters used to build scope keys are now passed as strings. Numeric authorization-generation comparisons remain unchanged. Native verification of this repair is pending at this report revision.
- Independent reviewer reported signed-review provider/scopes were not bound before preparation. Root-brokered RED for the two new native cases: exit 1, two failures / nine filtered cases, 3.65 s, `/tmp/invoxim-outlook-review-binding-red.txt`. Both cases proved a changed provider or valid scope representation could start unexpectedly. The signed-provider/digest repair is implemented; GREEN and re-review remain pending.
- Final scoped static checks after both repairs: Biome, ESLint and Prettier all exit 0 on thirteen owned code/test files. The earlier import-order and formatting diagnostics were corrected without suppressions.

Subsequent actual results:

- Native GREEN after signed-review and numeric-concatenation repairs: root reported exit 0, 42 tests / four files, 16.18 s, `/tmp/invoxim-outlook-start-native-green-v2.txt`. Core preparation GREEN: seven tests, exit 0, approximately 300 ms.
- Typecheck identified a fixture helper returning `authorizeHourlySync` as widened boolean. The helper now explicitly returns the existing `OnboardingStartRequest` contract; no assertion or schema was weakened. Typecheck rerun remains pending.
- Onboarding-view provider gate RED: root-brokered filtered native test, exit 1, one failure / ten filtered cases, 3.59 s, `/tmp/invoxim-outlook-view-ready-red.txt`. The view previously enabled Start while the provider list contained Gmail only. The view repair is implemented; final native rerun remains pending.
- Scoped static checks after the view and fixture repairs: Biome, ESLint and Prettier all exit 0 on fourteen owned code/test files.

Final root integration: native onboarding suites passed 42 tests / four files in 16.02 seconds, exit 0 (`/tmp/invoxim-outlook-start-native-final.txt`). All five typecheck tasks passed in 8.513 seconds, two cached (`/tmp/invoxim-m1-start-cohort-types-v2.txt`). Root route/barrel Prettier, Biome and ESLint passed. Independent read-only reviewer `outlook_runtime_map` approved the final provider/scope, generation-resume and selected-provider view repairs after inspecting these terminal outputs; the reviewer did not execute tests. Production Outlook processing remains disabled.

## Remaining gates

The bounded Start cases, Gmail onboarding/resume/idempotency regressions, strict types and independent source review pass. Full repository verification, runtime job/pipeline composition, current processing-digest checks at provider boundaries, folder inventory refresh, complete fresh/refresh invocation budgets, UI activation, live Microsoft smoke and deployment remain separate dependencies. This checkpoint does not certify full T17 or the MVP.
