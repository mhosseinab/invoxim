# T18 bounded archive queue processor

Status: native three-case GREEN observed for this bounded composition; source frozen for independent review. Full T18 is not complete.

Ownership: new `packages/adapters/src/drive/archive-job.ts`, `apps/worker/test/drive-archive-job.test.ts`, and this report. Shared Worker entry points, contracts, indexes, schema and configuration remain with the orchestrator.

The approved implementation composes the existing archive dispatch store, queue engine and exact-original Drive workflow on one invocation database handle. The strict schema-version-2 envelope carries only the opaque archive ID; the dispatch store derives the trusted workspace and object from its authoritative native row. The queue captures the actual object lease via the workflow's synchronous claim observer and settles only that object/dispatch fence. Every source/Drive HTTP boundary retains the existing current-consent, profile, source-generation and credential fences. Original bytes stay transient; durable plans preserve preallocated IDs.

No new core port, infrastructure, permission, configuration, storage destination or processing-consent requirement is introduced. A fresh invocation meter must be supplied by the actual Worker composition; it must not be reset between authorization, dispatch lookup, workflow and settlement.

The native fixture reuses the existing owner/baseline helper and real archive stores. Its controlled provider requests target fixed Gmail/Drive endpoints only. Three passing native cases cover exact binary multipart completion, ambiguous successful-upload response reconciliation, and disabled archive consent before execution. Required oracles include a shared 40-statement cap, durable IDs before remote creation, completed dispatch projection, replay without another upload, unchanged financial snapshots, and zero AI-processing consent.

Broker command: `pnpm --filter @invoxim/worker exec vitest run test/drive-archive-job.test.ts`.

Root broker RED: `/tmp/invoxim-drive-archive-job-red.txt`, exit 1, three intended `UNAVAILABLE` stub failures, 3.68 seconds, no fixture/setup fault. Scoped Prettier, Biome and ESLint passed before RED and after implementation. Root broker GREEN evidence: `/tmp/invoxim-drive-readiness-green.txt` records all three Drive archive-job cases passing. The combined command exited 1 because a separate readiness fixture used the wrong DTO assertion; this report does not label that combined run GREEN. Independent review and full integration remain pending. No real OAuth credentials, provider calls, uploads, costs or deployments were used. Remaining integration includes root-owned shared Queue routing and admission/backfill/runtime/UI/lifecycle release evidence.
