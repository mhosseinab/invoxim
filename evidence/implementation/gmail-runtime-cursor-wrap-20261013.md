# Gmail runtime dispatch cursor wrap

Scope: isolated release checkout `/home/geek/.codex/worktrees/release-runtime/invoxim`, branch supplied by the root `codex/gmail-runtime-dispatch-20261013`, deployed baseline `6eebd6c`. Main-workspace provider work remains frozen.

The shared scheduler page selected only users after the cursor. At range end, it reset the cursor and returned an empty page, leaving an idle dispatch tick even when the same active workspace had eligible jobs. Multi-workspace pages also stopped at the end rather than filling their remaining capacity from the wrapped range.

The fix uses two disjoint, ordered user-id ranges in the existing page statement, each limited to the requested page size. UNION ALL plus a constant wrap rank returns the later range first, then the wrapped range, with one overall limit. Active-profile filtering remains for dispatch/schedule; recovery still includes inactive profiles. The existing cursor-version CAS advances once per visited user. No reset query, extra database statement, schema, concurrency increase or provider/OAuth change was added.

## Evidence

- Genuine root-brokered RED: `pnpm --filter @invoxim/worker exec vitest run test/jobs-cursor-wrap.test.ts`; exit 1, three intended behavior failures, 1.95 seconds. `/tmp/invoxim-gmail-cursor-wrap-red.txt`.
- The cases use the actual job engine to dispatch discovery then extraction on consecutive single-workspace ticks, require cyclic fairness across three active workspaces while excluding an inactive workspace, and require a cross-boundary page to return each selected workspace once with six physical statements. Each dispatch invocation shares the existing actual 40-statement database meter.
- Scoped Prettier and Biome passed: two owned source/test files, Biome exit 0, 11ms. No heavy tests, Git mutation, provider call or remote change was executed by this implementer.
- GREEN, regression tests, typechecks, independent review and production release remain root brokered and pending at this handoff.

This repairs empty wrap ticks. It does not increase dispatch or lease concurrency and does not claim to eliminate all sources of runtime latency. The root is separately investigating actual enqueue/lease timing.
