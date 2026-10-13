# T18 bounded archive dispatch/backfill checkpoint

Task T18 / M1. Status: **incomplete; bounded implementation ready for review**.
This extends the reviewed Drive checkpoint `4834a57`. The orchestrator owns the next scoped commit, shared Worker assembly and broader completion evidence. No live upload or provider authorization was performed.

## Implemented boundary

- Provider-neutral archive delivery and explicit-backfill ports live in core. Archive execution remains the existing object lease; delivery adds only a durable reservation and globally unique opaque queue ID.
- The native outbox derives tenant authority from its stored object, checks current source/document/mailbox/Drive/archive selection, reserves before send, retains ambiguous/failed send reservations and rejects stale dispatch/object settlement fences.
- Queue envelopes have exactly `{schemaVersion:2,archiveId}`. Extra tenant fields are poison and produce ACK without database reads or workflow execution. Queue consumption captures the actual successful object lease through the trusted synchronous observer; it never guesses a later execution fence.
- Successful progress settles as durable continuation without incrementing transient failures. The maximum error settlement path is one fenced release, one outbox mutation and one authoritative lookup. The factory takes the same invocation's physical `remainingStatements` callback and reserves capacity before dispatch/consume.
- Due enumeration bounds the raw outbox prefix before authority checks. Invalid members are retired with fenced metadata updates instead of searching arbitrarily farther for eligible work. Candidate retirement and reservation are both included in dispatch's bounded-prefix capacity calculation.
- An explicit recent server-verified session creates a frozen 100-document membership snapshot and truthful `hasMore`; no AI-processing consent or processing-job foreign key is required. Late documents are outside that snapshot.
- Page admission reads at most five members and submits one atomic native batch, gated by the exact current run lease/revision/cursor, active profile and unchanged Drive/archive selection. Source/document/mailbox grant checks gate admission. New objects capture exact source/document metadata; same-source/same-Drive-subject pending reauthorization preserves immutable upload plans. Existing valid automatic dispatches remain independently owned.
- Cancellation invalidates object leases and dispatches owned by the selected backfill run, without canceling pre-existing automatic work or deleting Drive files.
- The approved existing-file changes only export unchanged object eligibility SQL and capture actual claim leases in the concrete workflow. Observer failure follows fenced release; no successful-path extra query was added.

## Changed specialist paths

- `packages/core/src/archive/queue-types.ts`
- `packages/core/src/archive/backfill-types.ts`
- `packages/adapters/src/drive/dispatch-store.ts`
- `packages/adapters/src/drive/queue.ts`
- `packages/adapters/src/drive/backfill.ts`
- `packages/adapters/src/drive/objects.ts` (approved eligibility-helper export only)
- `packages/adapters/src/drive/workflow.ts` (approved claim observer only)
- `apps/worker/test/drive-queue.test.ts`
- `apps/worker/test/drive-backfill.test.ts`

The root-owned `0006_archive_dispatch_backfill.sql` migration provides dispatch/run/membership tables. The specialist did not edit the migration, global barrels, routes, bindings, lifecycle or existing job store.

## Actual evidence

The orchestrator executed all native tests; this specialist executed only light scoped source checks.

Command for both initial and next queue/backfill phases:

```sh
pnpm --filter @invoxim/worker exec vitest run test/drive-queue.test.ts test/drive-backfill.test.ts
```

- Initial behavioral RED: `/tmp/invoxim-drive-dispatch-backfill-red-v1.txt`, exit 1, three intended UNAVAILABLE stub failures, two files, 9.22s. Real native schema/session fixtures reached the intended behavior.
- Initial GREEN: `/tmp/invoxim-drive-dispatch-backfill-green-v1.txt`, exit 0, three passed/two files, 10.33s.
- Next behavioral RED: `/tmp/invoxim-drive-next-red-v1.txt`, exit 1, four failed and three passed/two files, 9.69s. `admitPage`, `consume` and `dispatch` hit deliberate typed stubs; due enumeration incorrectly returned a later eligible item beyond the raw prefix. No missing import or setup failure was counted as RED.
- Next GREEN: `/tmp/invoxim-drive-next-green-v1.txt`, exit 0, **seven passed/two files**, 9.69s, zero skips.
- Orchestrator observer/helper native regression: `/tmp/invoxim-drive-observer-regression-v1.txt`, exit 0, **158 passed/seven files**, 20.21s. The raw log does not embed the full command argv; no reconstructed argv is presented as executed. This regression covers the earlier observer/helper extensions, not broad Worker queue integration.

Latest source checks actually executed, all exit 0:

```sh
pnpm exec prettier --write packages/adapters/src/drive/queue.ts packages/adapters/src/drive/backfill.ts packages/adapters/src/drive/dispatch-store.ts
pnpm exec biome check packages/adapters/src/drive/queue.ts packages/adapters/src/drive/backfill.ts packages/adapters/src/drive/dispatch-store.ts --error-on-warnings
pnpm exec eslint packages/adapters/src/drive/queue.ts packages/adapters/src/drive/backfill.ts packages/adapters/src/drive/dispatch-store.ts
```

The two test files also passed scoped Prettier/Biome/ESLint before their RED run. Whole workspace types/build/security/E2E after this latest increment: **not executed by this specialist**. Independent review of this increment: **pending**.

The seven native cases cover authoritative opaque IDs/tenant denial/consent invalidation; a single reservation winner and stale-fence settlement refusal; strict poison-envelope ACK; actual captured object lease continuation; failed send persistence; invalid raw-prefix retirement; frozen 100-membership/late-document exclusion; and bounded page admission with cancellation ownership. These are local subcases of DRIVE-01/04/05 and LATE-DRIVE-02, not completed provider-contract E2E acceptance IDs.

### What the budget witnesses prove

- Page admission uses seven native statements by implementation (run check + member read + five-statement atomic batch); the native assertion bounds actual page statements to at most 12.
- The synthetic continuation workflow performs a real claim/release and final durable settlement; its actual native assertion bounds the entire consume path to at most six statements on the shared 40-statement meter.
- Failed-send dispatch is bounded to at most four actual statements in its native witness.
- No standalone store counter is presented as full real-upload queue budget proof. The required real credential/source/Drive workflow plus Worker prefixes and queue settlement still needs composition evidence.

## Effects and remaining work

No mailbox/provider HTTP call, inference call, ledger mutation, arbitrary receipt-link fetch, bytes persistence, plaintext resumable-session storage or infrastructure provisioning was added. Tests use synthetic sessions/grants and native D1. The queue tests inject a metadata-only workflow to prove settlement ownership; they do not prove real original retrieval/upload or ledger preservation through provider errors.

Required root integration remains: strict schema-2 routing on the existing JOBS binding; actual guarded upload workflow composition with the constructor `onClaim` option; one shared invocation meter; mixed processing/archive concurrency; atomic fresh-document admission without replay re-enqueue; explicit backfill routes/contracts/capabilities/CSRF/session guards; lifecycle leaf cleanup/restore suppression; original links/badges and missing/quota/revoked/recovery UX; complete migration-chain tests; independent review and actual local queue/upload composition. Operators must configure/provision approved bindings before live operation. Full T18 remains incomplete.

Required review/test gaps include mid-page consent/source changes with full-batch rollback, real claimed-work error/takeover/deadline races, realistic consumed meter prefixes through the queue factory, missing/deleted snapshot members, finishing later pages, and pending-plan reauthorization ownership. In particular, review should check that an obsolete pre-existing ready outbox reauthorized by an explicit backfill cannot escape that backfill's cancellation merely because it was originally automatic. This boundary is not asserted by the current seven cases and must not be silently described as proven.

## Frozen hashes

```text
5df14e819dc8ae6225e8353609b1c7b0e41a381eabedf071bdc88141c12464f6  packages/adapters/src/drive/backfill.ts
0ed0c797ff5e657a9d04aa0bfdb618038e441462c41b7202422ce66f2b4998bc  packages/adapters/src/drive/queue.ts
0986dfbbb1e56f5101ba27069cb31fcb36e5b8cc63425071bd5c89aa7cda20b3  packages/adapters/src/drive/dispatch-store.ts
255baf138e4c50b69f713c081a69a6a471bcfcc6f2be69b349330d052fe953ca  packages/adapters/src/drive/objects.ts
327496f4c20354332307b3fb66e679bcf5e07c2e43a3ec7d1176aedf3e2f1bf6  packages/adapters/src/drive/workflow.ts
e5b5e3b7ac795607327c8d1b8de77ccc97db6d5e11756ee6127debab39440a23  packages/core/src/archive/queue-types.ts
bff66510384b689731e650a797e99702a7454633ae12e6f5ada57a6a02728b99  packages/core/src/archive/backfill-types.ts
84a6552299f628c721254501322c4546b01925f75b35b71537788b110f965bd1  apps/worker/test/drive-queue.test.ts
c6c897512eca206f0de02e54a181caa3df242672c6ed9e23255d059d56fdfd14  apps/worker/test/drive-backfill.test.ts
```

## Scoped type integration repair

After the seven-case GREEN, root reported two TypeScript narrowing errors in the nested queue settlement helper. The helper now uses the already validated authoritative `work.queueId`, without a cast or non-null assertion. A scoped adapter typecheck also exposed that the adapter runtime signature of `clearTimeout` excludes `undefined`; final cleanup now calls it only when a timer exists. These are type-safe control-flow repairs without a new feature or weakened behavioral oracle.

Actually executed:

- `pnpm --filter @invoxim/adapters typecheck`: first exit 1 for `clearTimeout(number | undefined)`; after the defined-timer guard, **exit 0**.
- `pnpm exec prettier --check packages/adapters/src/drive/queue.ts`: exit 0.
- `pnpm exec biome check packages/adapters/src/drive/queue.ts --error-on-warnings`: exit 0.
- `pnpm exec eslint packages/adapters/src/drive/queue.ts`: exit 0.

Updated frozen queue source SHA-256: `ba50c1337869b1add1febf5d8b1876d6325f6ba1cdb7390cee70ed21510e7a8d`. Earlier source hashes and seven-case proof above are historical; root-broker behavioral rerun of this repair is pending.

## Explicit reauthorization ownership repair

Root resumed the bounded ownership gap recorded above. Only `backfill.ts` and `drive-backfill.test.ts` changed; `dispatch-store.ts` remained unchanged. The source remains frozen for independent review and root checkpointing.

The five-member read now captures each prior object authorization/fence and delivery status/fence. The atomic batch first verifies this bounded snapshot alongside its existing current run lease/cursor/consent gate. A ready/retry delivery is adopted by the explicit backfill only when that same batch changes the exact pending object's settings/storage generation and increments its observed object fence once. Valid current automatic deliveries remain independent. Adoption retains the globally unique opaque queue ID and immutable preallocated upload plan, clears the old delivery reservation and increments its delivery fence. Exhausted delivery counters prevent pending-object reauthorization rather than leaving a newly authorized object outside cancellation ownership.

A failed atomic gate is classified by one bounded reread: changed lease/page/selection yields `CONFLICT`; other native failures remain redacted `UNAVAILABLE`. No source, ledger, provider, schema or shared runtime changes were made. Happy-path admission remains seven statements; the raced-gate path adds one classification read. Both meaningful native tests assert at most twelve actual admission statements on the same invocation meter.

Behavioral RED actually executed by root:

```sh
pnpm --filter @invoxim/worker exec vitest run test/drive-backfill.test.ts
```

`/tmp/invoxim-drive-ownership-red.txt`: exit 1, two new failures and two existing passes, 5.84s. The obsolete automatic work incorrectly reported admitted=0 instead of 1; consent revocation between member reads and batch incorrectly surfaced `UNAVAILABLE` instead of `CONFLICT`. Setup and native fixtures succeeded.

GREEN evidence: `/tmp/invoxim-drive-green-outlook-red.txt` is a **combined run with exit 1**, caused by unrelated intentional Outlook RED cases. The Drive subset alone passed **four backfill and five queue tests (nine total)**. No combined exit-0 claim is made. The exact combined argv is not embedded in the raw log; it is not reconstructed here as executed.

The new ownership witness preserves the entire original plan, retains the queue ID, rejects the old reserved-delivery settlement, cancels the reauthorized active object lease and adopted outbox, and proves still-current automatic work stays ready with no backfill owner. The revocation witness changes actual archive consent after the bounded reads and before native batch admission, then asserts `CONFLICT`, zero admitted objects/outbox rows, and unchanged run cursor/revision/lease/fence.

Light scoped commands actually executed, each exit 0 after the repair:

```sh
pnpm exec prettier --write packages/adapters/src/drive/backfill.ts apps/worker/test/drive-backfill.test.ts
pnpm exec biome check packages/adapters/src/drive/backfill.ts apps/worker/test/drive-backfill.test.ts --error-on-warnings
pnpm exec eslint packages/adapters/src/drive/backfill.ts apps/worker/test/drive-backfill.test.ts
```

Independent review is pending. Full T18, full real queue/upload composition, later/deleted-page cases, broader takeover/deadline races and actual release verification remain incomplete. The earlier obsolete-ready ownership limitation above is historical; these two native witnesses close that specific boundary, not all remaining backfill acceptance cases.

Updated frozen SHA-256:

```text
750e6b7142cce375c9bba50bb84c2ff047c920aec8a56f4ae9e357086c38eeb0  packages/adapters/src/drive/backfill.ts
0986dfbbb1e56f5101ba27069cb31fcb36e5b8cc63425071bd5c89aa7cda20b3  packages/adapters/src/drive/dispatch-store.ts (unchanged)
3c5511f95ed91563c705ba80b196853ef875c2cf587b10a02f5d757c95844978  apps/worker/test/drive-backfill.test.ts
```

The combined ownership run had three files/22 cases: nine Drive passes, two unrelated Outlook passes and eleven intentional Outlook failures; duration 9.83s, exit 1. After this behavioral proof, integrated TypeScript reported that spreading the D1 class type dropped its method declarations in the synthetic revocation wrapper. The fixture now forwards `prepare`, `exec`, `withSession` and `dump` explicitly to the same metered database. The overridden batch still injects the same native consent race; no casts, non-null assertions, source behavior changes or counter bypasses were added. Scoped test Prettier/Biome/ESLint again exited 0. Updated frozen fixture SHA-256: `465d9c3dfedc2303cd18c63b3774d548b9ef11c218a79cc190d950e4cd1d3dae`. Root integrated type/native rerun after this fixture-only repair is pending.

## Ownership and consent-race repair, root checkpoint

Two new native RED witnesses both failed for intended behavior: `/tmp/invoxim-drive-ownership-red.txt`, exit1,2fail/2pass,5.84s. Obsolete automatic delivery was not adopted by the explicit backfill; a mid-page consent change reported UNAVAILABLE rather than CONFLICT. Implementation now fences the bounded object/outbox snapshots inside the native batch, adopts only the exact reauthorized obsolete plan/outbox, retains immutable upload IDs, and associates cancellation with the adopting run. Current unrelated automatic work remains independent. Native consent race rolls back object/outbox/cursor effects.

Combined validation `/tmp/invoxim-ai-runtime-final-green.txt`, exit0,104tests/ninefiles24.54s includes4backfill+5queue cases (nine Drive cases),77AI and18Outlook. No standalone Drive-only command is claimed. The corrected synthetic race wrapper forwards real D1 methods explicitly. Root five-package typecheck passed `/tmp/invoxim-m1-period-typecheck-v2.txt`; root scoped Biome/Prettier/ESLint of nine Drive/core/test paths passed. Independent read-only reviewer `deployed_login_browser_qa` approved bounded ownership/fencing/source migration checkpoint and inspected earlier combined evidence; reviewer did not execute tests.

This remains an adapter checkpoint. Backfill currently freezes only the first100-document cohort and reports hasMore; later cohorts are not yet traversable. Full Worker dispatch/upload composition, actual whole-operation budget, lifecycle leaves, routes/UI, populated upgrade and complete migration-chain proofs remain required. No Drive activation/deployment or provider call occurred. Earlier158-case observer regression is historical and not a substitute for the final integration tests. Main primary checkout preserves all unrelated owner changes.

## Full frozen cohort continuation — pending native GREEN

Root approved the necessary immutable-order extension. The specialist owns only core backfill ports, Drive backfill/dispatch store paths, native backfill tests and this report. Root owns additive `0007_archive_document_order.sql`, the shared cancellation-aware object execution predicate and the separate base admission predicate. Remotely applied `0006` was not changed or replayed by this specialist.

Actually observed root behavioral RED:

- `/tmp/invoxim-drive-cohorts-red.txt`: exit 1, four failures/four passes/eight cases, 7.14s. Missing full frozen cutoff, missing immediate canceled-run execution denial, deliberate advance UNAVAILABLE and failure to adopt canceled same-consent work. Real trigger-aware migration fixtures succeeded.
- `/tmp/invoxim-drive-cleanup-cap-red.txt`: selected numeric-cap case, exit 1, one failure/eight filtered cases, 6.16s. Original bulk-cancel gate wrongly blocked all cancellation when one object/delivery counter was exhausted. Filtered cases were not counted as executed.

The implementation now captures an immutable document-order cutoff at explicit start. `advance(lease)` replaces only the exhausted bounded membership window with up to 100 later IDs at or below that cutoff, under the same run identity, exact lease/revision/cursor/frontier and current archive permission. It never selects by a receipt date or arbitrary UUID maximum. Late insertions and deleted/reinserted identities cannot enter this approval. Admission remains five live members per invocation. `processedCount` counts visited admission slots, including unavailable positions; it does not count successful uploads. Legacy NULL-cutoff runs retain the approved original window and refuse invented continuation.

Cancellation first commits the authoritative run flag. Root's shared predicate denies subsequent object claims, actual HTTP boundary checks, plan/progress publication and completion for run-owned canceled work. This does not promise that a provider call already issued can be physically undone. `cleanupCanceled(context,runId)` then retires a raw indexed prefix of at most 100 paused/ready/retry deliveries, with snapshot guards, selected-ID native updates and an indexed remaining-work check. Archived objects remain archived/completed. Exhausted counters never overflow or reset; lease clearing and cancellation still proceed. Repeated cleanup remains durable under the same run, without a new queue or execution lease. Root must schedule remaining canceled-run cleanup until its `done` result is true.

Same-consent explicit restart uses the root-owned base admission predicate only inside the guarded backfill batch. It resets the previous canceled object's lease and increments its non-exhausted fence before switching outbox ownership, while retaining the original immutable plan and opaque queue ID. The execution predicate remains cancellation-aware everywhere else. Unrelated valid automatic work remains independent.

Latest light scoped Prettier/Biome `--error-on-warnings`/ESLint on the three changed specialist source/test files: exit 0. No heavy/native test, remote provider operation, deployment or commit was performed by this specialist.

The nine backfill cases now include a 205-document frozen-range witness, three membership windows, late and delete/reinsert exclusions, four consumed prefix statements plus three real settlement probes on the same 40-statement meter for each admission/advance/cancel/cleanup stage, bounded cleanup of 100+100+3 deliveries, immediate denial before physical cleanup, legacy refusal, exact-plan restart ownership and exhausted-fence recovery/refusal. These are authored witnesses pending native GREEN, not executed acceptance claims.

Root-broker GREEN request (not yet recorded as executed):

```sh
pnpm --filter @invoxim/worker exec vitest run test/drive-backfill.test.ts test/drive-queue.test.ts test/archive-objects.test.ts
```

Full T18 runtime/UI/source-link/backfill scheduling and lifecycle composition remain incomplete. The new migration and shared predicate need root's integration/upgrade and independent-review evidence; existing old snapshot evidence remains historical.

Frozen specialist hashes for this pending stage:

```text
87c9504fbe8a18da4a72258bb7eba2ec856d0faa8bde15ab12b8499c5d939414  packages/adapters/src/drive/backfill.ts
72cf3bf7a9227020ec5ada7111b40192bf73560b331530e0ce07466fd84169b9  packages/core/src/archive/backfill-types.ts
24d3d3de5a2495bab87832de5b14be75a17748798d2e4beb87bfc9b81bb56b48  apps/worker/test/drive-backfill.test.ts
0986dfbbb1e56f5101ba27069cb31fcb36e5b8cc63425071bd5c89aa7cda20b3  packages/adapters/src/drive/dispatch-store.ts (unchanged)
```

First combined continuation GREEN attempt: `/tmp/invoxim-drive-cohorts-green.txt`, exit 1, **62 passed/one failed/63 cases**, 12.84s. The sole failure was the shared object release guard refusing the exact active canceled lease; root repaired its owned release guard to permit only exact lease ownership with base admission authority. HTTP, plan and completion predicates remain cancellation-aware. This failed attempt is preserved as evidence and is not reported as a passing run.

At root's request, four test-only coverage cases were added without changing the specialist implementation: deleted current-window ordinal positions (including deleted tail) distinguish visited slots/skipped unavailable members from actual uploaded originals; a native fault immediately after DELETE restores the whole window/frontier/revision; and consent/revision races before batch preserve the complete metadata snapshot apart from the independent actor's own change. Each attempted gap/advance phase uses the same actual 40-statement meter with four consumed prefix statements and three settlement probes. These additional cases are pending root execution, not fabricated new RED failures. The backfill suite now has thirteen cases. Scoped test Prettier/Biome/ESLint exited 0. Updated frozen test SHA-256: `bd0e76cda369369372b0fa50b3e0442845ba873d537ac2f3e885142b9b75f8c2`; specialist implementation hashes above are unchanged.

## Final bounded continuation validation — 13 October 2026

The previous pending native requests above are now superseded by root's actual terminal result: `pnpm --filter @invoxim/worker exec vitest run test/drive-backfill.test.ts test/drive-queue.test.ts test/archive-objects.test.ts test/archive-backfill-migration.test.ts`, `/tmp/invoxim-drive-cohorts-green-v2.txt`, exit 0, 67 cases / four files in 12.80 seconds. This includes 13 backfill cases, five queue cases, 30 object cases and 19 migration cases; the migration run includes the final cleanup index.

Four additional coverage cases passed without manufacturing RED: deleted current-window ordinal gaps count seven visited positions, admit four objects and publish zero archives; a native failure after membership deletion rolls back the entire window; consent and revision races before advancement preserve membership/frontier and refuse stale authority. The first combined attempt's 62 passes / one failure is retained above. Root changed release only to clear an exactly owned unexpired lease under base admission authority; execution/plan/session/complete guards still deny canceled work. The incremented fence rejects a later attempt to reuse an adopted object's old lease.

Independent read-only review by `fx_period_acceptance_qa` inspected the final source, new coverage and terminal result and approved the bounded increment. The reviewer did not execute tests. Final scoped Prettier/Biome/ESLint passed; `pnpm typecheck` passed five tasks in 5.117 seconds, four cached (`/tmp/invoxim-m1-start-cohort-types-final.txt`). Full repository verification stopped in the main workspace's secret-scan bound because of an unrelated 78 MB untracked local log; no scan bound was changed. Frozen-source verification will use the attached isolated checkout. Runtime/queue scheduling, routes/UI, lifecycle integration and live Drive remain unfinished; no remote migration, upload or activation occurred.
