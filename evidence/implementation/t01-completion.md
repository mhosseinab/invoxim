# T01 / M0 evidence report

Status: ready for independent review. Source paths: `spikes/runtime/**`; evidence: `evidence/implementation/t01-*`. No shared files, backlog, root manifests or other agent files edited. No new agents spawned.

Implemented: actual Better Auth/Drizzle/D1 synthetic session creation/read/revocation in workerd; Web Crypto signed-session verification; service-binding proxy cookie/body/origin/redirect/error/no-store behavior; D1 batch rollback; bounded ID-only queue compatibility with durable ownership and duplicate completion; bounded UTF-8 extraction with explicit unavailable PDF conversion.

Acceptance: RUNTIME-01, RUNTIME-02, RUNTIME-03 locally exercised. RUNTIME-04 locally exercises representative input bounds/text processing/PDF-input rejection and records elapsed time; external PDF conversion and CPU/Free-plan suitability remain unverified. This is task-local compatibility evidence, not full runtime or MVP completion.

## Actual execution

Environment: Linux x64, Node 24.21.0, pnpm 12.6.0, compatibility date 2026-10-11, nodejs_compat. Workerd 1.20261006.1. No socket escalation needed.

- Dependency installation: `pnpm --dir spikes/runtime install --ignore-scripts --store-dir /tmp/invoxim-pnpm`, exit 0; `t01-install.txt`. Initial registry checks failed on read-only home npm cache; rerun with `/tmp/invoxim-npm` succeeded. Wrangler logs routed to `/tmp/invoxim-wrangler`.
- RED: `WRANGLER_LOG_PATH=/tmp/invoxim-wrangler WRANGLER_SEND_METRICS=false pnpm --dir spikes/runtime test`, exit 1, 5 failed / 3 passed; `t01-red.txt`. Intended assertion failures: redirect followed to 404; job remained ready; text/bounds/encoding contract missing. Earlier configuration/startup failures were repaired before this behavioral RED.
- Initial GREEN: same test command, exit 0, 8 passed / 2 files; `t01-green.txt`. Additional requested evidence expanded this to ten tests.
- Final verify: `WRANGLER_LOG_PATH=/tmp/invoxim-wrangler WRANGLER_SEND_METRICS=false pnpm --dir spikes/runtime verify`, exit 0; `t01-verify.txt`. Strict typecheck, ESLint, Prettier all passed; workerd 10 passed / 2 files; Wrangler deploy **--dry-run** passed. Bundle 2649.69 KiB / gzip 451.92 KiB. No upload/deployment occurred.
- Final measurement within verify: 100 repetitions, 23,000-byte/character receipt, 607-byte valid synthetic PDF, 4,194,304-byte PDF input. Workerd elapsed 4 ms; host test duration 5 ms. These include assertion overhead and have local millisecond resolution. They are elapsed timing, not CPU billing measurements. Auth session test 34 ms includes multiple local DB/binding roundtrips and crypto, not pure CPU.
- E2E/browser, live OAuth, staging Pages, real Queues, conversion, real models, release/security suites: not run; outside synthetic spike and require later approved configuration. Independent QA/review assigned by orchestrator; not impersonated by implementer.

## Decisions and limits

Pinned stable direct versions and source links are in `spikes/runtime/README.md`. Official stable testing tooling has locked transitive prereleases Miniflare 5.20261006.1-alpha and unenv 2.0.0-rc.24. This is recorded rather than overridden. The test helper ignores retry delay options; tests assert the requested delay with a spy while real workerd helper verifies acknowledgement/retry IDs. Deployed queue delay is not established by this helper.

D1 batch rollback is supported on the tested runtime; no commit-marker workaround needed for this atomicity probe. Interactive Drizzle transaction support is not inferred. Auth schema is generated from pinned Better Auth metadata. Synthetic sessions are provisioned internally; live Google login and token retention/encryption remain later implementation gates.

No production migrations/resource creation, paid infrastructure, real-data retention, external document upload or public deployment. D1 test data contains only synthetic auth records and job IDs/status/counters. Queue payloads contain IDs only. Document bytes/text are transient, unsupported PDF processing returns a clear reason, and no R2 binding exists. No Free-plan viability claim. Full durable job leases/fencing/recovery belong to their assigned backlog task.

Next dependency-ready work: orchestrator integrates reviewed compatibility decisions into T02 scaffold and later auth/data implementation. The spike remains isolated and reusable; no production code imports it.


## Reproducibility corrections from independent QA

QA's isolated copied-dependency run caught pnpm automatic verification refusing unapproved install scripts, and the next run caught formatting generated build files after an earlier build. The spike now commits an isolated `pnpm-workspace.yaml` with `ignoreScripts: true`, and `.prettierignore` excludes generated dist, node_modules, .wrangler and package-manager lock YAML. No dependency script approval or global bypass was added.

A fresh workspace frozen install enforced pnpm's minimum release age and rejected same-day workers-types 5.20261011.1. Final pin is workers-types **5.20261006.1**, matching the tested workerd release family. The previous direct-only lock was preserved outside the repository during task-owned lock regeneration; no shared lock or foreign changes were overwritten. All other direct versions remain unchanged. `pnpm --dir spikes/runtime install --frozen-lockfile --store-dir /tmp/invoxim-pnpm` now passes 266 supply-chain entries, exit 0: `t01-frozen-install.txt`. Install scripts remain disabled by committed configuration, not a hidden caller override.

The corrected gate is executed twice with existing generated build outputs retained. First repeat exits 0: `t01-verify-after-build-1.txt` (10 tests, all checks, dry build). Second repeat exits 0: `t01-verify-after-build-2.txt` (10 tests, all checks, dry build). Both repeats measured workerd elapsed 4 ms and host workload-test duration 6 ms. These corrections address reproducibility findings rather than weakening behavior assertions. QA owns its separate independent evidence and final result.
