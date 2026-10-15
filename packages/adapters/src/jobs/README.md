# Durable jobs (T07)

`createJobStore(db, { policy, processingReview, clock?, id?, classification? })` provides the D1 job port. Construct a **fresh store per Worker invocation**: its private execution counter covers every actual `first`, `all`, `run`, `raw`, and batch statement in this module. The store rejects a `queryLimit` above 40. The Worker's `JOBS_QUERY_LIMIT` must equal its `QUERY_LIMIT` of 40, and the Worker lowers the store's limit to the invocation database's remaining statements, leaving headroom below D1's documented 50-query Free invocation limit. This is a query bound, not evidence of CPU, cost, or deployed-plan viability.

## processingReview (PIPE-2, P7)

`processingReview` is required, so every composition states its digest mode. It is either a resolver `(metadata) => Promise<string | null>` or `null`.

- With a resolver, `checkpoint` reads the job's processing selection and continues only while the resolver returns exactly the consent's accepted digest; invalid metadata, a `null` result or a resolver failure stops provider work. Recovery projects the onboarding recovery rows (`onboarding-recovery.ts`) and reviews them through the same resolver.
- `null` is only for stores that never lease digest-gated work: the manual-sync route, and the Worker when extraction is not configured. The Worker passes `createProcessingReviewResolver(ai)` when `EXTRACTION_ENABLED=true` with a valid AI configuration, otherwise `null`.

## Statement stages

The budget is divided into recovery, hourly scheduling, dispatch reservations and candidate selection. At 40 without a resolver the ceilings are 8/8/10/14; with a resolver recovery gets 10 and reservations 8. At 24 they are 8/8/4/4, or 10/8/2/4 with a resolver. Smaller synthetic budgets exercise fail-closed exhaustion. Budget exhaustion executes no further statement, exposes only `JOB_QUERY_BUDGET`, and causes transport retries or defers the outbox to a later sweep.

Recovery first fetches one expired lease through the global lease index, then conditionally retries, cancels, or terminates it with a fence check. It then inspects at most two identifiers in one tenant's persisted recovery cursor and cancels invalid pending work. The tenant cursor advances only after processing, with its write reserved in the stage ceiling. An empty page resets the cursor for the next invocation.

## Scheduling and manual sync

Hourly scheduling considers one tenant and one eligible due connection per sweep. A pending incremental job excludes that connection from periodic selection. A conditional D1 batch rechecks active profile, connection generation, exact live consent, the manual cooldown and absence of another pending incremental job before inserting the live sync state/job and updating scheduling metadata. `awaiting_import` never creates content work.

Manual sync ownership and eligibility are one fail-closed statement, `classifyManualSync` (W14), which `store.manualSync` runs through its budgeted `prepare`. The single-row result is `not-found` (the tenant does not own the mailbox), `review-required` (owned but not live/consented) or `eligible` with the newest live consent; an absent row is a storage anomaly and also reads as `not-found`. Manual sync coalesces an existing pending ID and enforces a five-minute cooldown. The route calls `classifyManualSync` directly only when jobs are not configured, so a missing mailbox still maps to 404 and a non-live one to 409 before 503.

## Dispatch, claim and finish

Candidate selection visits at most five tenants and interleaves their candidates by rank. Per tenant, each of three indexed priority branches reads at most `min(dispatchLimit, reservation ceiling)` identifiers before authorization checks. Actual work can be smaller than the configured dispatch maximum.

Dispatch reserves a candidate with its original fence and dispatch timestamps **before** sending the opaque `{ schemaVersion: 1, jobId }` envelope; `{ schemaVersion: 1, dispatch: true }` asks a consumer to dispatch ready work. A failed/lost send becomes eligible after the redelivery deadline. Claims acquire a lease and increment its fence/attempt atomically while enforcing tenant and global active-lease quotas. Checkpoint and completion require current generation/consent/profile and an unexpired matching lease. Retries have bounded backoff/attempts; terminal status plus a bounded outcome code is the durable diagnostic.

The core engine recognizes already-completed financial commits before ACK, including retries after a crash following the atomic source commit. Missing handlers pause with `handler-unavailable`; a lost pause fence retries instead of ACK. Handler/admission operations are bounded by the lease deadline and receive an abort signal/checkpoint. The Worker queue consumer is configured with batch size 1 and concurrency 2; it processes one message per invocation and retries any extra messages in a legacy batch with no delay.

This module does not implement ingestion, provider calls, inference budgets, settings revision policy, reconnect APIs, a scheduler UI, deployments, or resources. Admission and handlers are configured application ports; no handler means no fabricated processing result. Index and concurrency tests use only synthetic local D1 data.
