# Authorized runtime release — 2026-10-13

Owner instruction: deploy. Release uses the attached managed checkout `/home/geek/.codex/worktrees/release-runtime/invoxim`, with fresh frozen-lockfile dependencies and only committed code. Unfinished Drive dispatch/backfill and FX period changes in the primary checkout are excluded. Owner OAuth configuration commit `8172a32` is included; no secret values or local `.dev.vars` were copied.

## Preflight and repair

- First full gate stopped at a missing raw-JSON fixture declaration. Fixed in `709782f`.
- Second full gate stopped at one native failure: 1,197/1,198 tests passed; six-MiB Gmail archive workflow rejected with reader `UNAVAILABLE` after about 92 seconds. Log: `/tmp/invoxim-release-verify-v2.txt`.
- The isolated four-case suite passed in 8.50 seconds before repair (`/tmp/invoxim-release-drive-repro.txt`). Memory/resource pressure is a hypothesis, not a measured root cause.
- Scoped repair `73b195a` replaces the string iterable conversion with a preallocated indexed byte copy. Canonical encoding validation, sizes, cancellation and ten-second aggregate deadline are unchanged. New Gmail six-MiB fixture verifies length and SHA-256 against independently constructed binary bytes.
- Scoped Biome/Prettier/ESLint exit 0; isolated original-reader plus resumable-workflow suites: 52 tests across two files, 7.75 seconds, exit 0 (`/tmp/invoxim-release-drive-fix.txt`). Independent read-only review by `deployed_login_browser_qa` found no blocking source issue; reviewer inspected this output and did not run tests.
- Third complete `pnpm verify` gate on isolated commit `199f1b3` exited 0: boundary/secrets/dependency checks, format, Biome, ESLint, typecheck, 34 Node tooling tests, 48 contract tests, 372 core tests, 1,199 native tests across 95 files (216.35 seconds), build/publication guard and 82 browser tests (37.5 seconds). Log: `/tmp/invoxim-release-verify-v3.txt`. Turbo reused some unchanged pure-package checks; the native and browser suites executed.

## Operator readiness

Production secret-name inventory now confirms `AI_HOSTED_KEY` exists on `invoxim-api`. No value was read. Abacus RouteLLM `gpt-6-luna` is the selected default, but reviewed registry/pricing/notices, budget and background activation remain prerequisites. AI/import flags stay disabled in this release. BYOK interfaces remain available in source; this release does not certify live inference quality.

Remote migrations were previously checked using the owner-requested read-only Wrangler command: no migrations to apply, ledger 0001–0006 present. No migration reset, baseline replay or schema write is part of this release.

## Deployment and live smoke

- Worker command: `pnpm --filter @invoxim/worker exec wrangler deploy --keep-vars --no-upload-source-maps`, exit 0. Version `583847d3-f076-4dff-93fc-5331f5728682`; follow-up `wrangler deployments list` confirms 100 percent traffic. Worker has no public direct target; Pages calls its service binding. Logs: `/tmp/invoxim-release-worker-deploy.txt`, `/tmp/invoxim-release-deployments.txt`.
- Pages command: `pnpm --filter @invoxim/web exec wrangler pages deploy dist --project-name invoxim-web --branch main --commit-hash 199f1b3 --commit-message 'Verified onboarding and processing error fixes' --no-upload-source-maps`, exit 0. Deployment URL: https://67b48d01.invoxim-web.pages.dev. Production URL: https://invoxim-web.pages.dev/. Log: `/tmp/invoxim-release-pages-deploy.txt`.
- Real production browser: public config 200 with no-store; anonymous me/session 401 with no-store; onboarding shows the centered sign-in card, one Google button, example link and separate inbox-consent explanation.
- Clicking the actual Google button reaches `accounts.google.com/v3/signin/identifier`; callback is `https://invoxim-web.pages.dev/api/auth/callback/google`, scopes are exactly openid/email/profile. No credentials, account selection or consent submitted. Full callback/session/logout remains owner-assisted smoke work.
- Signed-out screenshot: `.playwright-mcp/release-onboarding-20261013.png` (no real account data). No existing authenticated IAB tab was available, so production authenticated processing-disclosure behavior was not independently exercised. Its classification and copy passed the native/browser release tests.
- The owner changed primary-working-tree `AI_ENABLED` to true during release verification. That uncommitted edit was preserved and excluded from this frozen release; production remains disabled until reviewed registry/pricing/budget and background prerequisites are supplied. No inference or import was activated.

## Rollback

Previous production Worker version is `73f42e3f-d0ff-49ca-b50a-c4c4dc1995f8` according to the deployment history. If rollback is required, use a reviewed Worker rollback to that version and the previous production Pages deployment from project history; neither step requires a database reset. No rollback was executed. Keep this managed release checkout for recoverable deployment artifacts.
