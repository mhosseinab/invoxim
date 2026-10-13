# Gmail runtime bounded queue fill

Scope: managed release checkout `/home/geek/.codex/worktrees/release-runtime/invoxim`, baseline cursor fix committed by root as `006c6b1`. Main-workspace provider work remains frozen.

Job candidate selection tied the number of queued identifiers per workspace to the active lease concurrency. With production tenant concurrency one, a ready parse/infer/reconcile backlog supplied only one queue body per dispatch tick even though the approved global dispatch limit allowed five.

The candidate bound is now the smaller of the existing dispatch limit and statement reservation cap. All three indexed priority-branch limits, the combined per-workspace limit and the round-robin rank loop use that same bound. Global dispatch output remains bounded by the original dispatch limit. Claim admission, tenant/global active lease caps and platform consumer concurrency are unchanged. No schema, resource, provider, scope, inference allowance or concurrency change was added.

## Evidence

- Genuine root-brokered RED: `pnpm --filter @invoxim/worker exec vitest run test/jobs-dispatch-throughput.test.ts`; exit 1, three intended behavior failures, 1.85 seconds, `/tmp/invoxim-gmail-dispatch-throughput-red.txt`. The baseline queued one job where five were required, two where five fair interleaved jobs were required, and one where the review-enabled 24-statement budget reserved two.
- New native tests require five queue bodies in one tick, one held lease rejecting the other four claims, then sequential completion; two-workspace round-robin output under global five; and a configured processing-review/24-statement invocation's two-job cap. Each actual dispatch/claim/consume invocation shares the existing physical statement meter.
- Scoped Prettier and Biome passed after the minimal source edit. No heavy test, Git mutation, provider call or remote change was performed by this implementer.
- Root-brokered GREEN and regressions: 47 tests across six native Worker files passed, exit 0, 15.98 seconds; `/tmp/invoxim-gmail-dispatch-final-green.txt`.
- Scoped Prettier, Biome and ESLint passed. Full workspace typecheck passed (five tasks, exit 0); `/tmp/invoxim-gmail-dispatch-final-types.txt`.
- Independent read-only review approved the candidate bounds, global cap, serial lease admission, fairness and statement-budget behavior; no blocking finding. Full verification and deployment remain pending.

This removes an unintended enqueue bottleneck while preserving serialization of actual work. Five queued identifiers are not five simultaneous mailbox reads or inference calls. Existing dedupe, dispatch deadlines and lease fences are unchanged.
