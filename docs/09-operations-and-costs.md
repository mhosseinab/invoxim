# Operations, deployment, and cost controls

## Operating target

Start with a small private test cohort. "Free for users during testing" is an allowance funded by the operator, not a promise that infrastructure, inference, or verification costs nothing. Do not add a paid connector or upgrade a Cloudflare plan without owner approval. Do not launch an unlimited anonymous extraction endpoint.

## Dated platform facts versus design budgets

The following facts were checked against primary documentation on October 11, 2026. Recheck them at deployment. They are not benchmark results for this application.

| Component | Published allowance/constraint relevant to this design | Operational consequence |
|---|---|---|
| Workers | Free has 100,000 requests/day and a 10 ms CPU limit; Paid has a $5/month subscription minimum. [S08, S09] | Benchmark auth/crypto and PDF handling in the actual runtime. Free-plan viability is unproven. Network wait is not equivalent to CPU time. |
| Queues | Free includes 10,000 operations/day and 24-hour retention. A normal small message commonly incurs write/read/delete operations; retries add operations. [S06] | Persist jobs in D1, keep queue messages small, bound imports, and use a repair dispatcher. Do not assume 10,000 completed documents/day. |
| D1 | Free includes 5 million rows read/day and 100,000 rows written/day; size is limited to 500 MB per database on Free and 10 GB per database on Paid. [S07, S10] | Index tenant/date/status queries, monitor scanned rows and database size, and avoid full-table job scans. |
| Workers AI | A shared daily free neuron allowance exists; model prices and eligibility differ. [S27] | Neurons are not receipts. Measure the selected parser/model and account-wide usage before setting a public allowance. |
| PDF conversion | Workers AI toMarkdown supports document conversion; image handling can involve model inference. [S24, S25] | A supported extension does not prove accurate receipt OCR. Test numeric fidelity and privacy before enabling it. |

These published quotas may change or vary with account configuration. No spreadsheet of imagined users is evidence that this service will remain free.

## Initial application budgets

`config/app.example.json` supplies conservative, changeable design defaults: three mailboxes/user; hourly polling; two tenant jobs at once; 50 AI documents/day and 500/month per user; initial operator inference caps of USD 1/day and USD 10/month. Counts include historical imports. These are product controls, not provider prices. A document with a repair request can incur two inference calls, both metered.

Maintain atomic reservations before calls. The operator cap covers hosted inference, parsing, and image/OCR services the operator pays for. BYOK inference has separate usage accounting and user limits; operator-funded parsing and infrastructure still consume operator budgets. Unknown model pricing or missing safe upper-bound cost means hosted inference stays disabled. Pause with a visible reason before exceeding a budget; do not silently switch providers, discard backlog, or use a user’s key for other users.

Reconcile observed provider usage against reservations. A request timeout is not proof that the provider did not charge. Reserve conservatively, record unknown outcomes, and reconcile rather than immediately refunding the allowance and retrying indefinitely. Per-model price tables need a source, checked date, currency, input/output/cache unit definitions, and version. Cached-token discounts are not assumed.

Monthly cost model:

```text
infrastructure subscription + metered overages
+ sum(document parsing / image processing charges)
+ sum(input tokens * input price + output tokens * output price)
+ verification/security-assessment expenditure, if applicable
+ domain and optional operational services
```

Use measured distributions: candidate messages/mailbox/month, accepted documents/message, average text size, inference/repair frequency, job operations/document, D1 rows scanned, and retained metadata size. Backfills are bursts, not average monthly traffic. A 12-month import for many users can exhaust an allowance before anyone opens a chart.

## Environments and secrets

Use independent local, staging, and production D1/Queues/Workers resources. Staging uses synthetic data and explicit test accounts. Never point preview builds at production bindings. Restrict preview access, and do not register uncontrolled preview origins as production OAuth callbacks.

The configuration schema contains only nonsecret settings. Put OAuth client secrets, credential-encryption keys, and operator model keys in platform secret storage; use ignored local development secret files. Do not commit them to TOML, JSON, artifacts, test recordings, or agent prompts. Use narrowly scoped deployment credentials. Access to the Cloudflare dashboard/database is privileged access to user data, not harmless frontend administration.

Pin the tested compatibility date, stable dependency versions, and deployment tooling. Verify Pages service binding names, the original origin passed to auth, cookie behavior through the proxy, and Worker entry points in a staging smoke test. Direct Worker routes must not accidentally create an unprotected alternate API surface.

## Deployment sequence

1. Finish T00/T01 runtime and permission checks. Record approved resources and remaining blockers.
2. Provision isolated resources and least-privilege OAuth clients with exact callbacks. Keep public signup disabled. Define the approved AI destinations and disclosure text.
3. Apply additive/backward-compatible migrations in staging; test clean installation, upgrade, foreign keys, job leases, and indexes. Configure secrets out of band.
4. Deploy Worker, bind the Pages API proxy, deploy frontend, and test login A / mailbox B / optional Drive C. Confirm cookies, CSRF, sync, synthetic PDF handling, and privacy logs.
5. Run the documented smoke checklist and relevant live tests with explicit consent. Confirm kill switches and quota exhaustion. Save redacted evidence, not real documents.
6. With owner approval, deploy the same reviewed build and migrations to production. Enable only the permitted cohort. Confirm first-run health and rollback conditions.

No automated deployment to production from an unreviewed agent branch. Do not auto-enable billing or alter provider consent scopes during deployment.

Deployment mechanics are automated in `.github/workflows/semantic-deploy.yml`; authority to deploy is not. A push to `main`, a `vX.Y.Z` tag, or a manual dispatch runs the foundation verification gate first, then waits for owner approval on the GitHub `production` environment before deploying the API Worker and the Pages frontend in that order. For pushes and tag deploys the workflow itself enforces that only commits reachable from `main` deploy. A strict `vX.Y.Z` tag records the deploy's semantic version; other commits deploy as `main-<short sha>`. The workflow reports pending D1 migrations read-only and never applies them, never changes secrets, and does not enable features or cohorts. Its prerequisites (the approval environment and narrowly scoped Cloudflare credentials) are owner inputs in `MANUAL_TASKS.md`; this checklist's gates still govern every production deployment.

Four limits of that automation are explicit. First, deploy targets and the deploy branch come from Actions variables (`WORKER_NAME`, `PAGES_PROJECT_NAME`, `PAGES_PRODUCTION_BRANCH`, `D1_DATABASE_NAME`, defaulting to the checked-in wrangler names), and the workflow refuses to deploy when the live `PAGES_PROJECT_NAME` project's production branch differs from `PAGES_PRODUCTION_BRANCH`; `wrangler pages deploy --branch` creates a production deployment only when the branch matches the project's production branch, so a mismatch would otherwise silently produce a preview while the run summary claims production. The approver still confirms the deployed production URL after every run. Second, for a manual dispatch GitHub executes the workflow file from the selected ref, so a tampered branch copy could weaken the main-ancestry check; the approval reviewer must confirm the run's source ref and commit before approving, and that review is the effective gate. Third, `wrangler pages deploy` re-bundles the guarded `dist/_worker.js` at upload, so the deployed bytes are the pinned Wrangler's bundle of the reviewed artifact rather than the artifact itself. Fourth, a push to `main` runs the full verification twice (once as the ordinary CI run, once inside the deploy run) because the deploy gate verifies exactly the artifacts it ships; that is accepted CI cost, not a correctness issue.

## Metrics and alerts

Collect aggregate counts and timings: queue age, ready/retry/dead jobs, lease recovery count, import progress, mailbox last success, provider 401/429/5xx rates, extraction outcomes, review reasons, budget reservations/actual usage, D1 size and scanned rows, and archive failures. Do not include receipt amounts, merchant names, filenames, message subjects, prompts, raw provider errors, or secrets in telemetry.

Suggested initial alerts: ready job age greater than two polling intervals; repeated auth failure after one controlled refresh; a user import stalled for an hour while runnable; operator budget reaching 80%; database size reaching 70% of the current plan limit; abnormal cross-tenant denial spikes. Thresholds are starting values to tune, not service-level promises. Distinguish a user-paused/quota-paused import from a broken worker.

## Failure and recovery runbook

| Incident | Immediate action | Recovery proof |
|---|---|---|
| Provider 429/outage | Respect Retry-After; pause/back off the affected provider without failing unrelated providers. | Resume from saved cursors; no duplicate ledger entries. |
| Lost/expired queue delivery | Scan an indexed, bounded set of runnable D1 jobs and re-enqueue opaque IDs. | Lease/fencing tests prevent concurrent duplicate commits. |
| Gmail history no longer valid | Mark coverage as catching up and run the bounded recovery scan. | No permanent loss caused by committing a newer cursor too soon. |
| OAuth revoked | Stop the mailbox, delete invalid credentials when appropriate, and request reconnect. | Reconnect to the verified same account; retain existing records unless explicitly deleted. |
| AI bill spike or injection incident | Disable hosted inference globally; preserve structured job references, not payloads. | Investigate aggregate diagnostics and synthetic reproduction before resuming. |
| Drive full or upload interrupted | Keep financial extraction independent; mark archive failed/pending. | Retry the same preallocated file ID rather than duplicating originals. |
| Suspected credential compromise | Pause affected integrations, rotate keys, revoke applicable tokens, and follow the incident decision process. | Verify old keys/tokens cannot be used and inspect access evidence without exposing content. |
| Bad release | Stop consumers if needed; roll back compatible code, not blindly destructive migrations. | Replay redacted synthetic checks; ensure jobs and cursors survive. |
| Database restore | Restore into a nonserving environment, then reapply deletion tombstones and reconcile jobs/credentials. | Deleted users stay deleted, revoked credentials stay invalid, and idempotent replay does not create new spending. |

D1’s documented Time Travel retention differs by plan: seven days on Free and 30 on Paid. [S07] Deleting active rows is not immediate physical removal from every backup. State the actual retention in user disclosures. Before enabling restore, establish an independently retained minimal deletion journal and a process to invalidate sessions/credentials restored from the past. Its secure location and retention require an operator decision. It contains pseudonymous deletion markers, not invoices. Without a tested suppression process, never restore a backup directly into a serving application.

## Scale only when measured

First fix indexes, bounded work, batching, duplicate AI calls, and excess metadata. At a documented capacity threshold, evaluate paid limits or tenant-based D1 partitioning behind the repository port. Partitioning is not an MVP implementation task. A Cloudflare deployment does not remove per-database size, concurrency, CPU, API quota, or inference-cost constraints.

## Beta presentation and first-use operations (v1.1)

The public capability response derives availability from implemented/reviewed features, operator flags, and provider/processor readiness. Do not expose an Outlook or Drive CTA solely because its name is in the eventual provider list. The v1.1 example config starts with Gmail enabled and M1 presentation features disabled; the complete MVP still requires them later.

Before inviting testers, verify a real hosted allowance is configured or clearly show unavailable processing. Read the actual remaining allowance in onboarding, and say that historical processing consumes it. Do not copy illustrative 50/day or 500/month defaults into unconditional marketing. If infrastructure/operator capacity pauses work despite personal allowance, give a safe service-capacity reason rather than blaming the user's key.

Operational first-result timing uses import-run timestamps and synthetic workload identifiers only. Product activation measurement is optional, first-party, content-free, and off by default. `docs/14-market-validation.md` defines the small pilot; no advertising analytics SDK or notification service is part of this revision. Keep optional events at most 30 days with volume caps, opt-out purge, and deletion coverage.

Static example mode remains usable without cloud credentials and when live processing is disabled. It must not generate model cost, private API reads, background queues, or false activation. This is a demonstration path, not a bypass for test-user or provider-release gates.
