# T18 archive metadata store independent security review

Reviewer: separate read-only security agent `/root/m0_security`. Scope: metadata store, migration, neutral port and bounded lifecycle leaf integration only. Initial decision: request changes for source-availability fence; subsequent repaired-snapshot decision must be recorded separately below. No source/test edits, native/heavy test execution, migrations, live calls or actual uploads by this reviewer. Only this evidence report is written.

## Reviewed scope and snapshot

Read complete `packages/adapters/src/drive/objects.ts`, `packages/adapters/migrations/0018_archive_objects.sql`, `packages/adapters/src/lifecycle/m1-leaf-cleanup.ts`, `packages/core/src/archive/objects.ts`, and `apps/worker/test/archive-objects.test.ts`. Read adjacent archive-settings constraints and canonical storage service projection, lifecycle prepass call sites, T18 backlog/acceptance scope and security/D1 integrity skills/rules. The initially mistyped root-relative migration read failed; the actual migration under packages/adapters was subsequently read completely. No test failure is inferred from that read error.

Independently observed hashes match all five entries in `/tmp/invoxim-archive-closeout-20261013.json` (407 inputs, manifest `22465a25f2a38aafc7186ad0c33af963a0177131bc4f3262166449623f10ae01`):

| File | SHA-256 |
| --- | --- |
| adapters drive/objects.ts | `122ad7ad628c90b7a0e158549759a158a950932975f28d5bbe69e26fc16e9851` |
| migration 0018 | `08eb9ddee8bba62c7906eec11e82e15b81a9d6345087237f619eb0ec24a8ad69` |
| lifecycle/m1-leaf-cleanup.ts | `e96153288f31c7f58107141c983fb1ba188ab841bf73b54422f2570f843d71d3` |
| core archive/objects.ts | `f3fc95855958aeccc2febdf2b65398285d80422a7ae007a09cb4dae8b56c2e19` |
| worker archive-objects.test.ts | `35c00fa1d036e30720cac320efe4a2bdd2bf55eb87d7c3ae60bb688d31ef0035` |

Compared before/closeout manifests: only the archive test changed, from `194f6008cf1e78a3a3a4286bac575012e098c9855d0736a08d3d963002695d6e`, to seed valid owned fixtures before applying migration 18. Production was unchanged across that historical full-verification/focused-upgrade boundary.

## Required finding

P2: source tombstone does not invalidate archive admission or current work. At initial `objects.ts:45–64` current predicate and `:174–187` request INSERT, source identity/generation are checked but `source_messages.available=1` is missing. Independently confirmed from source; the separate discovery reviewer discovered this first and root relayed its finding. This report does not claim original discovery or execution of that reproduction.

Minimal reproduction: seed the otherwise authorized owned document/mailbox/Drive/settings fixture; mark its source `available=0` without deleting retained extracted data or changing generation. Request/claim or existing lease authorization, plan saving and completion still satisfy the initial predicates. Expected: no new object for the unavailable source and denial of all stale existing-work mutations/checks, while retained purchase evidence remains intact. Consequence: later workflow can attempt archival from a known unavailable source or certify stale archive work. Required smallest repair: add `s.available=1` to both admission and reusable current predicate, with native refusal/no-metadata-mutation witnesses before and after existing work is admitted. Root owns repair and execution; no self-fix by reviewer.

## Other inspected boundaries

Tenant authority enters via trusted TenantContext, never request user ID. All SQL joins, keys and mutations correlate user_id; request snapshots owned document/source/mailbox/storage identity, consent version and both generations. Every claim/plan/check/complete repeats active-profile/current-source/current-connected-credential/storage-subject/Drive permission/explicit archive-settings fence. Actual credential rotation does not change stored generation authority; callback/session/encryption correctness remains the separately reviewed storage layer. Storage permission SQL requires a valid JSON array and a text drive.file member; canonical storage authorization/service enforces the narrow exact grant. This repository is not an independent grant validator for arbitrary corrupted broader scope arrays.

Claim is a single conditional UPDATE RETURNING, excludes unexpired/archived rows and bounds fence increments. Expiry equality denies old work; exact ID/lease/fence/expiry tuple guards subsequent operations. Plan can be saved once, permits only exact replay and cannot substitute file/parent/hash/size/MIME/workspace tuple. Completion requires a persisted full plan and current lease, sets remote ID to planned ID and removes the lease. Safe wrapper masks driver/parse details into UNAVAILABLE. No credentials, raw originals, provider response bodies, model output or financial writes are persisted by this module.

Migration has composite tenant document/storage FKs, unique natural key and complete-plan/state/lease/fence constraints; invalid partial plans and missing document ownership fail. Source deletion cascades through document to archive metadata; no mutation method inserts work other than request, which must join live parents. Account-deleting or disconnected-connection guards prevent cleanup races from recreating work. Leaf helper explicitly recognizes only seven fixed table names, prioritizes archive_objects and deletes at most 100 selected rowids with repeated current lifecycle request/stage/profile/journal or disconnected-connection guards. Connection archive cleanup covers either mailbox or storage owner; archive-settings disable preserves version rather than leaving enabled consent. No Drive file deletion occurs. Existing integer stage arrays/prepass call positions remain unchanged.

## Execution evidence inspected

Root is the executor; reviewer ran only source/hash/log reads. Root reports successful full `pnpm verify` on before snapshot, 1445 test total; raw `t18-archive-objects-full-verify-20261013.txt` records boundary/secrets/dependency/format/lint/types/unit/integration/build/E2E commands and 48 contract + 372 core + 941 Worker + 62 E2E results (remaining tooling tests contribute to reported total). Its exit-0 provenance comes from root, not independent reviewer execution. It predates populated-upgrade fixture adjustment and the source-tombstone repair, so it cannot certify those later snapshots.

Root reports explicit security gate exit 0; read `t18-archive-objects-security-20261013.txt`: `node tools/implementation/security-gates.mjs security-tests`, 338/338 in 24 files, 08:09:22, 66.69s. This is actual native/static adversarial coverage, not a live security assessment.

Current populated-upgrade exact command supplied by root:

```text
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/invoxim-archive-upgrade.log pnpm --filter @invoxim/worker exec vitest run test/archive-objects.test.ts
exit 0
```

Read `t18-archive-objects-populated-upgrade-20261013.txt`: 28/28, one file, 08:10:52, 1.97s. Source/test inspection confirms valid existing profiles, connections, sources and documents precede applying migration 18. Existing assertions cover actual native request/claim concurrency, cross-owner collisions, immutable plan replay, generation/subject/scope/credential/consent/profile revocation, expiry, SQL masking/constraints, source deletion/no resurrection and foreign_key_check. Six-query sequence is measured; current seven-leaf coexistence deletes exactly 100 of 101 archive rows. It does not yet cover the unavailable-source finding.

Read preserved focused-closeout 88/88 across six files (14.70s), and combined earlier 66/66 across five (13.50s); these are distinct executions from dedicated 28. Independently hash-checked preservation maps: ten focused artifacts and three full-verification artifacts, zero mismatches. Typecheck log records five successful tasks (one cached). No fabricated all-gates rerun after a source change.

## Integration limits

The natural key intentionally preserves old work: changing consent/settings/generation can leave the old row conflicting rather than silently creating a new plan. Recovery/reset semantics are later application work. `complete()` trusts its internal caller to have reconciled actual remote bytes/identity; a saved plan alone is not evidence of a performed upload and must not become a user-facing saved badge without guarded upload verification. Scope/credential/source-availability guards must be rechecked around actual outbound work; this metadata seam alone has no provider request or returned-original authenticity proof.

Full archive workflow, explicit route/session consent, durable folder/plan orchestration, queue/job admission, source-specific original selection, upload success/reconciliation, badges/links, deletion/restore suppression and live Drive/provider compatibility remain outside this approval. No full T18/M1/MVP, deployment, paid work or regulatory certification.

## Source-availability repair re-review

Final scoped decision: approve metadata store/schema/cleanup at the repaired snapshot; the P2 finding above is closed. No other required finding in the assigned files. Historical initial decision/hash/evidence above is retained and superseded only for this scoped patch.

Root added `s.available=1` to both the admission INSERT predicate and the shared current predicate at `objects.ts:55,181`. The shared predicate is reused for request selection, claim, save/replay, authorized and complete, so unavailable retained source data can no longer admit new work or keep a stale lease current. Existing source identity/generation/consent/tenant/lease guards remain. Test setup explicitly restores synthetic source availability and retains all earlier assertions.

Independently observed repaired adapter SHA-256 `cba8b628c9f733c6feb1ff9c1a236a45639152d223092b06c7a5f0129b352f70`; test `98eca7fe8a4ed45003f8dbace7159d62cdd14dbdcef8bd3914669fccfe3492d3`. Root confirms migration/core/cleanup hashes unchanged from the five-file snapshot above.

Read actual `/tmp/invoxim-archive-tombstone-red.txt`: two intended behavioral failures, 28 filtered/skipped for the focused RED, exit 1 reported by root, 1.76s/08:15:08. Existing-work authorization returned true after tombstone, and new admission resolved rather than rejected. Read `/tmp/invoxim-archive-tombstone-green.txt`: one file, 30/30 passed, no skips, 1.99s/08:15:17, exit 0 reported by root. Existing-work native assertions now deny authorization/save/complete/reclaim and retain pending state with null remote ID; new unavailable-source request rejects CONFLICT and asserts zero inserted archive rows. Root records scoped Biome/ESLint/Prettier exit 0. Reviewer did not execute these tests/checks.

Exact executed command and durable preservation provenance requested from root; no invented command is supplied. Historical full verify 1445/security 338 remain pre-repair evidence. Root plans fresh whole-source gates after current writer freeze; this scoped approval does not claim those have run or complete full archive workflow/live/restore gates.

Root subsequently supplied exact GREEN provenance, session 17933 completed exit 0:

```text
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/invoxim-archive-tombstone-green.log pnpm --filter @invoxim/worker exec vitest run test/archive-objects.test.ts > /tmp/invoxim-archive-tombstone-green.txt 2>&1
```

Corresponding focused RED used `-t 'source tombstone|unavailable source'`, session 88455 completed exit 1 with two failures/28 filtered. Raw outputs are now preserved as `t18-archive-objects-tombstone-{red,green}-20261013.txt`, with `t18-archive-objects-tombstone-log-map-20261013.json` and repaired `t18-archive-objects-reviewed-source-20261013.json`. This resolves the requested command/preservation provenance without another execution. Root confirms no further mutation planned for the five reviewed files absent another finding.
