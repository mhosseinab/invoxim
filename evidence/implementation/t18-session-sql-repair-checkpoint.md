# T18 native session-store SQL repair

Status: bounded store/migration slice locally verified and independently reviewed. Full resumable archiving remains incomplete.

The recoverable pre-refactor state is commit `11582e3`. Native D1 refused the nested session query with an expression-depth error. Explicit parenthesized logical groups reduce the expression depth while retaining every authorization predicate and its bind order. No tenant, source, consent, generation, lease, credential or immutable-plan guard was removed. The temporary synthetic diagnostic has been removed; its original failed output remains preserved.

Root native regression: `pnpm --filter @invoxim/worker exec vitest run test/drive-resumable-session.test.ts test/archive-objects.test.ts test/archive-objects-adversarial.test.ts test/drive-folders.test.ts test/archive-workflow.test.ts test/archive-workflow-transport.test.ts`, exit 0, 59 tests across six files, zero skips, 16.30 seconds. Raw evidence: `m1-runtime-checkpoints/session-guard-green-v2.txt`. Scoped warning-fatal Biome, ESLint and Prettier passed.

Independent read-only reviewer `/root/discovery_review` inspected the diff from `11582e3`, native evidence and migration. No required findings. The reviewer verified authorized absence, both credential fences, exact tuple matching, version CAS, expiry/progress bounds and composite ownership; no reviewer execution or edits.

Reviewed SHA-256: objects `5cc81e8bcf095e068fc61539525eef508951a18e2729c2a2632168c6da94f3b3`; session store `069dcaab23e9da22630d48b555f0bbd1ce7a818d9c1ca33f9277820f8be169e5`; migration `a97a4a3d1abf20443feb79ff09f11d5ef6522442c8392afeb654a6d4e90d3eb0`.

Consumer decryption/keyring checks, staged resumable composition, backfill, queue/UI integration, final whole-repository checks and live provider smoke tests remain required. No database reset, provider upload or deployment occurred.
