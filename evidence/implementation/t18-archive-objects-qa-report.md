# T18 archive objects independent QA assessment

Status: scoped local ARCH-02 persistence/lease evidence is passing after one independent QA finding. DRIVE-03 and DRIVE-06 remain broader acceptance gaps; no provider E2E or full T18 completion is certified here. QA authored only NEW `apps/worker/test/archive-objects-adversarial.test.ts` and evidence. Root implemented the repair and retained the sole native execution lease. QA did not run native/browser/heavy commands or change implementation, existing tests, global configuration, barrels or backlog.

## Finding and independent invariant

The former `complete()` sampled the clock once for lease expiry authorization and again for `archived_at`. A valid first sample just before expiry and a second sample at expiry could produce a successful record with `archived_at >= lease.expiresAt`. The existing exact-expiry test set time before entry and did not cover this inconsistent pair.

The new native test obtains a tenant from an actual signed session verified by the profile service, applies established migrations, seeds owned mailbox/source/document/storage/consent data, and positively acquires work and saves an immutable plan. It then exposes the clock boundary. Its independent oracle permits either refusal with unchanged pending/no remote metadata or successful completion with the recorded timestamp strictly before expiry. It does not require a second clock sample or prescribe implementation internals. Invocation meters remain bounded at40; native foreign keys are checked. No original bytes or live provider calls are involved.

Root repaired `complete()` with one validated decision timestamp passed to `leaseArguments` and bound as `archived_at`. The expiration predicate and metadata now use that same decision. QA inspected this patch and both raw outcomes. A separately reported architect approval belongs to root's review evidence, not QA's own execution.

## Actual root-executed RED/GREEN

Commands ran in `/home/geek/workspace/invoxim`; execution and exit provenance below are explicitly attributed to root, not represented as a QA-run isolated suite.

```sh
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/invoxim-archive-clock-red-20261013.log pnpm --filter @invoxim/worker exec vitest run test/archive-objects-adversarial.test.ts > /tmp/invoxim-archive-clock-red-20261013.txt 2>&1
```

Root session91871 exited1. One intended failure: recorded2000 was not less than expiry2000. Raw duration5.94s/start08:21:43. Immutable copy `t18-archive-objects-clock-red-20261013.txt`, SHA-256 `11b0ceed9b074ae0add3250a48e855e871f20b1f5b3c7d3e723fb6bafc53bf4b`.

```sh
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/invoxim-archive-clock-green-20261013.log pnpm --filter @invoxim/worker exec vitest run test/archive-objects.test.ts test/archive-objects-adversarial.test.ts > /tmp/invoxim-archive-clock-green-20261013.txt 2>&1
```

Root session66340 exited0: **31passed/two files**, no reported skips,6.85s/start08:22:50. Immutable copy `t18-archive-objects-clock-green-20261013.txt`, SHA-256 `0dbe4d0475ace8212ebf712544de3d181aae22cab8f3cff0be0db11d62666254`. QA inspected the exact failure and success output. The new test SHA remained `7d512eeeed0ecc1347d8757735416092407454436fb4f53b67ea4ffe0eec15d8`; repaired adapter SHA is `b47774e61ac4d088223cdea791e10602443e8264a640ff3d630ac4093e772eb1`.

QA's actual local checks: scoped Prettier and fatal-warning Biome exited0. An unused test import warning was corrected before readiness. No additional native execution or optional test expansion was performed.

## Acceptance evidence and remaining gaps

**ARCH-02 local seam:** inspected existing assertions cover idempotent/concurrent requests and claims, durable saved remote IDs through lease reacquisition, immutable plan tuple, no completion before a saved plan, tenant/fence/lease expiry denial, owned document/source/storage/consent identity changes, granted Drive permission shape, controlled malformed input/errors, populated migration foreign-key/check constraints, six-query happy path, and bounded local cleanup. Root's separately identified source-tombstone repair now fences both admission and current authorization; QA did not duplicate that test. Combined31GREEN includes current existing cases and the added clock case. This is metadata admission/plan/commit proof, not remote verification.

**DRIVE-03:** transport tests separately exercise lost responses, same planned ID and409 metadata verification; repository tests separately prove persistence and stale-lease refusal. The shipped upload coordinator connecting these ports is explicitly absent. There is no implemented end-to-end native workflow proving remote success followed by a failed D1 commit, then resumed verified retry without a new file ID. Adding a test-only coordinator would falsely imply implemented runtime behavior, so no such fixture was added. Real Drive E2E remains unexecuted.

**DRIVE-06:** inspected cleanup removes tenant-owned archive metadata in bounded leaves before local parents and contains no remote file-deletion operation. This supports the local default leave-files policy. It does not prove retention of an actual user-owned Drive file after account deletion or the required user-facing deletion disclosure. Those service/UI/live gates remain separate; mock/local cleanup is not proof of provider behavior.

No new consent version implicitly revives earlier pending work; the documented explicit future workflow is still required. Folder planning, dispatch/backfill, token refresh, remote verification orchestration and archive links are outside this internal repository seam. Monetary invariants and live journal/restore/provider gates must not be inferred from these counts.

## Existing evidence integrity and frozen scope

QA read the immutable archive-object verify/focused/closeout log maps and independently checked all17 referenced artifact hashes; no mismatch was found. Inspected full-verify raw counts were22tooling+48contracts+372core+941native+62browser=**1445**, before later tombstone/clock changes. The earlier combined closeout passed88tests/six files before the populated-upgrade harness adjustment. After moving0018 after the populated fixtures, the dedicated archive-object run passed28tests/one file and Worker typecheck; later source-availability regressions passed30, then the clock regression group passed31. These are root-executed historical/scoped results, not this QA's own native commands.

The supplied407-input closeout manifest (`22465a25f2a38aafc7186ad0c33af963a0177131bc4f3262166449623f10ae01`) matched the core port,0018 and cleanup during inspection. The object adapter and existing test differed because of subsequent root tombstone work. It must not be used as a current whole-source identity for this clock patch. Root plans broader whole verification after the refresh/source freeze; that result is not invented here. No account quota error or alternative-model workaround occurred during this assignment.
