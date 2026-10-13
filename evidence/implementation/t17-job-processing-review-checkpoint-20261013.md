# T17 current processing review checkpoint

The existing JobStore.checkpoint protected tenant ownership, lease owner/fence, expiry, connection generation, profile state and active background consent. It did not compare the accepted processing digest with the current runtime processor configuration. Outlook discovery control therefore could reach provider work after an operator changed that configuration without changing stored AI revision.

The checkpoint now projects the same processing-selection metadata shape used by onboarding recovery in its existing database statement. Correlated tenant, connection and consent joins require active AI settings and agreement with consent revision, destination and disclosure. Strict validation and the configured pure resolver must yield the accepted digest. Missing/invalid metadata, null/different resolver output and resolver exceptions deny the checkpoint. Errors carry no raw processor or credential content into logs. Database failures retain their existing handling. Stores without a resolver retain internal fixture compatibility; production Worker configuration remains the root's responsibility.

## Evidence

- RED brokered by root: `pnpm --filter @invoxim/worker test:integration test/jobs-processing-review.test.ts`; exit 1, 11 failed / 2 passed / 13 cases, 3.87 seconds. `/tmp/invoxim-job-review-checkpoint-red.txt`. Expected failures included resolver not called and stale processor digest allowed.
- Light static check: `node_modules/.bin/biome check --write packages/adapters/src/jobs/store.ts apps/worker/test/jobs-processing-review.test.ts`; exit 0, two files checked, 16ms, one fixture formatted.
- GREEN and jobs regressions pending root broker: `pnpm --filter @invoxim/worker test:integration test/jobs-processing-review.test.ts test/jobs.test.ts test/jobs-adversarial.test.ts test/job-entry.test.ts`.

The native fixtures exercise valid review with one physical statement, changed endpoint while AI revision stays unchanged, missing/mismatched accepted digest, missing/deleted/invalid AI selection, changed revision, null/throw/different-digest resolver, exact tenant/job/lease/fence denial and resolver-free fixture compatibility. Only synthetic data is used.

## Scope and operational effects

One physical D1 statement remains one per checkpoint, including current processing review. The pure resolver performs no provider HTTP and reads no credential value. No job lease provider metadata, provider dispatch, queue configuration, runtime activation, deployment or migration changed. Outlook runtime composition and fresh/refresh whole-invocation budget evidence remain separate required integration work. No live provider behavior is claimed.
