# T17 Outlook connector local completion

Milestone M1; code checkpoint `24488b8`, preceded by plan `b5521e4`, UI `66c59c9`, connected Worker `092bfa9` and recurring sync/metadata `1e09395`.

Status: local implementation ready for review; live acceptance pending. Provider-correct OAuth onboarding, public/authenticated processing readiness, real discovery and content job composition, mandatory Clef and chosen hosted/BYOK financial inference, bounded per-folder deltas, hourly existing/new/nested folders, transient review metadata and local disconnect are implemented. Google login remains separate from mailbox identity.

Acceptance OUTLOOK-01–05 exercised with synthetic/native protocol fixtures: delegated personal/work account rules, recursive/archive inventory, exact opaque continuations, immutable source identity/move replay and delta-expiry recovery. Browser tests exercise available/disabled provider controls, reconnect, failed permissions, actor switch, redirect constraints and mobile keyboard access. These do not prove live account/provider operation.

RED/GREEN: linked checkpoint reports record actual initial failures and subsequent corrections. Parent final disconnect run passed 30 tests / three files and Worker typecheck, strict Biome/ESLint and formatting; independent reviewer found no remaining blocking issue. Reviewer executed no tests. Full gate result to be appended after completion.

No schema/migration, dependency, scope expansion, cloud secret/config write, deployment, paid call or remote migration. No raw email/document/model persistence. Graph page size one trades throughput for measured 40-statement job bounds; retry caps/reserves unchanged. Outlook original-email links and PDF preview remain unavailable. Existing PDF text conversion limitations are unchanged.

Live gates: approved Microsoft registration/callback/secrets, authorized personal/work accounts, organizational policy/refusal, token rotation/revocation, moved/deleted folders and expired-delta smoke; deployed binding/queue/limit verification. Outlook remains disabled by default pending separate activation authority. No M1/MVP/public release claim.

## Final integration gate

Frozen source `24488b8b3170fc4e114496f8887c9bad912ffd3f` was exported with `git archive` into `/tmp/invoxim-mail-perf-clean`, retaining installed dependencies but replacing tracked sources and removing obsolete archived tracked files. Command:

```sh
WRANGLER_LOG_PATH=/tmp/invoxim-t17-full-wrangler.log pnpm --dir /tmp/invoxim-mail-perf-clean verify
```

Exit **0**, log `/tmp/invoxim-t17-verify.log`. Boundaries, secret/dependency policy, formatting, strict Biome, ESLint, typecheck, unit tooling and package tests, native integration/migration tests, production build/publication guard and browser suite passed. Node tooling: **48 passed**; contracts: **48 passed**; core: **431 passed**; native Worker: **1,684 passed / 136 files**, 431.42 seconds; Playwright: **114 passed**, 55.4 seconds. Turbo replayed valid unchanged package task caches; Worker integration was cache-bypassed and the browser suite executed. Isolated archive lacks Git metadata, producing a nonfatal Turbo status warning; no assertion or gate was waived.

Production artifact/build-input inspection explicitly passed the test/debug publication guard. This verifies built outputs rather than claiming dev dependencies are absent from the development workspace. No Playwright or debug package is published by these checked production artifacts.

Independent review: `t17-outlook-independent-review-20261014.md`; P1 hourly sync finding resolved, no remaining P0/P1/P2 finding. Runtime and metadata RED/GREEN: `t17-outlook-completion-20261014-runtime-and-metadata.md`; disconnect RED/GREEN: `t17-outlook-disconnect-20261014.md`; prior UI checkpoint records 36 scoped browser passes. No fabricated live account, latency, coverage or model accuracy result.

Final bookkeeping changes contain only this evidence, the independent review record and T17 backlog links/status. T17 is marked **review**, with local implementation verified and live Microsoft/operator acceptance outstanding. No additional product work was started.
