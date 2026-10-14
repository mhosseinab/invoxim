# Worker release — 14 October 2026

User explicitly authorized deployment. Deployed `invoxim-api` default production environment to 100% at 07:25:52 Europe/Vienna (05:25:52 UTC).

Active Worker version: `aec0e475-e170-4d9d-b441-fe07a7060874`; tag `1934078`.
Source: clean `git archive` of `193407895e3381c6e56449d0dda977ae03ae7717`, frozen-lockfile dependencies in `/tmp/invoxim-mail-perf-clean`; overlaid the owner’s current Worker configuration. The configuration overlay retains `AI_TRACING_ENABLED=true`, `AI_TRACING_INCLUDE_CONTENT=true`, and `LANGSMITH_PROJECT=invoxim-ai`. The committed host is `https://eu.api.smith.langchain.com`. Unrelated unfinished source files were excluded and working changes preserved.

Command: `WRANGLER_LOG_PATH=/tmp/invoxim-release-deploy-wrangler.log pnpm --filter @invoxim/worker exec wrangler deploy --keep-vars --no-upload-source-maps --tag 1934078 --message "LangSmith EU host and bounded Gmail processing"`, executed from the clean release copy; exit 0. Upload 8408.35 KiB, gzip 1653.41 KiB. Scheduler, queue producer and consumer deployed. Existing secrets retained; the LangSmith credential name is present without accessing its value.

Before deployment, the same clean copy passed 44 focused tracing/LangChain/AI tests and root `pnpm build`, including the production test/debug publication guard. Last complete repository gate for the performance implementation passed 1532 native integration and 87 browser tests (see bounded-mail completion evidence); no full gate repeated for this deployment-only operation.

Post-deployment Wrangler `deployments list` confirms the version active at 100%. `versions view` confirms EU host, tracing enabled, selected project, LangSmith secret binding and global/tenant concurrency 2. Queue batch size remains 1 and consumer max concurrency 2.

Public HTTP smoke checks at `/api/health`, `/api/public-config`, `/api/me` and `/api/ai/settings` were blocked before reaching the app by Cloudflare 403/1010 browser-signature policy. No bypass or access-rule change attempted. Consequently this release record does not prove live login, authenticated imports or LangSmith trace delivery. No model requests, credential probes, new imports or queue resets were initiated by deployment verification.

No D1 schema/data write or Pages frontend deployment performed. Remote migration listing reports `0007_archive_document_order.sql` pending; it is an archive-backfill migration, unrelated to this release, and Drive remains disabled. It was left pending deliberately. Existing AI limits and mandatory Clef stay unchanged; private imports remain metadata-only despite the content flag (synthetic probes alone may include content).

Previous production version for rollback reference: `87c03a8c-f89c-4cbf-a5ce-4445b0462194`. Connected resource data is not reverted by a Worker rollback. Local command captures: `/tmp/invoxim-release-{deploy,tests,build,active}.log`; version metadata in `/tmp/invoxim-release-{before,after}.json`. Repository evidence records operational summaries only, with no raw provider responses or credentials.

## Authorized migration follow-up

The owner subsequently explicitly requested applying the migration. `pnpm --filter @invoxim/worker exec vitest run test/archive-backfill-migration.test.ts test/drive-backfill.test.ts` passed 32 tests across two files, exit 0. Preflight confirmed only `0007_archive_document_order.sql` pending and 24 document metadata rows to backfill.

`WRANGLER_LOG_PATH=/tmp/invoxim-0007-apply-wrangler.log pnpm --filter @invoxim/worker exec wrangler d1 migrations apply invoxim-db --remote` exited 0, applying nine commands in 10.22 ms. Subsequent `migrations list invoxim-db --remote` reports no migrations to apply. Aggregate integrity checks confirm no missing document-order entries, no foreign-key violations, and all three archive-backfill columns present. No original content was read, exported or persisted by verification; no imports started and no queues cleared. Command evidence: `/tmp/invoxim-0007-{tests,apply}.log` and `/tmp/invoxim-0007-integrity.json`.
