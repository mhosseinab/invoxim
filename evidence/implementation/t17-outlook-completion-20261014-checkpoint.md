# T17 connected Outlook runtime checkpoint — 2026-10-14

Status: review / local implementation in progress. Parent owns Git commits, backlog, final integration and independent review. No deployment, live OAuth, remote migration or paid model request was performed. Source began at 9f6ee63; parent subsequently committed the disjoint UI increment.

## Implemented path

The actual Worker uses the owned connection's provider to compose Gmail or Outlook discovery and transient content into the existing mandatory Clef and selected financial extraction pipeline. One validated provider-readiness set powers public and authenticated onboarding capabilities. Authorization alone is insufficient; jobs with the 40-statement policy, extraction, classification configuration/binding and the provider's discovery flag must all be ready. Outlook remains default-off; no production Wrangler activation changed. Explicit processing review/Start seeds recent-first Outlook discovery without Graph content requests or a Gmail history anchor.

Outlook inventory, exclusions, per-folder discovery/delta and credential factories are connected. The production Graph factory requests page size one to leave room for actual lease checks and idempotent source writes within the same physical 40-statement D1 budget; default isolated protocol readers retain their existing page-size-five behavior. Opaque continuations remain unchanged. Fresh hourly sync cycles refresh recursive inventory. Temporary query headroom shortages cause finite ordinary job retry, allowing persisted refreshed credentials to be used in the next invocation rather than permanently pausing budget.

The financial and classification minimum of 23 remaining statements and repository settlement headroom of two remain unchanged. Three redundant preparation reads were removed: pipeline load already authorizes the full owned lease/source/processing digest; metered classification/inference authorize the full lease/selection before model calls; initial AI selection already loaded settings, and still checks consent. Actual financial transport still reloads both settings and consent. Outlook content performs a current accepted-processing checkpoint before every Graph content request; pure transient decoding/return needs no extra query. Every document/financial write retains the repository fence. Refresh retains its post-await cancellation and identity checks.

## Executed evidence

- Initial RED: `pnpm --filter @invoxim/worker test:integration test/outlook-runtime.test.ts`, exit 1, two intended failures (public Outlook absent, explicit Start unavailable), `/tmp/t17-runtime-red.txt`. Wrangler attempted a read-only home log path; the tests themselves ran. Subsequent runs set a writable log path.
- Connected budget RED: `WRANGLER_LOG_PATH=/tmp/t17-wrangler.log WRANGLER_SEND_METRICS=false pnpm --filter @invoxim/worker test:integration test/outlook-runtime.test.ts`, exit 1, `/tmp/t17-runtime-chain-red.txt`, `/tmp/t17-runtime-chain-diagnostic.txt`, `/tmp/t17-headroom.txt`: actual cold refresh exhausted SQL; warm refresh paused; cached-classification financial work repeatedly lacked reserved headroom. Periodic-inventory RED is recorded in `/tmp/t17-failurematrix-red.txt` (17 cases, 11 failed / 6 passed; some failures were fixture drain/cooldown defects later corrected).
- Connected runtime GREEN: same environment/command, exit 0, 17 tests passed, `/tmp/t17-connected-runtime-green.txt`.
- Checkpoint GREEN: `WRANGLER_LOG_PATH=/tmp/t17-wrangler.log WRANGLER_SEND_METRICS=false pnpm --filter @invoxim/worker test:integration test/outlook-runtime.test.ts test/outlook-content.test.ts test/outlook-factories.test.ts test/outlook-job.test.ts`, exit 0, 87 tests passed, `/tmp/t17-checkpoint-green.txt`.
- `pnpm --filter @invoxim/worker typecheck`, exit 0, `/tmp/t17-checkpoint-types.txt`.
- Focused ESLint on all 14 changed TypeScript files: exit 0, `/tmp/t17-checkpoint-lint.txt`. Initial unused test import was corrected.
- Prettier write on those same owned files: exit 0, `/tmp/t17-format.txt` and `/tmp/t17-checkpoint-format.txt`.
- Broader nine-file regression before the periodic fixture correction: exit 1, 190 passed / one periodic fixture failure; `/tmp/t17-connected-regression1.txt`. This is not a passing regression certificate; the four-file checkpoint was run afterward.

The actual Worker tests cover source staging, Clef before financial extraction, exact unpaid invoice purchase data with no payment ledger entry, cold/warm refresh, scope/destination readiness, no pre-Start HTTP, content response revocation/settings/digest/generation/disconnect barriers, known/missing usage, outage/timeout/refusal/rate-limit outcomes, and repeated hourly inventory refresh. Every request/queue invocation uses the actual shared physical D1 counter and asserts no more than 40 executed statements. Synthetic retries advance only durable retry dispatch time; caps/attempt counts were not raised.

## Remaining evidence and limitations

Broad Gmail/BYOK/AI/adversarial regression, late cached-path settings/fence races, additional opaque-page runtime evidence, final format/lint/type/build/full verify and independent review remain to be completed after this recoverable checkpoint. No live account-type/provider policy or deployed behavior is claimed.

Outlook review-source inspection is still an explicit gap: the existing on-demand review header reader and route are Gmail-only. Discovery stores references, not raw subject/body; successful local import does not prove Outlook subject/sender/original inspection. No schema extension or source-inspection subsystem was added in this checkpoint. Parent is deciding the smallest necessary follow-up.

Context7 tool discovery returned no configured tools. Official Microsoft delta-query/immutable-ID docs and Cloudflare D1 limits were read as the approved fallback: https://learn.microsoft.com/en-us/graph/delta-query-messages ; https://learn.microsoft.com/en-us/graph/outlook-immutable-id ; https://developers.cloudflare.com/d1/platform/limits/ . Installed Cloudflare types were used for Queue metadata response shapes. No dependencies, migrations, identity permission scopes or persisted raw-data destinations changed.

## Parent checkpoint integration

Parent independently reran the four focused files: exit0, 87 tests in18.21s, /tmp/invoxim-t17-parent-checkpoint.log; adapter typecheck also exit0. Parent Biome initially found eight findings (imports and four test non-null assertions). The implementer replaced assertions with explicit fixture guards and fixed imports; parent reran all14changed TypeScript paths with --error-on-warnings: exit0, no findings. Implementer final Worker typecheck, ESLint and Prettier passed. Broader13file Gmail/BYOK/AI/pipeline/Clef regression subsequently passed244tests, exit0, /tmp/t17-broad-regression2.txt. Counts overlap, so are not added together. Late cached-path race evidence, metadata follow-up and full integration gate remain pending.

Independent read-only reviewer rejected a proposed financial20/reserve1 shortcut: late settings/fence changes can require three engine-settlement reads/writes. That proposal was not implemented. Reviewer found no new authority gap in the actual three duplicate preparation-read removals, but final approval is conditional on the requested adversarial evidence. No reviewer test execution is claimed.
