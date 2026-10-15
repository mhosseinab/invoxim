# Architecture and deployment contract

## Stack and package boundaries

Frontend: React + Vite, TypeScript, semantic HTML, a small router and query library only if justified. API: Hono and Better Auth in a Worker. Persistence retains D1 through the established native query adapters and Better Auth's Drizzle adapter, with explicit parameterized SQL for constrained/atomic operations. The owner's latest 2026-10-13 decision reverts the Prisma experiment while retaining one consolidated initial SQL baseline. Native D1.batch preserves atomic financial/consent/fencing operations; the shared invocation wrapper accounts for auth and repository statements. The baseline preserves schema constraints, indexes and required scheduler seeds; it initializes only empty databases and must not be replayed against existing data. Restored-native local verification and independent review passed; the final evidence record is `native-d1-restoration-final-certificate.md` (kept outside git; the historical copy is in the commit history before fe99887). Live migration and deployment remain separate operator gates.

Use pnpm workspaces and Turborepo for task ordering/caching. Runtime imports:

```text
web -> contracts, narrowly selected pure core formatters
worker -> core, adapters, contracts
adapters -> core ports, contracts
core -> contracts (types or pure validation only)
contracts -> no app or infrastructure modules
testkit -> contracts/core; production cannot import testkit
```

No cycles. Enforce boundaries in CI. Keep type-only and runtime imports explicit. Do not export an unrestricted database client to HTTP handlers.

Core use cases: connect/disconnect source, schedule sync, discover message page, process source document, reconcile observation, edit purchase, resolve duplicate, archive source, report spending, suggest recurrence, export data, and delete account. An explicit function is preferable to a class hierarchy unless state/lifecycle justifies a class.

External ports: `MailboxConnector`, `ArchiveStore`, `DocumentTextExtractor`, `InvoiceExtractor`, `FxProvider`, focused persistence operations, injected clock, and ID generation. Model/provider-specific SDK types must not cross those ports. Do not introduce a DI container.

## Cloudflare layout

- `apps/web`: static Pages output plus `functions/api/[[path]].ts`.
- Pages Function forwards the original request through an `API` service binding. It contains no domain/auth/database logic.
- `apps/worker`: one module exporting `fetch`, `scheduled`, and `queue`.
- Bindings: `DB`, `JOBS`, dead-letter queue, optional document-conversion `AI` binding.
- Secrets: auth secret, OAuth client secrets, credential-encryption keyring, optional hosted inference key. No secret in Vite public variables.

Use the same browser origin for pages and `/api/*`; set an explicit trusted base URL for callbacks. Do not depend on permissive cross-site cookies or wildcard CORS. Pages service binding behavior is documented. [S03]

Disable direct public Worker exposure where practical and authenticate every application route regardless. Forward only expected request semantics; strip any client-supplied internal identity headers. No trust in `X-User-Id`, forwarded host, or a queue payload alone. Protect callback URLs with fixed origin/path registration. Preview environments must never reuse production database bindings, tokens, sessions, or mailboxes.

Auth routes and financial APIs use `Cache-Control: no-store`. Static build assets can be cached. The service-binding proxy must preserve multiple Set-Cookie headers, request bodies, redirects, and error status. Test these behaviors in workerd and deployed staging.

## Scheduler

Use one Cron Trigger every five minutes as a lightweight dispatcher. Each active mailbox gets its own `next_sync_at` approximately 60 minutes after a completed scheduling cycle, with deterministic jitter. The five-minute dispatch cadence is an internal default; it does not change the agreed hourly mailbox behavior.

The dispatcher scans an indexed set of due connections/jobs in bounded pages. It creates durable jobs, emits IDs to the queue, retries unsent/outstanding jobs, and sweeps expired leases. It never scans all mailbox content itself and never waits for a full import.

`Sync Now` creates/coalesces a job, returns 202, and has a per-mailbox cooldown. Historical backfill and incremental sync use independent cursors; backfill cannot starve new receipts. Per-tenant fairness and global budgets prevent one enormous mailbox consuming the allowance.

No polling process depends on the user keeping a dashboard tab open. Browser status polling is for visibility only.

## Durable job protocol

The `jobs` table is both job state and dispatch outbox, avoiding a second generic workflow engine. Queue body: `{schemaVersion, jobId}`. Job row owns tenant/source/generation, cursor reference, deduplication key, retry count, next dispatch, lease ID/expiry, and outcome code. Do not place bodies, tokens, endpoint URLs, or plaintext addresses in queue payloads.

1. Persist a unique ready job and related cursor/metadata changes together.
2. Dispatcher sends its ID. A crash before marking dispatch success may resend it; that is expected.
3. Consumer loads the row and claims it with a conditional update. Completed, stale, missing, deleted, or wrong-generation jobs are no-ops.
4. Perform bounded external work with AbortSignal/timeouts. Persist only allowed structured output.
5. Write the result and mark completion with a lease/generation fence. Each modifying statement must be conditional on the valid lease/owner, not just the first statement in a batch.
6. Acknowledge after completion or a durably recorded terminal outcome. Otherwise retry/back off.

A lease has a proposed five-minute duration; one job’s intended work is shorter. Do not assume a lease alone prevents stale workers committing. Tests must expire/reassign a lease while the old worker returns. Use a monotonic fencing token/generation and optimistic record versions.

Use D1’s supported batched/conditional SQL interface and prove rollback/atomicity on the pinned runtime. Do not assume an interactive PostgreSQL transaction API works on D1. [S11] If a batch’s semantics are insufficient for an operation, use a commit-marker design that prevents partially staged records from becoming visible, and document the decision before merging.

Atomicity boundaries never include AI or Drive requests. Stable request IDs make retries safe where a provider supports them; ambiguous model timeouts remain bounded, potentially billed attempts. If a failure could have produced an external result, record it accurately instead of relabeling it “not sent.”

Queue at-least-once semantics and finite retention require idempotent consumers and periodic recovery from durable job rows. [S05, S06] Terminal poison jobs create one review/operational issue and do not loop indefinitely.

## Resource limits

Proposed initial app limits, configurable and tested:

| Setting | Initial value |
|---|---:|
| Mailboxes per user | 3 |
| History default | 12 calendar months |
| Discovery page | 50 references |
| Document bytes | 4 MiB per supported attachment |
| Candidate text sent to AI | 24,000 characters; no silent truncation of totals |
| JSON response body | 128 KiB maximum |
| AI attempts per extraction | 2 total, including repair/retry |
| Concurrent jobs per tenant | 2 |
| Consumer concurrency | 2 initially |
| Queue message size | Below 2 KiB |
| List page | 50, maximum 100 |
| Sync Now cooldown | 5 minutes |

Limits are application defaults, not claims about provider maxima. Process oversized/truncated/password-protected input as a visible unsupported/review case. Do not buffer a whole mailbox or multiple large documents together. Native-PDF adapter limits can be lower.

Workers have CPU, memory, subrequest, and invocation limits; measure real cryptography, HTML parsing, auth, and JSON workloads before choosing the Free plan. [S08] Do not run Chromium, a Python OCR stack, native SQLite libraries, or a Node server daemon in a Worker. Document conversion belongs behind an external/Cloudflare service adapter.

## Deployment and scaling

Use checked-in Wrangler configuration, generated binding types, ordered migrations, separate local/staging/production resources, a pinned compatibility date, and explicit compatibility flags only where required. No Terraform is required for a weekend project; add it only if Wrangler cannot adequately reproduce a needed resource.

Deploy and verify the Worker before the Pages proxy binds to it. Keep old/new versions schema-compatible through expand/contract migrations. Never apply destructive production migrations during an agent run without approval.

Initially one shared D1 database with tenant-scoped indexes. It is not a database per user and does not claim built-in row-level security. Monitor database size, query latency, scan counts, write saturation, and job lag. At approximately 70% of a relevant storage/quota limit, open a capacity task rather than waiting for writes to fail. Current per-database limits differ between Free and Paid. [S07]

If actual use outgrows one database, first optimize indexes/queries and processing fairness. Then evaluate tenant sharding or another persistence adapter with evidence. Do not implement routing/sharding infrastructure in the MVP merely because it may someday be useful.

## First-use presentation and activation path (v1.1)

Reuse the existing web/API/job architecture. Add static landing and `/demo`, a minimal allowlisted `/api/public-config`, and authenticated onboarding/disclosure projections. Do not expose the full operator configuration. Public static assets may be cached; personalized onboarding, allowance, and disclosure selections use `no-store`.

A callback only connects the mailbox. Explicit review/start creates one consent-bound parent import and recent/older slices through the existing durable job engine. Prioritize recent work, then older history, while retaining fair scheduling and independent hourly synchronization. Durable status polling never drives the import itself. The Home experience opens ready records without waiting for all history.

A static demo adapter supplies reviewed synthetic values to presentational components. It cannot import credential/integration code, read a real tenant cache, or invoke authenticated data loaders. Do not introduce a demo tenant in D1, a second application, or a production dependency on `packages/testkit`.

Use one typed server-state projection for onboarding readiness and a small web controller for temporary form/UI state. No onboarding framework, analytics SDK, external feature-flag service, or new microservice. Implementation details and tests are in `docs/13-presentation-and-onboarding.md`.

## Environment-configured service seams (owner clarification, October 12, 2026)

Keep external services behind provider-neutral application ports, especially inference and document extraction. The Worker composition root selects concrete adapters from validated configuration. AI defaults are read directly from versioned files in `config/`; environment bindings and Wrangler variables control runtime services and overrides. Secret values and encryption keyrings come from Wrangler/platform secrets. Domain rules must not import vendor SDKs, read environment variables, or hard-code a chosen AI provider/model. Existing mandatory MVP provider choices remain supported adapters, not a reason to add a generic plugin framework.

Non-secret configuration includes approved provider IDs, models, capability limits and fixed reviewed endpoint registries. Credentials are server-only; Vite variables/public-config never expose keys or private configuration. Hosted processing and BYOK use the same application interfaces. Respect explicit user destination selection within the operator-approved registry; missing capability/configuration pauses work rather than silently switching providers. A configuration seam does not permit arbitrary user-supplied endpoints, broaden consent, or bypass provider-specific capability tests.
