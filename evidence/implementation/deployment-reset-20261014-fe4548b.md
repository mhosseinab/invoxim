# Production deployment and authorized fresh reset — 14 October 2026

Owner authorized deployment, then explicitly confirmed clearing queues, imported messages, purchases/reviews and quotas. Production target: existing invoxim-api Worker, invoxim-web Pages main branch and invoxim-db. No original mailbox messages, account/session, connection credentials or AI settings were deleted. No new import was started.

## Frozen source and verification

Source: `fe4548ba647d2f2c1a31e0bf32effd09150df3a8`. Newer refactor commits existed after the earlier Outlook certificate, so that earlier certificate was not reused as verification of this release. Initial gates exposed formatting/import ordering, two non-null assertions in the new fault helper and an optional-chain lint finding. Scoped fixes committed as `5d736bf` and `fe4548b`; focused fault-helper test: seven passed.

`WRANGLER_LOG_PATH=/tmp/invoxim-release-checks-wrangler.log pnpm --dir /tmp/invoxim-mail-perf-clean verify` on the frozen Git archive: **exit 0**. Boundaries, secret/dependency policy, format, strict Biome, ESLint, types, unit/native tests, build, test/debug production publication guard and browser checks passed. Contracts: 48 passed. Core: **443 passed and one existing expected failure** (444 collected). Worker: **1,703 passed / 141 files**. Browser: **114 passed**, 57.6 seconds. Valid unchanged Turbo caches were replayed; native/browser stages executed. Log: `/tmp/invoxim-release-verify.log`.

The existing CORE-6 expected failure documents disagreement among payment-state derivation paths. It was not disabled, newly introduced, fixed or counted as passing by this release. Its follow-up remains tracked in docs/code-quality-refactor-plan.md. Independent Outlook review from the preceding milestone does not constitute an independent review of all subsequently merged refactor commits.

## Reset evidence

Preflight: one workspace, one known target mailbox, 276 source messages, three purchases, zero ledger entries, 625 durable jobs, no other-workspace jobs, archives, recurring series or correction commands. Paused processing queue delivery; changed mailbox scheduling to awaiting_import, revoked old approvals and canceled/fenced outstanding jobs. Verified zero active jobs/consents before erasure.

Tenant-scoped reset removed approved purchase/review/source data, dependent extraction/cache data, durable jobs, sync/import/start state and old approvals. Reset tenant and single-workspace operator document/unit/USD quota buckets and cleared provider cooldowns. Application caps remain unchanged; resetting application counters does not reverse provider billing. Purged invoxim-jobs and invoxim-jobs-dlq; resumed processing delivery, all commands exit 0.

Post-reset verification: zero sources, documents, observations, purchases, ledger entries, reviews, jobs, sync states, imports, consents and AI extractions; zero nonzero usage buckets and scheduled mailboxes. One profile and connected credential retained. Foreign-key check empty. Final post-deployment query again confirmed zero sources/purchases/reviews/jobs/active consents/nonzero usage. Private operational IDs and raw SQL/log output remain under `/tmp/invoxim-release-reset-*`, not repository evidence.

## Deployed resources and smoke

Wrangler 4.149.0; expired OAuth login was restored by the owner. Context7 unavailable; installed command help and official Wrangler Workers command documentation verified deploy/keep-vars behavior. Worker used `wrangler deploy --keep-vars --no-upload-source-maps` from the frozen archive; existing secrets retained. Worker **30c20f25-a114-46a8-8675-dd8a0a955a69**, independently confirmed at **100%**. Existing queue producer/consumer and minute cron deployed.

Pages used `wrangler pages deploy dist --project-name invoxim-web --branch main --commit-hash fe4548ba647d2f2c1a31e0bf32effd09150df3a8 --commit-dirty=false`. Production deployment **4ace0189-43fc-4834-8d44-810a30f96fc8**; https://4ace0189.invoxim-web.pages.dev and https://invoxim-web.pages.dev/ . Remote Pages listing confirmed Production/main/source fe4548b. Worker/Pages deployment commands exited 0.

Live HTTP checks exited 0: root and referenced built JS asset 200; /demo, /onboarding, /api/health and /api/public-config 200; /api/me, /api/connections and /api/ai/settings correctly 401 without a session. Public configuration enables Google login and Gmail only. Google social sign-in initiation returned 200 and an HTTPS accounts.google.com authorization destination; no state, nonce or cookie logged. Full signed-in OAuth completion and authenticated import were not performed. Evidence `/tmp/invoxim-release-smoke.json` contains status/host summaries only.

Remote `wrangler d1 migrations list invoxim-db --remote` reports **no migrations to apply**. No migration/reset of schema was executed. Outlook remains disabled pending Microsoft operator/live-account prerequisites; deployment does not authorize enabling it or starting an import.

Previous rollback identities retained: Worker da672498-579a-4a4a-8b79-4a6fdb3eb9e6; Pages d15bb94d-f601-4c4e-a4fb-39e86daada48. Code rollback cannot restore intentionally deleted records or provider charges. Untracked .worktrees/ was left untouched.
