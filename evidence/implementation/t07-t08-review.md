# Independent T07/T08 review

Decision: approve the bounded local increment; no unresolved findings in the reviewed frozen source. Reviewer /root/discovery_review is independent of implementers and QA. Root transcribed this report from the reviewer's final response. Frozen identity: 94ef32013db72cb5321a2ac1bc9f6d4253eaa5d7e04d32cd7c0f888c9539af00 (130 files); QA source comparison found zero differences.

Reviewed core jobs/mailbox contracts, job engine, D1 job and mailbox adapters, migrations 0006/0007, Worker configuration/event entries/routes, shared DTO seams and independent QA evidence. Reviewer changed no files and executed no tests, migrations, provider calls or deployments. Read-only inspection commands passed; one unsupported tail -25 invocation failed and was corrected to tail -n 25.

Resolved findings: dispatch reservation before queue send; durable pause persistence before ACK; actionable expired-lease recovery behind valid backlog; atomic prevention of competing pending sync runs; processed-tenant cursor progress under query exhaustion including existing pending sync; mailbox cap during reconnect; immediate refresh connection/profile/lease validation; safe service errors; explicit SQL NULL-pair constraints; fixed review redirect.

Observed independent commands: frozen install, pnpm verify and pnpm db:check all exit 0. Fresh 218 tests including 126 workerd; 1,500 generated property cases inside core tests; separate 20 D1 rerun. Five package typechecks and boundaries/lint/format/build passed. Evidence: t07-t08-qa.md, t07-t08-qa-source-match.txt, t07-t08-qa-final-{install,verify,db-check}.txt, t07-qa.md and t08-qa.md.

Approval covers JOBS-01 through07 implemented durability, fencing, cancellation, concurrency, fairness, retry and financial-replay paths; ONBOARD-13 Start gate; local AUTH-02, GMAIL-04, SECRETS-04 and ONBOARD-02/15 mailbox authorization/lifecycle boundaries. Archive replay is outside implemented processing.

Live Google authorization, deployed queues, provider approval, Free-plan CPU viability, scanning/dedupe, Outlook, inference accounting and T29 review/Start UI remain unverified/deferred. /onboarding/review is an explicit UI seam. Disabled ACK preserves durable D1 work; cancellation cannot retract submitted requests. Public capabilities remain disabled and full M0 is incomplete.
