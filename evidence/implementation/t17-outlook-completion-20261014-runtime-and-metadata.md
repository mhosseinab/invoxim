# T17 connected runtime, recurring sync and source metadata

Task: T17 / M1. Status: **review**. Runtime checkpoint is 092bfa9; this follow-up is awaiting parent commit and final independent review/full integration. Parent owns Git, backlog, frontend, disconnect management and release documentation. Live acceptance is not established.

## Implemented behavior

The connected Worker path includes Outlook authorization/readiness, explicit consent-bound recent-first Start, recursive inventory, per-folder message discovery/delta, immutable source identities, transient parsing, mandatory per-document Clef, selected provider-neutral financial extraction and idempotent source/purchase persistence. It retains the original full approved range. Public/onboarding readiness share the same complete processing prerequisites; production Outlook activation stays off.

The independent review of 092bfa9 identified a P1 in recurring sync: resetting the inventory parent to queued left existing folder delta states idle, so later rounds refreshed folders without polling them. A new real Worker RED test observed one delta request across three hourly rounds. The atomic, tenant/lease/consent-fenced inventory refresh now queues existing idle live children while preserving their exact opaque history cursors. The GREEN test observes the second and third exact saved delta URLs and three distinct source/purchase records. A separate runtime case adds a new folder and nested child after the initial cycle, follows its unchanged encoded inventory continuation, and proves both durable folder presence and live delta cursors.

Explicit source inspection now selects the provider from the authenticated tenant's owned review/source connection. Outlook returns transient subject, sender and attachment metadata through fixed Graph URLs with `$select=id,subject,from` and `$select=id,name,contentType,size`. It never requests body, preview, MIME, contentBytes or webLink. It uses the existing bounded Graph transport: manual redirects, immutable-ID preference, finite requests, 64 KiB per-response cap and deadlines. More than eight attachments, duplicate identities, pagination or malformed responses produce typed source_unavailable rather than silent truncation. Unsolicited fields are discarded. Subject/sender/attachment names are not persisted; Outlook originalUrl remains null.

The reader validates read-only Outlook scopes and independently rechecks owned source, consent, generation and expected credential version before both Graph requests and after the final response. Wrong tenant/provider, disabled Outlook configuration, missing/revoked/broad scopes, credential rotation, unavailable source, redirects and oversize responses cannot fall back to Gmail.

## Evidence actually executed

RED:

- `WRANGLER_LOG_PATH=/tmp/t17-wrangler.log WRANGLER_SEND_METRICS=false pnpm --filter @invoxim/worker test:integration test/outlook-runtime.test.ts`: exit **1**, 17 passed / one intended recurring-sync failure; `/tmp/t17-hourly-existing-red.txt`. Expected three delta requests, observed one.
- Same environment, `pnpm --filter @invoxim/worker test:integration test/outlook-review-source.test.ts`: exit **1**, 15 failed / four passed; `/tmp/t17-metadata-red.txt`. Outlook source inspection returned not_found through the Gmail-only reader. Some initial negative fixtures were subsequently corrected to use truly foreign review identities; these corrections are not implementation RED evidence.

GREEN / regression:

- Same environment, `pnpm --filter @invoxim/worker test:integration test/outlook-runtime.test.ts test/outlook-review-source.test.ts test/review-source.test.ts`: exit **0**, 50 tests; `/tmp/t17-hourly-metadata-green1.txt`.
- Same three files after actual new-folder runtime addition and route composition: exit **0**, 51 tests; `/tmp/t17-source-hourly-green2.txt`.
- Same environment, `pnpm --filter @invoxim/worker test:integration test/outlook-runtime.test.ts test/outlook-review-source.test.ts test/review-source.test.ts test/ai-selection-races.test.ts`: exit **0**, 68 tests; `/tmp/t17-metadata-races-green1.txt`.
- Final focused run, same environment: `pnpm --filter @invoxim/worker test:integration test/outlook-runtime.test.ts test/outlook-review-source.test.ts test/review-source.test.ts test/ai-selection-races.test.ts test/outlook-job.test.ts test/outlook-state.test.ts test/outlook-factories.test.ts test/pipeline-adversarial.test.ts test/clef-pipeline.test.ts test/ai-adversarial.test.ts test/ai.test.ts`: exit **0**, **245 tests / 11 files**, `/tmp/t17-final-focused.txt` (59.16 seconds).
- Before the follow-up, the connected checkpoint broad Gmail/BYOK/AI/processing-review regression passed **244 tests / 13 files**, exit **0**, `/tmp/t17-broad-regression2.txt`. Overlapping test runs are not added together as unique coverage.
- `pnpm --filter @invoxim/worker typecheck`: exit **0**, `/tmp/t17-final-types.txt`.
- `pnpm exec biome check` on the eight follow-up TypeScript files with `--error-on-warnings`: exit **0**, `/tmp/t17-final-biome.txt`.
- `pnpm exec eslint` on the same eight TypeScript files: exit **0**, `/tmp/t17-final-lint.txt`.
- `pnpm exec prettier --check` on those eight files plus `apps/worker/CONFIGURATION.md`: exit **0**, `/tmp/t17-final-format-check.txt`.

The eight TypeScript paths are Worker purchase-routes.ts, tests outlook-runtime.test.ts / outlook-review-source.test.ts / ai-selection-races.test.ts, and adapter discovery/outlook-state.ts / discovery/outlook-transport.ts / purchase-views/review-source.ts / purchase-views/outlook-review-metadata.ts. Prettier writes and the initial implicit-any annotation repair are recorded in `/tmp/t17-next-format.txt`, `/tmp/t17-metadata-biome1.txt` and `/tmp/t17-metadata-biome2.txt`; no lint rule was disabled.

Actual runtime tests meter the same physical D1 handle across job acquisition, provider opening/refresh, content/classification/inference and settlement, asserting at most 40 statements per invocation. Financial/classification headroom remains 23; repository settlement reserve remains two. Known/missing usage, refusal, timeout/outage and rate-limit cases preserve bounded settlement. Additional cached-classification content barriers, late financial settings/digest/lease/revocation barriers and BYOK decrypt races prove no unauthorized network/cache/continuation/financial writes. The existing source, tenant, stale lease and BYOK tests were actually rerun; this is not a self-review described as independent validation.

## Acceptance and effects

OUTLOOK-01: synthetic personal/work authorization protocols remain separate from Google login; real Worker readiness/Start, refresh, refusal/scope/identity and metadata boundaries are exercised. OUTLOOK-02: recursive new/nested/archive folders and repeated hourly processing are covered. OUTLOOK-03: exact encoded folder and per-folder delta continuations are preserved. OUTLOOK-04: immutable source identities and existing move/replay idempotency cases pass. OUTLOOK-05: durable folder-delta reset/rate/recovery cases pass in outlook-job tests. Live personal/work accounts and policy behavior require separate smoke evidence.

No dependency, schema/migration, permission scope, secret, production Wrangler setting or raw-storage destination changed. Metadata is transient. One-item production Graph pages trade throughput/queue operations for measured bounded SQL; neither page-size changes nor retries narrow the approved historical range. Retry attempts/caps are unchanged.

Context7 discovery exposed no tools. Official Microsoft message-get/list-attachments documentation was read for the metadata extension, alongside the earlier delta/immutable-ID and Cloudflare D1 docs. Installed Cloudflare types were used for local runtime seams. Sources: https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0 ; https://learn.microsoft.com/en-us/graph/api/message-list-attachments?view=graph-rest-1.0 .

## Remaining gates

Parent is implementing/verifying provider-neutral local Outlook disconnect separately. Parent owns final full `pnpm verify`, build/E2E integration, independent review recording, current backlog/docs and checkpoint commits. Those outcomes are not claimed here. No live OAuth/provider connection, real-message read, real-model quality evaluation, paid call, cloud write, deployment or remote migration was performed.

Operator prerequisites remain approved Microsoft application registration/redirect, configured keyring/secrets, authorized personal/work test identities, tenant/admin-consent policy checks, moved/deleted-folder/cursor expiry and token rotation/revocation smoke, and deployed binding/queue/limit verification. Public rollout stays gated. Outlook original-email deep links are not implemented; source metadata is available and originalUrl is truthfully null. Deleted/inaccessible source/folder behavior cannot guarantee recovery of unarchived mail. Full M1/MVP and live release acceptance remain separate from this local connector report.
