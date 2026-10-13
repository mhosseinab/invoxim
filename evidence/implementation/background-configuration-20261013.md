# Queue and background processing configuration

The owner explicitly requested the missing Queue/background configuration on 13 October 2026. Read-only Wrangler inventory confirmed `invoxim-jobs` and `invoxim-jobs-dlq` already exist with zero producers/consumers. They are reused; no replacement Queue or paid-plan change was created.

`apps/worker/wrangler.jsonc` now declares the `JOBS` producer, main Queue consumer, one-message batches, one concurrent consumer, three broker retries and the existing dead-letter Queue. A minute Cron dispatches durable pending work; the existing D1 `next_sync_at` policy retains hourly recurring mailbox checks. Gmail discovery, extraction and jobs are enabled. Query budget is 40, tenant/global lease concurrency one, dispatch/schedule limits five, three application attempts and five-minute lease/redelivery. AI provider/model/budget remain in the server JSON preset; credentials remain secrets.

Connecting or configuring a mailbox does not start content processing. The user must accept the current account/range/processing disclosure and explicitly Start. The job checkpoint additionally compares its accepted processing metadata with current approved configuration in the existing D1 query. Optional Outlook/Drive flags remain disabled; archive migration `0007` is unnecessary for this Gmail-only activation path and has not been applied remotely.

Context7 was unavailable. Verified pinned Wrangler 4.149.0 CLI/schema and primary [Queue configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/), [Queue limits](https://developers.cloudflare.com/queues/platform/limits/) and [Cron configuration](https://developers.cloudflare.com/workers/configuration/cron-triggers/). Generated binding types successfully to `/tmp/invoxim-background-bindings.d.ts`; no generated credentials or runtime types were published.

## Executed validation

- Job checkpoint RED: `/tmp/invoxim-job-review-checkpoint-red.txt`, exit 1, 11 behavioral failures / two passes / 13 cases, 3.87 seconds. Current settings/digest were not checked before work.
- Checkpoint/jobs regression GREEN: `/tmp/invoxim-job-review-checkpoint-green.txt`, exit 0, 41 tests / four files, 12.96 seconds. Current digest/metadata, tenant/lease/fence, one-statement validation and optional internal compatibility are covered.
- Enabled-configuration readiness/entry/onboarding regression: `/tmp/invoxim-background-configuration-native.txt`, exit 0, 43 tests / five files, 19.01 seconds. No real provider credentials or content were used.
- Scoped Prettier, Biome and ESLint passed. Typecheck: `/tmp/invoxim-background-types-check.txt`, exit 0, all five tasks successful, three cached, 7.807 seconds.
- Independent read-only reviewer `outlook_runtime_map` approved the bounded configuration/checkpoint increment after inspecting source and terminal evidence; the reviewer did not execute tests or live calls.

Full frozen-source validation and deployment remain pending at this report revision. Wrangler authentication became unavailable during secret-name preflight; retry with ordinary authenticated CLI access also failed. The owner was asked to restore login locally, never to disclose tokens. No background activation, content read, model call or remote migration has occurred during this increment.
