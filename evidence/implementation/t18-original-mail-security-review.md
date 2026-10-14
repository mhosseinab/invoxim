# ORIGINAL-01 independent resource repair re-review

Reviewer: separate read-only security agent `/root/m0_security`. Task: bounded T17/T18 transient original reader resource repair. Decision: ORIGINAL-01 closed for the exact frozen source/test snapshot below; approve this repair only. No native tests, provider calls or source/test edits by the reviewer.

## Source and evidence inspected

Read the current complete `packages/adapters/src/documents/original-mail.ts`, new fragmentation/deadline tests and existing exact-byte/abort/late-response tests in `apps/worker/test/original-mail.test.ts`, and `t18-original-mail.md`. Current SHA-256 independently observed:

- Adapter: `63832021a8b4feef72e4b18c9d46a3d3e29003eb223e6d5aeb38f4a88b669ce0`.
- Test: `a1f94ea0b918bc271184fa21eba25af0292df60e67fb43e515434c18942ea4b3`.
- Unchanged core original port: `dd23a7ba725a2c73e7220445e81243e0d381985b51b9d79e50f3d1f38b3927bb`.

The reviewer used only read commands/hash inspection and wrote this report. A combined read command ended exit 1 because its final optional filename search had no match; its hash and raw-log outputs were obtained successfully. This is not a verification/test failure or an executed native gate.

## Finding and closure

ORIGINAL-01 was a required resource finding: collecting every tiny/empty chunk in an array left memory and immediately fulfilled read work unbounded by the byte cap, and could delay the timer callback. The smallest repair replaces the chunk array with one limit-sized buffer, copies admitted bytes immediately, counts every non-EOF chunk (at most 4096, including empty chunks), and separately caps total empty chunks at 32. Reads beyond these bounds refuse with controlled UNAVAILABLE and cancel the reader. It retains no producer chunk array and returns only the filled subarray; accepted bytes are not normalized or truncated.

An absolute aggregate deadline now checks before requests, after fetch settlement, before/after each read and before ready. The existing timer and caller abort race interrupt pending I/O; absolute clock checks cover already-resolved reads. The two Graph calls still share the deadline. Fetch settlement after timeout/caller abort cancels unread response bytes; reader failures cancel and release locks; final cleanup aborts owned signals, removes listeners/timers and cancels received bodies. Existing byte caps, fixed host/me scope/source-ID correlation, no redirects and exact MIME representation behavior remain.

No further required finding in this patch. Very fragmented legitimate provider responses can now be refused; this is an explicit bounded transport policy, not partial original success. The returned subarray keeps its bounded backing allocation alive until the caller releases it; it is still bounded by the validated response limit. Provider-produced chunk allocation remains outside the application's allocation authority.

## Actual execution inspected, not executed by reviewer

Implementer/executor reports these exact serialized native commands:

```text
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/invoxim-original-chunk-red-20261013.log pnpm --filter @invoxim/worker exec vitest run test/original-mail.test.ts -t 'excessive .* chunks|normal fragmented|elapsed deadline'
exit 1: three intended resource/deadline failures, one normal-fragmentation positive, 43 filtered (47 total), 1.65s

WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/invoxim-original-chunk-green-20261013.log pnpm --filter @invoxim/worker exec vitest run test/original-mail.test.ts
exit 0: 47/47 passed, no skips, 1.76s
```

Evidence: preserved `t18-original-mail-chunk-red-20261013-042922.txt` and inspected raw `t18-original-mail-chunk-green-20261013-043323.txt` (04:33:23 start). Tests refuse the 33rd empty chunk and excessive tiny chunks below the byte limit, assert actual cancellation and bounded pull count, use a mocked advancing elapsed clock to deny before ready, and retain a byte-equal positive with normal fragmentation. Original 43 cases remain in the unfiltered run. Scoped Worker/adapters typechecks and lint/Biome/format exit-0 evidence are recorded by the implementer; this reviewer did not rerun them.

## Scope limitations

This supports exact transient MIME-original retrieval for DRIVE-02 and source-missing recovery only. It does not establish actual tenant/source/generation/archive-consent authority: root must guard the server-selected token and provider around actual outbound requests. Storage authorization, archive enablement, upload idempotency/checksum/recorded availability, PDF/image attachment selection, source change races, full Outlook content processing and live provider MIME compatibility remain separate gates. No originals were persisted/uploaded, no financial state changed, and no live API or regulatory/full T17/T18/M1 approval is claimed.
