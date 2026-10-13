# Independent review report

Task: T17 Outlook exclusion and Retry-After floor follow-up, 2026-10-13.
Reviewer: separate read-only audit agent; not the production implementer. This agent previously wrote an unrelated FX QA test file, not any Outlook implementation or test.
Diff identity: working-tree changes to packages/adapters/src/discovery/outlook-state.ts, outlook-job.ts, outlook-delta.ts, migration 0004_outlook_folder_exclusions.sql, and apps/worker/test/outlook-state.test.ts, outlook-job.test.ts, outlook-coordinator.test.ts.
Execution performed by reviewer: read-only source/diff/log inspection; no native test execution, production edits, or test edits. Only this review report was written.

## Findings

No actionable implementation finding in the reviewed scope.

The long-floor branch in outlook-state.ts deferRate scopes the selected parent to tenant, connection, and trusted lease sync-state ID. Its parent UPDATE compares discovery_version and repeats live authorization: job identity, lease ID, fence, deadline, connection generation/state/provider/scope, active tenant and accepted, unrevoked consent. The parent mutation advances discovery_version and writes a fresh nonce. Import-stage and final-job updates require that exact parent version/nonce and the live guard; job completion additionally requires the linked import to be paused_rate. A stale parent CAS therefore cannot authorize downstream completion. The dependent statements use one native batch; statement failure rolls back the prefix. No provider-controlled identifier or delay becomes tenant authority.

A finite floor above one day, or an unusable non-finite floor, pauses the parent/import and completes the current job with rate_paused. It creates no ready continuation and does not convert the floor into an early retry. Finite supported floors schedule at Date.now()+max(1000,floor), retain the inventory opaque cursor and version, and complete only after a tenant-scoped ready continuation exists. Neither path increments failure attempts. Ordinary database headroom exhaustion still uses budget; the successful provider-floor path persists paused_rate rather than paused_budget.

The runner checks checkpoints around provider/alias calls and validates opaque folder IDs. Four exact distinct well-known alias IDs are persisted on the generation-scoped root inventory. Migration 0004 limits that column to root rows, valid four-element JSON arrays and bounded length; the adapter additionally validates each ID and distinctness. Recursive exclusion queries scope both root and descendant traversal to tenant/connection/generation and use UNION to terminate duplicate/cyclic traversal. Selection, cursor seeding and incremental restart all exclude those descendants.

Cold alias work can atomically stage exclusions plus a ready continuation rather than restarting the expensive alias lookup. Root insertion/continuation/current-job completion share a unique commit nonce and live guard. Final inventory-page commit retains optimistic version checking and its nonce marker. No raw messages or provider display names are persisted as exclusion authority.

## Evidence inspected

- /tmp/invoxim-outlook-long-floor-red-v1.txt: exit 1; focused expected completion instead returned paused/budget. One failure, 18 other tests filtered/skipped.
- /tmp/invoxim-outlook-progress-red-v1.txt: exit 1; focused parent progression expected paused_rate but remained queued. One failure, 18 other tests filtered/skipped.
- /tmp/invoxim-outlook-floor-green-v1.txt: exit 0 reported by broker; 49 tests across 3 files passed, 4.26 seconds.
- Native test assertions cover long floor and transport sentinel, unchanged inventory cursor/version, rate_paused current job, unchanged retry count, paused_rate parent/import and zero ready continuations. Short-floor test checks future dispatch no earlier than its floor.
- Cold alias test includes real shared job claim/checkpoints and asserts durable continuation, stored aliases, current-job completion and at most 40 submitted statements. Reviewed state tests also cover tenant/generation isolation, stale version, consent revocation, rollback, cycles and bounded inventory.

Headroom accounting: supported deferRate submits two batch statements plus one read (3); long pause submits one parent read, two or three batch statements and one completion read (4 or 5). The runner reserves 3 or 5 after its authorization checkpoint. Cold alias staging submits three batch statements plus one completion read. Trigger work or D1 row costs are distinct from the submitted-statement meter.

## Decision

Approve this bounded follow-up based on inspected implementation and broker evidence. This approval does not claim full T17, production release, deployed migrations or live Graph acceptance.

Remaining limits: no live Graph/OAuth smoke was performed by this reviewer; synthetic provider refusal/floors do not establish live provider policy behavior. The long-floor focused test uses a synthetic control checkpoint; the cold-alias test separately supplies real shared claim/checkpoints. Existing native stale/rollback tests exercise inventory commits, while the new long-floor parent/import nonce guards were inspected rather than independently race-injected. Repository-wide verification and task integration remain the orchestrator's responsibility.
