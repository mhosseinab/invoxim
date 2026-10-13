# T18 document order migration checkpoint

Scope: additive `0007_archive_document_order.sql`, native migration coverage and existing archive fixture schema updates. No remote migration, deployment or archive activation was performed.

The catalogue gives document metadata an immutable admission order. A future explicit backfill can freeze a sequence cutoff and enumerate bounded windows; late inserts and deletion/reinsertion cannot enter the approved range. Existing `0006` runs retain a NULL cutoff and their original window. The applied `0006` migration is unchanged.

Context7 tools were unavailable. Primary [SQLite AUTOINCREMENT documentation](https://www.sqlite.org/autoinc.html) confirms non-reuse of committed deleted sequence values; [D1 batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/) confirms rollback of a failed batch. Native tests verify actual behavior rather than relying on those statements alone.

## Executed evidence

- First native migration validation: `/tmp/invoxim-drive-order-migration.txt`, exit 1, 1 passed / 18 failed. Failure was repeated schema creation in a shared per-file fixture, not migration behavior. The fixture now explicitly recreates the relevant synthetic schema before each case; assertions were preserved.
- Corrected validation: `pnpm --filter @invoxim/worker exec vitest run test/archive-backfill-migration.test.ts`, `/tmp/invoxim-drive-order-migration-v2.txt`, exit 0, 19 passed, 1.26 seconds. Clean install, populated upgrade, unchanged legacy approval, stable UPSERT ordering, deletion/reinsertion, composite ownership and invalid-write rollback are covered.
- Existing object/workflow/resumable/queue regressions: `/tmp/invoxim-drive-cancel-regressions.txt`, exit 0, 53 tests / 6 files, 21.86 seconds. Five old fixtures now include `0006` so the execution cancellation predicate can query the real dispatch/run tables; assertions are unchanged.
- Scoped TypeScript test formatting, Biome and ESLint passed. SQL is checked through native migration execution; the configured Prettier has no SQL parser.
- Independent read-only review by `outlook_runtime_map` accepted the migration structure. It identified an execution/admission cancellation conflict in the proposed integration; root and the implementer are addressing it separately.

Rolling backfill, new-run reauthorization, scheduling, routes/UI and live Drive verification remain separate unfinished work. These checks do not establish full T18 or MVP completion. Review backup and apply the additive migration only with the corresponding verified release.
