# T18 durable archive-object persistence — local progress

Status: in progress; bounded metadata seam implemented. Full T18 and public archiving remain incomplete/disabled. Root implemented the store and lifecycle integration. Separate architecture and security reviewers inspected it; independent QA continues adversarial boundary work.

## Implemented behavior

- Migration 0018 adds the documented tenant/document/storage natural key, composite ownership references, complete upload-plan metadata constraints, lease ID/expiry and increasing fence.
- Requests snapshot the exact owned document/source/part, mailbox generation, verified storage subject/generation and explicit settings version. No source bytes are retained.
- Claims, immutable plan persistence, authorization checks and successful-upload metadata commits repeat current active-profile, source availability, document/source identity, mailbox/storage credentials/generations, Drive permission and explicit consent guards.
- Only an identical plan replay can succeed after a plan is saved. Retried claims retain the saved remote ID/MIME/hash/size/parent/marker tuple. Source/document deletion cannot recreate old work.
- Bounded lifecycle cleanup drains archive rows before parent erasure; stale deletion requests cannot erase current work. Remote user-owned files are untouched.

The initial M1 cleanup UNION failed on a fully migrated D1 database: `too many terms in compound SELECT`. Fixed by bounded JSON-array selection of scalar leaf queries, retaining repeated deletion-request guards and at most 100 rows deleted per unit. The genuine failure, diagnostic probe and successful regression are preserved.

## Executed evidence

All local fixtures are synthetic, running actual D1/workerd. No live provider, credential, model, upload or deployment operation occurred.

- Initial behavioral RED: dedicated archive test returned no claimed work; exit 1. Then one-test GREEN exit 0.
- Expanded failures: genuine missing cleanup support/D1 compound limit, plus two invalid credential-null fixture mutations; the fixture fixes preserve the existing credential constraint. A later fixture-reset collision was repaired without changing assertions or production constraints.
- Focused closeout: 88/88 passing across six archive/consent/lifecycle files, exit 0.
- Plain `pnpm verify`: exit 0, **1,445 distinct tests** (22 tooling, 48 contracts, 372 core, 941 Worker, 62 browser), with boundaries, secrets, dependency policy, format, Biome, ESLint, types, integration and build passing. Biome checked 334 files with warnings treated as failures.
- The 407 captured runtime/config/test/docs inputs were unchanged across that whole run: manifest SHA-256 `c8a842c7b084416e9c4083d6cfb45fc852e46a89eb887f80091c4056f5634cab`.
- Explicit `pnpm test:security`: exit 0, 338 repeated tests/24 files. These tests overlap the full suite and are not additional distinct tests.
- After those runs, a test-only harness change applies migration 0018 over already-populated mailbox/document fixtures. Dedicated 28/28 tests and Worker typecheck passed; scoped Biome/ESLint/Prettier passed. Captured closeout407 SHA `22465a25f2a38aafc7186ad0c33af963a0177131bc4f3262166449623f10ae01`, with only the dedicated test changed from the full-run manifest.
- Independent architecture review found missing `source_messages.available=1` guards. Genuine native RED: 2 failed/28 filtered. Added the guard to admission and the repeated predicate; unfiltered GREEN: 30/30, exit 0, 1.99 seconds. Scoped Biome/ESLint/Prettier passed. Both independent reviewers closed that finding after inspecting the actual fix, logs and hashes.

The earlier whole-suite/security results are historical for their captured inputs, not a post-repair whole-source certificate. Fresh convergence verification is pending alongside the new refresh slice. Independent QA has identified a two-clock completion boundary; its regression/fix/re-review is pending and is not certified by the earlier reviews.

Logs and hashes: `t18-archive-objects-focused-log-map-20261013.json`, `t18-archive-objects-verify-log-map-20261013.json`, `t18-archive-objects-closeout-log-map-20261013.json`, `t18-archive-objects-tombstone-log-map-20261013.json` and `t18-archive-objects-reviewed-source-20261013.json` under this evidence directory. The full command is recorded verbatim in the raw log; native runs set `WRANGLER_SEND_METRICS=false` and unique `/tmp` Wrangler log paths. Full browser verification uses `/tmp/invoxim-playwright-browsers`.

## Scope and remaining gates

ARCH-02 is local supporting coverage for DRIVE-03/06; those provider-contract E2E cases remain unexecuted. `complete()` is an internal metadata write and trusts the coordinator to verify actual remote success; saving a plan alone proves no upload. The store is not mounted as an archiving route or dispatched by a scheduler.

Folder planning, refresh integration, per-outbound-request authorization, exact-source acquisition, remote reconciliation/lost-response behavior, bounded retries/dispatch, genuine resumable uploads, explicit backfill, archive links/failure UX and live/operator gates remain. Pending work from an older settings/generation snapshot cannot be silently reauthorized by a new consent; explicit workflow handling is required. No new infrastructure, R2, OAuth scopes, credential inputs, retention permission or paid operation was introduced. Core ports stay independent of providers/environment; the concrete store follows the existing environment-composed adapter seam.

## Subsequent QA clock boundary closure

Independent QA supplied a new actual D1 test without changing implementation. Root reproduced one genuine RED: archived_at2000 equaled leaseexpiry2000 while the earlier guard sample was1999. Root made the commit timestamp and expiry predicate share one validated clock sample. Native GREEN31/31across2files,zero skips,exit0,6.85seconds. Independent architecture re-review approved this source repair, excluding other workflow/full-gate claims. Immutable raw logs and six source hashes are preserved in `t18-archive-objects-clock-log-map-20261013.json` and `t18-archive-objects-clock-source-20261013.json`. Fresh whole-source convergence remains pending until credential refresh freezes.
