# T24 bounded operational observer

Status: helper implementation locally verified and independently reviewed; runtime integration remains pending. T24 is not complete. No deployment, real telemetry destination, restore drill or live cost measurement was performed.

## Scope and behavior

Owned files are `apps/worker/src/operational-metrics.ts` and `apps/worker/test/operational-metrics.test.ts`. Root owns runtime/configuration integration. No persistence, infrastructure, SDK, network transport, console logging, admin API or new D1 counter was added.

The observer is constructed once per invocation and defaults disabled. Explicit enablement also requires an injected sink. A strict closed schema admits only schedule, queue and cleanup aggregates with enumerated outcomes, finite bounded integer counts, consumed-query count from 0 to 40 and measured wall duration. Wall time is not CPU time. Callers supply existing runtime results and invocation measurements; this helper neither calculates nor invents them.

Only parsed scalar fields reach the sink, in a copied frozen object no larger than 512 UTF-8 bytes. Each observer attempts at most three emissions, charged synchronously before awaiting the sink, including failed attempts. The asynchronous wait is bounded to 25 ms by default; valid configured deadlines range from 1 to 250 ms. Invalid configuration fails closed. Timeout aborts the supplied signal. Successful or failed completion also clears the timer and aborts the signal. Validation failures and sink failures are discarded without propagating their contents.

The deadline bounds how long the caller awaits an asynchronous sink. It cannot forcibly stop a sink that ignores cancellation or synchronously blocks the event loop. A future transport must honor the signal, avoid private error logging and satisfy its own destination/privacy review. The emission cap is an observation cap, not a second database execution budget. Each invocation must receive a fresh observer; a process-global observer would violate that intended scope.

## Behavioral evidence

Root broker executed the behavioral RED at `/tmp/invoxim-t18-workflow-t24-observer-check-v1.txt`, exit 1: three intended observer failures (empty aggregate capture, zero emissions instead of the three-event cap, and missing abort for a hung sink); five other observer cases passed against the deliberate no-op scaffold. The combined six-file run reported 3 failed and 55 passed tests. These failures establish missing behavior rather than a missing import.

The implementation preserves those assertions. Eleven tests now cover allowed aggregates, private-field and arbitrary-outcome refusal, off/missing-sink behavior, invalid measurements, concurrent emission bounds, sink rejection, hung-sink cancellation, throwing getters, invalid deadline configuration, failed-attempt bounds and copied/frozen sink payloads.

Root broker executed native GREEN for `test/operational-metrics.test.ts`: `/tmp/invoxim-ops-green-v1.txt`, exit 0, 11 tests passed in one file, 1.36 seconds total runner duration. The implementer inspected that output. This is local workerd test execution, not deployed telemetry integration.

Executed by the implementer:

- `pnpm exec biome check --write apps/worker/src/operational-metrics.ts apps/worker/test/operational-metrics.test.ts`: exit 0; two files checked, no fixes required.
- Initial scoped Prettier check failed on test formatting. `pnpm exec prettier --write apps/worker/test/operational-metrics.test.ts` fixed line wrapping only after native GREEN; no assertions or behavior changed.
- `pnpm exec eslint apps/worker/src/operational-metrics.ts apps/worker/test/operational-metrics.test.ts`: exit 0.
- `pnpm exec prettier --check apps/worker/src/operational-metrics.ts apps/worker/test/operational-metrics.test.ts`: exit 0.
- `pnpm exec biome check apps/worker/src/operational-metrics.ts apps/worker/test/operational-metrics.test.ts`: exit 0; two files checked, no fixes required.

Worker typecheck remains pending root's running command at this report revision. No independent review is claimed.

Frozen source SHA-256:

- `apps/worker/src/operational-metrics.ts`: `1e40ac40652ae35b8b6709f230150543e346a0194cd04516f79c64eb97ec6940`
- `apps/worker/test/operational-metrics.test.ts`: `bfb10996c5d127fd10d2c30dab668be05bda53191ee8c726181a97eca9569dd2` (formatting-only change after GREEN; tested preformat hash was `caadddf60f89a4d0f2c6d6500272d818c80b5f954659048c2a9d7ef41ed6af32`).

## Requirements and remaining work

This helper advances T24 redacted observation controls. It does not complete JOBS-03 queue repair, RELEASE-03 independent deletion-aware restoration or RELEASE-05 deployed smoke. Existing native queue recovery remains authoritative and unchanged. Runtime composition, environment selection of a reviewed sink, operational runbook exercises, independent review, actual resource thresholds, external journal durability and deployed smoke remain separate work.

All test inputs are synthetic. No invoice amount, merchant identity, receipt text, tenant/job/document identifier, URL, arbitrary label or raw error is admitted. No personal financial data was inspected or retained. No provider cost was incurred. The 10 ms hanging-sink test configuration and default 25 ms observation deadline are configured wait bounds, not measured Cloudflare CPU, billable cost or a production performance guarantee.

Root integration checks: Worker typecheck passed (exit 0, `/tmp/invoxim-worker-types-v2.txt`). Root repeated scoped Biome with `--error-on-warnings`, Prettier and ESLint successfully. The final formatted tests also passed in the 106-test combined native run recorded in `m1-service-checkpoints/services-green-v3.txt`. Independent read-only reviewer `/root/discovery_review` inspected the source, tests, hashes and 11-test native log; no required findings. This approval covers the helper only.
