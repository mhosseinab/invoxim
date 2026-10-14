# Bounded mail fetching and processing plan — 2026-10-14

Task: MAIL-PERF-01. Owner requested planning followed by implementation in a subagent, without overengineering. Implementation owner: `/root/bounded_batch_processing`. Independent read-only reviewer: `/root/langchain_review`. Parent owns integration, commits, backlog and final evidence.

## Frozen minimal scope

1. Bring the native attachment headroom regression into the ordinary main-branch test suite. Reproduce first; prove both ordinary and maximum supported attachment inputs can progress without exhausted retries or duplicate paid calls. Preserve the shared 40-statement invocation budget; do not lower the inference headroom guard, reset counters, weaken authorization or omit attachments.
2. Batch attachment GETs within one source email using Gmail's real multipart HTTP batching when at least two unique attachment IDs need fetching. Preserve the existing maximum eight attachments, four-MiB aggregate decoded content, MIME depth/part bounds and source hash semantics. Use one immediately-before-outer-request authorization checkpoint, then preserve response/atomic-write fences. Remove only demonstrated redundant pure-stage authorization reads.
3. Keep raw content transient in the source invocation. Batch requests use generated correlation IDs and fixed relative attachment GET paths under the approved Gmail API. Parse bounded multipart responses strictly; reject duplicate/missing/unknown IDs, malformed boundaries/status/JSON, unsupported encodings and oversized/truncated streams. Outer success does not imply inner success. On partial failure discard transient successes; retry/pause through existing bounded source recovery without staging incomplete evidence.
4. Process two independent emails concurrently using separate Worker invocations: queue batch size stays one, queue maximum concurrency becomes two, and job tenant/global limits become two. Each invocation retains its independent shared database meter. Do not run multiple complete sources under one reset/imaginary query budget. Legacy surplus queue deliveries may be re-delivered immediately; real provider failures retain bounded recovery.
5. Propagate provider cooldowns through the smallest existing job contract extension, optional `retryAfterMs`, only if needed by the multipart transport. Reuse existing AI policy: seconds/HTTP-date, conservative defaults, safe finite delay up to 24 hours, oversized delay sentinel pauses through existing handler-unavailable recovery. Persist `now + max(backoff, providerFloor)` with safe-integer validation, and clear dispatch/lease markers so duplicate queued messages cannot bypass the cooldown. No worker sleeps or new scheduler/state machine.
6. Verify targeted native tests, independent review and the full repository gate from a clean checkpoint. Document measured query/request counts and distinguish synthetic overlap evidence from live throughput.

## Deliberate exclusions

No cross-message body batch/cohort coordinator, new service binding/infrastructure, raw-body persistence, R2, dependencies, multi-email model prompts, LangGraph, provider/model change, quota increase, bypassed Clef classification or new email providers. Financial extraction remains one independently accounted request per qualifying email. The existing $1/day and $10/month caps remain.

The earlier suggestion to fetch five–ten complete emails together does not fit the current one-source durable stages and shared query cap without a larger orchestration change. The chosen implementation provides real within-email HTTP fetch batching plus cross-invocation message concurrency. It does not claim whole-email model batching.

## Acceptance cases

- PERF-01: native real engine, real metering/consent/credential path, zero/two/eight attachments; each stage including claim and settlement stays within 40 actual statements; one Clef call, one financial call and one ledger event for the paid fixture.
- PERF-02: bounded multipart attachment fetching, stable source identity, complete content, reordered success correlation; malformed/missing/duplicate/extra parts and aggregate/per-part limits fail safely.
- PERF-03: mixed success/401/403/429/5xx, strictest cooldown, cancellation/deadline, disconnect/revocation/expired lease; no partial stage or unchecked retry/fallback.
- PERF-04: two independent native invocations overlap and retain tenant/global admission limits; third claim remains blocked; duplicate delivery cannot duplicate financial writes or inference charge.
- PERF-05: provider cooldown cannot be shortened by base backoff, early redelivery, stale lease or dispatch marker; invalid/overflow hints pause safely, later dispatch resumes only after the floor.
- PERF-06: focused and full format/lint/type/unit/integration/build/browser/publication checks; independent review; scoped recoverable commits.

## Verified provider contract

Gmail supports multipart HTTP batching; up to 100 calls, recommended no more than 50, with ordinary per-item quota accounting and independent subresponse statuses. The actual bounded batch here is at most eight attachment reads. Official discovery read on 2026-10-14 returned revision `20261005`, `rootUrl=https://gmail.googleapis.com/`, `batchPath=batch`, so the fixed endpoint is `https://gmail.googleapis.com/batch`. Do not substitute a guessed batch path.

Sources: https://developers.google.com/workspace/gmail/api/guides/batch and https://gmail.googleapis.com/$discovery/rest?version=v1. Cloudflare consumer concurrency is per invocation, not permission to reset one invocation's D1 counter. Context7 is unavailable; official docs and installed SDK/runtime types are the fallback.

No deployment, production queue mutation, remote database write, real mailbox/model request or spending authorization is part of this implementation task. Live throughput requires a separately recorded rollout measurement.
