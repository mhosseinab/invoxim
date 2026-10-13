# Gmail runtime dispatch and AI request contract repair

Two scheduler repairs remove an idle cursor-wrap tick and fill up to the configured dispatch batch while preserving serial lease execution. Commits 006c6b1 and 799399d passed full `pnpm verify`: 1374 native Worker tests across 111 files, 84 browser tests, unit checks, lint/format, types, builds and production publication guard; exit 0. Log: `/tmp/invoxim-gmail-runtime-dispatch-verify.txt`.

Production metadata then showed five completed AI extractions classified `needs-review` / `schema`, with no extracted values or model transcripts inspected. The configured Abacus model accepts JSON-object output; the adapter asked for the receipt schema without supplying it. Fallback requests now append the exact code-owned schema to the trusted system message. Strict output validation and selected destination/model are unchanged. Reservations still account for the actual serialized request. New requests use prompt v3; supported v1/v2 checkpoints remain compatible. Existing billed review results are not automatically replayed.

RED: the new request regression failed two fallback cases and passed the schema-capable control, exit 1, 1.52 seconds; `/tmp/invoxim-ai-schema-prompt-red.txt`. Independent read-only source review approved the minimal schema and prompt-version patch. Initial focused run passed 72/75 cases, identifying three old fixtures with insufficient fixed reservations; the three fixtures now reserve their actual request size, preserving the under-reservation refusal test. Final focused GREEN: 123 tests across ten files, exit 0, 19.76 seconds; `/tmp/invoxim-ai-schema-prompt-final-green.txt`. Final `pnpm verify` passed, exit 0: 1377 native Worker tests across 112 files, 379 core tests, 48 contract tests and 84 browser tests, plus lint/format, types, builds and production publication guard. Log: `/tmp/invoxim-gmail-runtime-final-verify.txt`.

Deployed Worker version `f40f250e-991e-467d-b903-da02b5227e4b`, independently confirmed active at 100%. Post-deployment metadata shows the first v3 extraction accepted, reconciliation completed, processed_count increased to 1, and discovered_count increased to 13. Purchase count remained zero at that observation; an accepted extraction can contain no purchase records, and historical five schema failures remain open review items. These are status/count checks, not a review of private financial fields or a quality claim for every document. No database migration, provider change, permission widening, allowance increase or active concurrency increase is required.

## Operator checklist

- [x] Gmail API enabled by owner; Start succeeded.
- [x] Queue producer/consumer and minute Cron configured and deployed.
- [x] Runtime repair verified, committed and deployed from isolated source.
- [x] Live accepted v3 inference and completed reconciliation observed.
- [ ] Refresh Connections/Needs attention to inspect progress and existing review items.
- No migration, mailbox reconnection or new provider configuration is required for this repair.
