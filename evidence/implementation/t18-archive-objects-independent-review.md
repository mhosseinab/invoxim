# T18 archive-object persistence independent architecture review

Reviewer: `/root/discovery_review`, separate read-only agent. Root persisted the review returned through the agent channel; no reviewer source edits or test execution occurred.

Reviewed: core archive-object interfaces, concrete Drive object store, migration 0018, M1 lifecycle leaf cleanup, archive-object tests and relevant canonical architecture/data/security requirements.

## Initial finding and decision

Request changes for ARCHIVE-OBJECT-01 (P2): request admission and the repeated leased-write predicate omitted `source_messages.available=1`. Tombstoning a retained source preserved its identity/hash/generation, so new requests and existing lease authorization/plan/commit/reacquisition remained possible. Add the guard to both predicates and prove unavailable-before-request inserts nothing, and unavailable-after-claim blocks continuation while preserving pending metadata.

Root accepted the finding and implemented the required native regressions and fix.

## Re-review returned by the independent reviewer

ARCHIVE-OBJECT-01 is closed. Approve the bounded archive-object persistence source.

Both admission and the repeated lease/mutation predicate now require `s.available=1`. The new tests cover unavailable-source admission and tombstoning after claim, including authorization, plan writes, completion and reacquisition. Inspected evidence shows genuine RED (2 failed, 28 filtered), followed by unfiltered GREEN (30 passed, zero skipped, 1.99 seconds). Reviewer inspected source/logs and independently hashed them; no execution or edits.

Re-reviewed hashes:

- Core: `f3fc95855958aeccc2febdf2b65398285d80422a7ae007a09cb4dae8b56c2e19`
- Adapter: `cba8b628c9f733c6feb1ff9c1a236a45639152d223092b06c7a5f0129b352f70`
- Migration0018: `08eb9ddee8bba62c7906eec11e82e15b81a9d6345087237f619eb0ec24a8ad69`
- Cleanup: `e96153288f31c7f58107141c983fb1ba188ab841bf73b54422f2570f843d71d3`
- Tests: `98eca7fe8a4ed45003f8dbace7159d62cdd14dbdcef8bd3914669fccfe3492d3`

Reviewer inspected tenant-qualified joins/composite ownership, exact lease ID/expiry/increasing fence, settings/mailbox/storage identity/generation/credential/scope guards, immutable document/source snapshots and upload-plan tuple, exact replay, bounded cleanup/current deletion authority and no remote deletion. These support persistence; they do not prove an actual upload succeeded.

## Evidence and limits

Historical full verification: 1,445 represented tests (22 tooling, 48 contracts, 372 core, 941 Worker, 62 browser); explicit security338/24files; focused88/6files. Those pre-repair whole-source results remain historical. The test-only populated-upgrade fixture adjustment was separately verified. Repaired source/RED/GREEN are preserved in `t18-archive-objects-reviewed-source-20261013.json` and `t18-archive-objects-tombstone-log-map-20261013.json`.

No outstanding required finding in this review pass. Approval excludes subsequent changes, new refresh work, full archive orchestration, resumable uploads/backfill, live providers and full T18 completion.

Root integration note: independent QA later identified a two-clock completion timestamp boundary. Its repair and fresh convergence checks remain pending; this earlier source approval does not certify that subsequent repair.

## Later single-clock completion re-review

Independent reviewer `/root/discovery_review` approves the repair for this metadata slice. `complete()` obtains one validated time used for both archived_at and the SQL expiry guard; availability/ownership/generation/plan guards remain intact. Inspected genuine RED (2000 not less than expiry2000) followed by31passing/2files, zero skips,6.85seconds. No reviewer execution or edits. Verified adapterSHA `b47774e61ac4d088223cdea791e10602443e8264a640ff3d630ac4093e772eb1` and independent QA testSHA `7d512eeeed0ecc1347d8757735416092407454436fb4f53b67ea4ffe0eec15d8`; other reviewed files match the availability-repair hashes. No outstanding required finding in this slice. Fresh whole-source gates, refresh integration and full T18 approval remain pending.
