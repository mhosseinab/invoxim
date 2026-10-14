# Authorized fresh-import reset — 14 October 2026

Owner requested clearing queues/messages, explicitly approved removing the extracted purchase, then explicitly requested resetting spending counters too. Scope was the existing mailbox workspace, identified through its known connection. Preflight confirmed one workspace, one target connection and no other-workspace jobs. No provider original messages were deleted.

Before: 50 source messages, 24 documents, one source-derived purchase with one evidence link, zero manual purchase evidence/payment entries, and 117 durable jobs (none leased). No archive objects, recurring series or correction commands existed.

Operations, all exit 0:

1. Paused `invoxim-jobs` delivery. Set the workspace mailbox schedule to `awaiting_import`, cleared next-sync, revoked old processing approvals and canceled/fenced outstanding durable work. Verified no active durable jobs before erasure.
2. Deleted the explicitly approved source-derived purchase only when linked to the target workspace source, without payment/manual evidence. Deleted scoped sources and cascaded document/extraction/review data, then removed scoped durable jobs, sync cursors, idempotency/start commands, import runs and revoked approvals. No account, login/session, mailbox credentials, AI settings or external originals were erased.
3. Explicit owner spending-reset extension: zeroed documents, reserved/spent processing units, reserved/spent USD micros and blocked flags for the workspace tenant and operator usage buckets (four existing daily/monthly rows). The final update used the actual bucket scopes and all recorded periods; the initial current-period filter did not match the stored month key and was corrected before verification. This resets application counters only, does not reverse provider billing, and does not raise configured $1/day or $10/month caps.
4. Purged `invoxim-jobs` and `invoxim-jobs-dlq` through Wrangler with explicit force confirmation, then resumed processing-queue delivery. No import was started.

Verified after reset: zero sources, documents, observations, purchases, ledger entries, reviews, jobs, import runs, sync states, processing approvals, discovery-seen references and archive ordering entries. Zero nonzero usage buckets and foreign-key violations. One profile, connected mailbox credential and login session retained. Scheduling remains `awaiting_import`. A second check after resuming delivery confirms zero durable jobs and no active hosted-provider cooldowns. Fresh Review/Start remains the owner’s next action.

Wrangler 4.149.0, production `invoxim-db`; CLI help verified pause/purge/resume behavior. Context7/online purge documentation unavailable; installed Wrangler command help was the fallback. No implementation code or migrations changed, so no new unit/build gate was required. Operations used the existing tenant-scoped reset pattern and post-state assertions rather than fabricated behavioral tests. Independent review was not requested for this coupled operational task.

Local evidence (not committed because it includes internal identifiers): `/tmp/invoxim-fresh-{before,links,stop,reset-result,spending-result,after,final}.json` and `/tmp/invoxim-fresh-{stop,reset-scoped}.sql`. Only operational summaries are recorded here; no message content, extraction fields, credentials or usage-event bodies were read into repository artifacts.
