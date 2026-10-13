# Deployment checklist

Updated 13 October 2026. **Not ready to deploy or launch.** This is an evolving operator checklist, not executed deployment evidence. T11 inference and T12 pipeline are locally verified; remaining private-MVP implementation and live/release gates are still pending. No remote resource, production migration, secret or rollout is created by this document.

## Prepare and review

- [ ] Confirm current `.agents/backlog.json` statuses and implementation evidence; close the target milestone's required tests and independent review.
- [ ] Complete applicable owner inputs in `MANUAL_TASKS.md`, including real domains/accounts, provider/model terms, OAuth registrations, keyring, disclosures and budget limits.
- [ ] Select an immutable commit/build identity and record exact Node/pnpm/dependency versions, migration list and deployment environment.
- [ ] Run frozen install and `pnpm verify`; require Biome/ESLint/Prettier/typechecks, actual unit/workerd/browser evidence and no hidden skipped cases.
- [ ] Run migration clean/upgrade/integrity checks, applicable extraction evaluations, dependency/secret/security/release checks and inspect failures. Placeholder `NOT IMPLEMENTED` scripts do not pass a release gate.
- [ ] Record unsupported parser/document/provider cases and measured CPU/memory/query/usage/cost limits. Local query bounds and dry-run bundles do not establish a deployed plan's viability.

## Isolated staging

- [ ] Provision approved staging Pages/Worker/D1/Queue resources in the chosen account and plan. Use separate bindings/secrets from production; no R2 or operator original-file storage.
- [ ] Configure Pages same-origin `/api/*` service binding to the modular Worker; confirm actual cookie, origin, redirect, cache and security-header behavior.
- [ ] Configure a Queue consumer batch size of one for the shared invocation D1 budget, plus the reviewed dead-letter/retry policy and Cron triggers from the implemented runtime/runbooks; do not invent schedules or resource IDs.
- [ ] Install server-only auth/mail/provider secrets and the validated encryption keyring through secret storage. No secret in public config, Vite variables, source control or logs.
- [ ] Apply reviewed migrations only after backup/rollback/recovery planning; record command, target resource and actual result.
- [ ] Start with allowlisted identities and disabled capabilities. Enable each integration only after operator configuration, destination/disclosure/consent/readiness and live smoke evidence are complete.
- [ ] Verify Google login versus mailbox/Drive identity separation, account mismatch/refusal/replay behavior and callback-without-content/scan.
- [ ] Confirm every selected AI notice reference has an approved readable data-use/retention disclosure and HTTPS privacy URL; changing destination, model, notice content or parser policy must invalidate old processing approval.
- [ ] Verify explicit resumable review/Start, chosen destinations, recent-first full-range processing, no provider fallback, stale-consent refusal, budgets and honest partial/paused/unsupported states.
- [ ] Test duplicate/lost queue delivery, leases/generation fences, history recovery, cancellation, provider rate limits/outage and budget exhaustion in the actual deployed runtime.
- [ ] Exercise expired-credential and same-account reconnect with fresh explicit review; preserve existing import progress and verify completed compatible inference is reused without another model charge. Confirm unavailable/deleted sources and old leases remain refused, with measured recovery/cleanup bounds.
- [ ] Compare purchase/detail/period totals against exact ledger evidence; verify unpaid/pending refunds, mixed tender, corrections, deduplication, FX/recurring and export semantics as implemented.
- [ ] Verify two-tenant denial and no originals/full text/model transcripts/keys in D1, queue payloads, logs, monitoring or browser cache. Optional originals go only to explicitly authorized user Drive.
- [ ] Execute export/disconnect/account deletion and isolated restore suppression; verify the independent deletion journal and retention cleanup. Record journal export/replay access, completeness and watermark checks, recovery ownership and session/credential reconciliation. Local synthetic restore tests do not prove an isolated deployed restore drill; never serve the restored database before reconciliation.
- [ ] Confirm a lifecycle form from account/session A cannot delete or disconnect under account/session B, even when optimistic versions match. Verify missing/expired/other-purpose lifecycle tokens are refused before effects and newly reviewed current-session actions succeed; never automatically refresh a destructive form's token after an account switch.
- [ ] Record actual provider/parser/model capability, quality and cost results; mocks cannot substitute for this step.

## Production rollout and recovery

- [ ] Independently review staging evidence, unresolved risks, legal/provider/privacy gates, operational ownership and exact enabled public capabilities.
- [ ] Obtain explicit owner approval for the concrete production change and later public release; record the approved build/resources/migrations/flags.
- [ ] Create production resources/secrets separately, apply reviewed migration procedure and preserve rollback evidence.
- [ ] Verify live origin/callbacks/service bindings/Cron/Queue consumers, no preview-to-production access and no public capability toggle before smoke completion.
- [ ] Enable the smallest approved allowlisted rollout; verify monitoring redaction, quota/cost alerts and recovery/drain procedures. Record the monitoring sink, retention, recipients, alert thresholds, deployment identity and incident/rollback owners.
- [ ] Run the production smoke matrix with approved synthetic/test accounts; record failures before widening access.
- [ ] Reconcile queue/data/credential/deletion state before rollback or restore. Never serve a restored database before suppressing independently recorded deletions and invalid sessions/credentials.
- [ ] Confirm final public copy/disclosures and external OAuth/provider assessment requirements; only then consider separately approved public signup.

Actual binding names, supported constructors and flag behavior are authoritative in `apps/worker/CONFIGURATION.md` and checked Wrangler files. This checklist will gain executable, verified commands during T24; commands/resources not yet implemented remain unexecuted rather than guessed.

Latest T16 local validation: fresh `pnpm verify` passed 785 distinct tests, `pnpm db:check` passed 79 repeated tests and `pnpm test:security` passed 261 repeated tests; `pnpm check:deps` reported zero advisories. Frozen install and all 322 input-file comparisons passed. Independent source reviews closed the lifecycle account/session bug and two scanner defects. The two-mailbox/retention witness uses synthetic post-consent processing and an injected queue port. See `evidence/implementation/t16-qa-final-certificate.md`; these local results do not execute or approve any staging, restore, live-provider or public-release checklist item.

T13–T15 and T29 local verification is complete: 770 distinct tests, 79 repeated native migration/integrity checks and separate independent source reviews, on an exact frozen source copy. Evidence is recorded in `evidence/implementation/t14-t29-qa-final-certificate.md`. This does not complete the full MVP or live deployment gates. Verify private screens, explicit Start/reconnect and review metadata with real independent tenants. The historical verification used the earlier migration sequence. The current implementation uses native D1 persistence and the established Drizzle authentication adapter with the consolidated `0001_initial.sql` baseline. Follow `evidence/implementation/baseline-transition-checklist.md` for fresh databases and non-destructive existing-database reconciliation, with backup/restore planning. Keep corrections, lifecycle, auth/mail/AI/extraction and revocation flags disabled until their operator and live prerequisites pass. For lifecycle enablement, configure the independently retained deletion journal binding/secret, confirm acknowledgment durability and isolated restore suppression, and measure scheduled cleanup cadence/load against the deletion target. Optional provider revocation needs explicit user consent and a recorded live test; HTTP acknowledgment alone is not proof of immediate effect.

## M1 prerequisites under implementation

- [ ] Keep `OUTLOOK_ENABLED=false` until authorization, folder/delta discovery, content processing and explicit review/Start have passed their separate checks. Register the Microsoft callback and approve delegated Mail.Read consent before a live smoke test.
- [ ] Select and record the FX reference source and prior-date policy; verify provider snapshots, persistence and consistent list/summary/export calculations before enabling reporting-currency conversion.
- [ ] Run `pnpm run test:eval:offline` and inspect its split conformance results. Require a separate authorized real-model evaluation for extraction quality; the offline preset candidates cannot establish model accuracy.
- [ ] Obtain fresh whole-repository evidence after M1 changes; preserve earlier frozen certificates as historical records.

- [ ] Verify bounded cleanup of historical FX valuations and Outlook folder metadata before applying/enabling the new runtime behavior. Resume existing deletion stages correctly, and test more than 100 leaves per account/source without unbounded parent cascades.
- [ ] Keep Drive disabled until separate consent, persisted preallocated IDs, generation/lease fencing, exact-byte reconciliation, resumable uploads, backfill and failure UX are integrated. A passing transport test is not an archived original.
- [ ] Verify recurring estimates against actual eligible events and comparable charge bases; suggestions/forecasts must never mutate ledger history.

- [ ] Verify the consolidated initial baseline includes the earlier storage authorization/consent structures before enabling separate Drive authorization. Verify its exact callback, actual selected Drive account and encrypted credentials; confirm callback completion leaves archiving disabled and creates no import/upload jobs.
- [ ] Verify actor/session/purpose-bound storage mutation tokens, stale consent races and local disconnect/disable with Drive OAuth turned off. Confirm login/mail grants and user Drive files remain unaffected.

- [ ] Verify the consolidated initial baseline includes durable archive-object metadata before composing archive work. Verify populated upgrades, tenant keys, lease expiry/reacquisition and immutable saved upload identity. Keep public archiving disabled until the upload coordinator and remaining T18 gates pass.
- [ ] Exercise lifecycle cleanup with all M1 leaf tables installed and more than 100 archive rows; confirm each step stays bounded and stale deletion requests cannot erase current work.

- [ ] Inspect native D1 atomic rollback, tenant fencing, shared statement accounting and authentication timestamp compatibility evidence before rollout.
- [ ] Treat `0001_initial.sql` as the fresh-database starting point. Do not apply it on top of an existing migrated database or reset that database automatically. Review `evidence/implementation/baseline-transition-checklist.md` and compare every application constraint/index and required scheduler seed against the historical schema before changing migration bookkeeping.

- [ ] Keep pilot measurement disabled until separate user opt-in, opt-out, retention/deletion and content-free event handling are verified. Record pilot benchmarks as NOT RUN until the approved pilot is actually executed.

## Reported deployment and live login QA — 13 October 2026

Reported deployed URL: `https://invoxim-web.pages.dev/`. Independent browser login QA ran against that URL; Google initiation failed before redirect. Evidence: `evidence/implementation/deployed-login-browser-qa-20261013.md`. Existing unchecked release gates remain unchecked.

- [ ] Record the actual deployed commit, Pages/Worker build identities and intended D1 binding; do not assume they match the local worktree.
- [x] Recheck the deployed login initiation: POST200 and actual UI button reaches Google account-entry screen; full account completion remains unchecked.
- [ ] Verify anonymous private routes offer configured sign-in recovery and fresh anonymous visits use neutral signed-out copy.
- [ ] Complete login/callback/session/logout with an approved test identity and record refusal, wrong-account and allowlist behavior without retaining tokens or personal screenshots.

## Current additive M1 migration gates

- [ ] Review and exercise additive `0002_archive_upload_sessions.sql`, `0003_recurring_series.sql`, `0004_outlook_folder_exclusions.sql`, `0005_reporting_revision.sql` and `0006_archive_dispatch_backfill.sql` against the intended populated schema before deployment. Some increments remain under active verification; this list is not approval to apply them. Preserve the fresh consolidated `0001_initial.sql` and never replay/reset it on an existing database.
- [ ] Verify trigger-aware direct-row success/count oracles, atomic rollback and the actual financial pipeline with reporting revision installed. D1 `meta.changes` includes trigger writes; it cannot substitute for direct target-row counts. Measure write amplification separately from submitted query count.
- [ ] Verify full recurring UI/terms acceptance before advertising recurrence. Keep the server flag disabled until that increment and its operator/live gates are approved.
- [ ] Verify archive queue authority independently of AI consent, frozen backfill membership/cancellation, combined concurrency, ordered leaf cleanup and actual Worker queue/scheduled entry points before enabling archiving. No new live queue or upload is established by local tests.

- [ ] Confirm the deployed Worker binding is `DB`, and migration tooling resolves `../../packages/adapters/migrations`. Local configuration discovery was verified; remote schema remains unknown.
- [ ] Inspect the deployed auth tables/columns and resolve the observed 503 `auth_unavailable` before calling login available. Require actual Google redirect plus approved callback/session/logout; local synthetic initiation does not complete this gate.

## Current increment readiness — 13 October 2026

- [x] Save reviewed bounded recurring API (`bba6d27`, 26 native cases) and Outlook exclusions/rate-pause (`673e14d`, 49 native cases) in separate recoverable commits.
- [x] Complete the recurring UI final Biome gate and save its seven-case browser/screenshot-reviewed increment (local evidence only).
- [ ] Complete archive page admission, queue consumption, Worker composition and cleanup integration before enabling archiving; initial three queue/backfill cases plus 158 existing Drive regression cases are local evidence only.
- [ ] Complete full-period FX/list/export integration after the reporting revision foundation; four actual pipeline/quote checks do not prove whole-period totals.
- [ ] Run fresh repository verification/build after integrating unfinished M1 increments. Narrow green tests and historical CI do not certify the current source.
- [ ] Repair and retest deployed login initiation, then approved Google callback/session/logout. The remote schema/build remains unconfirmed; do not reset a populated database or blindly apply draft migrations.

## Production artifact isolation

- [ ] Run `pnpm build` on the release commit and retain `pnpm check:production` success. This gate checks the browser, Pages Function and Worker bundle inventories and the public Pages directory for test/debug tooling, browser binaries, dependency folders, reports and source maps.
- [ ] Publish only the built Pages `dist` and Worker runtime bundle; keep private `.production` inventories and local Worker debug maps outside publication. Do not enable source-map uploads without a separate reviewed change. Local guard results do not inspect an older deployed build.

Latest remote check: migrations list exited0 with no pending migrations; journal records0001–0006 and checked auth tables exist. This is read-only verification, not approval or execution of a new migration. Endpoint recheck and actual Google button initiation passed; callback/session/logout remains open. See `evidence/implementation/deployed-login-endpoint-recheck-20261013.md`.

- [ ] Redeploy Pages with the reviewed signed-out onboarding visual increment and check desktop/mobile live. Its 28 synthetic login/onboarding regressions, scoped build and independent screenshot review passed; the remote page has not been changed by this patch.

- [ ] Verify release of typed processing configuration errors and revised review/sign-in UI on the actual Pages/Worker versions. Local37native+40browser checks passed; this does not activate inference.
- [ ] For Abacus activation, retain the now-present `AI_HOSTED_KEY` on `invoxim-api` and supply reviewed registry/pricing/notices and budget; keep BYOK available through the same validated service and retain explicit import consent. The public preset is inactive until these gates pass.

Verified runtime release on 2026-10-13: Worker `583847d3-f076-4dff-93fc-5331f5728682` and Pages `67b48d01` deployed after `pnpm verify` passed. Production sign-in initiation reaches Google; full account callback and authenticated processing smoke remain separate checks. See `evidence/implementation/release-runtime-20261013.md`. AI activation remains pending registry/pricing/budget/background configuration.
