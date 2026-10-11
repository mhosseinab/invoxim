# Market findings, feature priorities, and validation

Version 1.1. Prepared October 11, 2026. This is a product experiment plan, not evidence of product-market fit. Vendor pages were checked; competitor products were not personally tested or audited. Do not use their published claims as measured extraction accuracy or retention evidence.

## Verified findings that changed this revision

| Vendor-published fact | Product implication, which is our inference |
|---|---|
| Clint offers a free allowance with Gmail and Drive sync, and a USD 5/month individual plan. [S41] | Low price plus receipt extraction is not an empty category. Do not lead with “the only free option.” |
| SparkReceipt offers one/multiple connected inboxes depending on plan and historical import. [S42] | Multi-inbox scanning and history are baseline capabilities to execute well, not claims of uniqueness. |
| Gennai offers a free plan with two inboxes and automatic invoice capture at limited volume. [S43] | Free multi-inbox intake exists. Compare practical task completion, not a superficial feature checklist. |
| Gmail read-only access is broad/restricted, and Drive supports per-file/app-created-file access. [S01, S04] | Explain mailbox permissions honestly and request separate optional storage authorization. |
| Google requires clear use explanations and in-context authorization; Workspace data rules prohibit advertising uses/sales covered by that policy. [S44, S45] | Clear controls are better than unsupported accusations against competitors. Policy is not proof that a specific vendor complies. |

Do not embed competitor prices or named-vendor comparison claims in public onboarding. Keep dated research here and recheck before using it externally. This revision adds no competitive scraping job, paid acquisition, pricing tier, or billing implementation.

## Initial customer hypothesis

Digitally active individuals and solo freelancers with more than one inbox, repeated online purchases, and software/service receipts. They want to find evidence and understand documented payments without doing bookkeeping. Treat this as a recruitment hypothesis, not a mandatory profession selector or a restriction on signup.

Useful jobs to test:
- Find the receipt for a specific purchase.
- Understand what was paid/refunded for one order despite several emails.
- Compare two equivalent recurring charges and see the source evidence.
- Export a bounded set of personal/work purchase records.

Not a fit promise: full financial coverage, bank reconciliation, tax advice, employer reimbursement workflows, or “no server sees your email.”

## Feature decisions

| Priority | Decision | Scope |
|---|---|---|
| P0 | Purchase/evidence-first message and Home; charts remain available but secondary | M0 |
| P0 | Public read-only synthetic example before inbox authorization | M0 |
| P0 | Separate identity/mail authorization and explicit review/start; no content processing on callback | M0 |
| P0 | Recent 30-day priority within the unchanged default 12-month import | M0 |
| P0 | Paid/refunded/net presentation, evidence timeline, coverage and review distinctions | M0, using existing domain rules |
| P0 | Real processing destinations, visible allowance, no forced BYOK setup | M0 |
| P1 | Optional Drive offer after first value or on-demand before import | M1; no fake M0 archive promise |
| P1 | Evidence-based comparable recurring-charge changes | M1, already agreed; no “unused subscription” inference |
| P1 | Manual Personal / Work / Unassigned tag; list and export filter | M1; one simple nullable classification, no accounting |
| P1 | Opt-in, first-party, content-free pilot measurements and benchmark worksheet | M1 |
| Later test | Forwarding-only/dedicated mailbox intake if access refusal is a demonstrated blocker | Deferred; does not replace required OAuth automation |
| Later test | Digest if users repeatedly find meaningful changes | Deferred; no notification platform now |
| Do not add | Bank connections, AI chat, teams, auto-cancellation, tax filing, merchant-portal crawling, pricing experiment infrastructure | Outside MVP |

A hypothesized advantage is **accurate purchase histories, clear evidence, and less setup**. It is not yet a proven differentiator. A faster onboarding flow must never reduce consent or financial validation.

## Competitor benchmark

Before extending the feature set, compare Clint and SparkReceipt on an authorized synthetic mailbox dataset; optionally include Gennai for invoice capture. Owner approval is required before creating external accounts, accepting paid trials, or uploading any real data. Use the same fixture set, date interval, currency, and task wording where each product permits it; record unsupported input/import modes fairly.

Include: order + invoice + payment + shipping for one purchase; unpaid invoice; partial refund; refund before purchase; same merchant/amount/day but two purchases; English/German receipts; currency differences; unreadable PDFs; invoice behind a merchant-portal link; and two inboxes carrying the same document. Track mailbox candidate discovery separately from successful extraction. Directly uploading a fixture does not test email discovery.

Measure: time/steps to retrieve evidence; false charges; false merges; missed eligible documents; correction burden; ambiguous outcomes; duplicate-safe recovery; full path to export; permission clarity. Mark “not tested,” “not supported,” and “failed” distinctly. Do not award points for a claimed feature that was not exercised. Synthetic data tests mechanics, not real-world prevalence or market demand.

Use `test-design/market-benchmark-template.md`. Keep test results empty until executed. No screenshots of other users' data in the repo.

## Small pilot and proposed continuation gates

Recruit around 15 relevant people once appropriate private-test access and provider requirements are met. Ask them to complete an actual receipt-finding or recurring-cost task and describe their previous workaround. A compliment, login, or background sync is not product value.

The following are proposed internal goals, not industry benchmarks or release promises:

| Question | Initial target |
|---|---|
| Can suitable testers connect without assistance? | At least 10 of 15; record refusals, blocked identities, cancellations, and technical failures separately. |
| Is a useful result available quickly? | Aim for within five minutes on a predeclared small representative recent-scan workload; record workload/model/provider and all outcomes. |
| Can they use the result? | A real purchase record's evidence is opened intentionally. Merely inserting a row is not activation. |
| Do they return for another task? | At least 8 of 15 complete a meaningful task within 30 days. Automated sync and passive dashboard visits do not count. |
| Are core fields reliable? | At least 98% joint correctness for amount/currency/event status/date on auto-accepted labeled records; also report acceptance coverage, candidate recall where measurable, and review rate. |
| Do they prefer it for a reason? | Several independently choose it over a tested alternative for a concrete task, not only because it is free. |

These targets do not replace the stricter core safety fixtures or extraction evaluation gates. Do not make code completion depend on inventing pilot participants or meeting these numbers. T30 can complete with tested measurement controls and an empty honest worksheet. Actual pilot findings remain owner-run evidence.

## Measurement without reading users' financial behavior

Two distinct measures:

**Technical first result:** `import_runs.first_usable_record_at - started_at`, recorded from accepted processing state. It measures availability, not the user's reaction. No amount, merchant, subject, filename, or receipt text is sent to operational logs.

**User activation proxy:** opt-in first user-initiated request to open supporting evidence for a real purchase after import. This measures an intentional product action, not proof that an external provider page loaded or that a user read it. Opt-in usage evidence is stored first-party only, in a tightly bounded table. No cross-site identifier, fingerprint, session replay, analytics vendor, AI transcript, or Gmail account security-signal reuse. Absence of telemetry does not block any feature.

Allowed optional events: `mailbox_authorization_completed`, `import_started`, `purchase_evidence_open_requested`, `review_resolved`, `export_completed`, `recurring_change_opened`. Store only app-user FK, event name, timestamp, and a random per-action idempotency token. Do not store which purchase, search term, mailbox address, category, merchant, amount, model prompt, or document was involved. Activation events require server-validated real resource access; client “demo=false” is not evidence. Generate dedupe keys from server action context without retaining financial identifiers in the event row.

Default operator flag is off. When enabled for the pilot, the user's measurement choice remains off until explicitly accepted after initial value; it is not bundled with Start import. Retain optional events at most 30 days, purge on opt-out or account deletion, and avoid extracting a permanent per-user activity profile. Absence of measurement means “not observed,” not “inactive.” Manual pilot records use pseudonymous participant labels and explicit permission, with no private receipt content in repository artifacts.

Report medians/percentiles only with sample counts and exclusions. A cohort of 15 is exploratory. Suppress identifying small-slice reports; access to measurement data is operator-restricted, never a public analytics endpoint. No new reporting dashboard is required: an owner-run bounded report or worksheet is enough.

## Decision rules

Continue improving the beta when people complete a useful task, come back, and prefer its execution. If broad email access is the blocker, investigate a lower-access intake route. If the job is annual cleanup, evaluate occasional use rather than forcing subscription engagement. If recurring-charge changes drive repeat use, prioritize those displays. If an existing tool does the job better at an acceptable cost, avoid adding features merely to justify sunk effort.

No automatic collection of fees, pricing commitment, public launch, open-source license, or competitor comparison claim is authorized by these findings.
