# Inbox Ledger: implementation blueprint

Version 1.1 • October 11, 2026 • Planning package, not implemented software

## 1. Product definition

A small web application for **purchase records across inboxes**: find receipts, understand documented payments and refunds, and keep recurring costs visible without bookkeeping. The initial audience hypothesis is digitally active individuals and solo freelancers with several inboxes. It still supports ordinary personal use; no business profile is required. Original documents may be archived in the user's own cloud storage. It is not a complete finance or accounting application.

The central promise is **less manual collection, traceable numbers, and limited data use**. It is not a promise to discover every expense, verify bank settlement, or hide server-side processing from the service operator.

Online and offline purchases are covered when a receipt reaches a supported inbox. Cash purchases without an emailed receipt are not visible in the MVP. Manual photo/file upload is a later feature, not a hidden requirement of the first release.

## 2. Decisions already agreed

| Area | Contract |
|---|---|
| Delivery | Hosted web service on Cloudflare; easy to deploy; modest hobby-project scope |
| Users | Signup/login, one private workspace per user, multiple mailboxes, no subaccounts |
| Authentication | Google sign-in in the MVP; Apple later |
| Mailbox connection | Provider authorization screens; no mailbox passwords or IMAP settings in the MVP |
| Providers | Gmail first, Outlook/Microsoft accounts for the full MVP; other providers later |
| Import | Last 12 calendar months by default; recent 30-day slice first, older history continues; explicit older start date supported |
| Presentation | Purchase/evidence-first Home, source-linked payment/refund timeline, honest coverage, charts secondary |
| First use | Read-only synthetic example; identity login; one mailbox; compact explicit review/start; no forced Drive/BYOK setup |
| Background sync | Hourly per active mailbox, independent of an open browser; Sync Now and status |
| Extraction | Merchant, amount, currency, dates, category, references, and payment/refund evidence |
| Corrections | Editable records, source/provenance visibility, Needs Review workflow |
| Dashboard | Search and useful purchase records first; recorded spending and monthly/category/merchant views retained |
| Optional classification | M1 manual Personal / Work / Unassigned tag with consistent filtering/export; not tax accounting |
| Recurrence | Subscription/recurring-payment suggestions, monthly/yearly estimates, price-change flags |
| Currency | Preserve original amounts; default reporting currency EUR; dated FX conversion |
| Originals | Optional user-owned Google Drive archiving; no app-owned R2 archive |
| AI | Operator-funded free allowance and user-provided keys; provider-agnostic interfaces |
| Future charges | Measure usage now; no checkout, subscriptions, or payments integration now |
| Engineering | Monorepo, strict TypeScript, TDD, SOLID, DRY, KISS, YAGNI, independent review |
| Agent handoff | Concrete rules, skills, roles, test cases, and dependency-ordered tasks |

### Defaults adopted by this blueprint, not extra user promises

Use React/Vite, Hono, Drizzle with D1, and Better Auth after a runtime compatibility spike. Begin with an invite/test-user allowlist until public-release prerequisites are cleared. Start with three connected mailboxes per user as an operator-configurable abuse/cost limit, not a permanent product restriction. The parser and hosted AI model are configurable; enable them only after a synthetic compatibility and privacy check.

The repository name is a placeholder. Publishing an open-source license is the owner’s decision. Do not create commercial branding, a company, a pricing strategy, or a licensing commitment on their behalf.

## 3. Milestones and honest completion labels

### M0: weekend vertical slice

A real multi-tenant foundation with Google login, two isolated synthetic users in tests, multiple Gmail connections, resumable receipt-focused import, hourly processing, email-body and text-PDF extraction, categorization, corrections, and a simple purchase list/dashboard. Include operator AI and BYOK selection with safe configuration, plus deletion/export basics and the core security gates. Add the truthful landing/read-only example, non-scanning OAuth callback, explicit processing review/start, recent-first progress, purchase timeline, and first useful-record path. Detailed UX: `docs/13-presentation-and-onboarding.md`.

Use a small synthetic/local dataset first. Live Gmail testing needs the owner’s credentials and authorized test accounts. Optional Drive, Outlook, recurrence polish, and the complete historical FX experience are subsequent tasks. M0 is **not** the full agreed MVP. A weekend is a scope target, not a delivery guarantee.

### M1: full MVP

Add Outlook, optional Google Drive originals, complete currency reporting, recurring-payment suggestions/price-change flags, complete exports/deletion UX, and all required acceptance tests. Complete the release runbook and production-like smoke checks. Move optional Drive setup after first value, make comparable recurring changes evidence-linked, add simple manual use tags, and implement only opt-in content-free pilot measurement. Market hypotheses are not release certifications.

### M2: public availability

Enable general signup only after OAuth/provider requirements, privacy disclosures, processor terms, cost controls, and the security/recovery gates are resolved. Approval is an external dependency; code generation cannot substitute for it. Gmail read-only access is restricted, and server-side handling can trigger verification/security assessment requirements. [S01, S02]

### Deferred

Apple login; Yahoo/Proton; OneDrive/Dropbox; manual uploads; forwarding intake; bank sync; income and budgeting; receipt line-item accounting; VAT returns; teams; reminders sent by email; cancellation automation; mobile apps; billing; chat interfaces; embeddings; enterprise analytics.

## 4. Architecture

```text
Browser
  -> Cloudflare Pages: React SPA
  -> same-origin /api/* Pages Function: thin service-binding proxy
  -> Worker application: Hono API + auth + scheduled() + queue()
       -> D1: profiles, connections, metadata, records, jobs, usage
       -> Cloudflare Queue + dead-letter queue: opaque job IDs only
       -> Gmail / Microsoft Graph: delegated read access
       -> document-text adapter: bounded PDF/text conversion
       -> AI adapter: operator backend OR user’s chosen provider
       -> Google Drive adapter: optional original-file archive
       -> FX adapter: dated, cached reference rates
```

Pages service bindings support this API proxy pattern. [S03] Use one Worker deployment initially, not a service per box. Domain/application logic is independent of providers and Cloudflare. Runtime functions are separate entry points into the same modules, not independent microservices.

Proposed monorepo:

```text
apps/web/                 React SPA + thin Pages /api function
apps/worker/              fetch, scheduled, queue, composition root
packages/core/            domain rules + application use cases + ports
packages/adapters/        D1, OAuth, Gmail, Graph, Drive, AI, FX
packages/contracts/       Zod/API/extraction contracts and shared DTOs
packages/testkit/         synthetic fixtures, builders, clocks, fake adapters
```

Do not add shared packages until a concrete import boundary justifies them. In particular, no generic `common` dumping ground.

## 5. Data ownership and privacy boundaries

A login is not permission to read email. Ask separately when connecting a mailbox; ask again when enabling Drive archiving. The login Google account, each Gmail account, and the Drive account may be different.

No raw email bodies, attachments, parsed full-document text, model transcripts, credentials, or personal financial values in logs. Queue payloads contain opaque identifiers, not documents. D1 stores structured purchase fields, minimal source metadata, provenance codes, encrypted credentials, jobs, and usage.

Raw bytes and extracted document text are transient application memory only. If a job must retry, it refetches from the source or an existing user-owned archive. It cannot recover a deleted source that was never archived. Explain that limitation plainly.

This is **not local-first, end-to-end encrypted, or zero-knowledge**: the Worker processes plaintext and a selected AI/parser service may receive relevant content. BYOK changes who supplies a key and pays inference costs; it does not eliminate server processing. Publish processor destinations, data-use rules, and retention limitations. User-owned Drive prevents an app-owned raw archive, not all access by the service.

Use Google Drive `drive.file` for app-created/explicitly selected files, not whole-drive access. [S04] Do not request access to all files merely to create a receipts folder.

## 6. Financial meaning

Keep separate concepts:

- A **source document** is an email body or attachment.
- An **observation** is validated information extracted from that source.
- A **purchase** groups evidence about one buying event.
- A **ledger entry** is a document-supported payment or refund counted in spending.

An invoice is not automatically a payment. An order confirmation or shipping update must not create a second charge. A cancellation after a payment does not erase that payment unless a refund is evidenced. A credit note is not necessarily a completed cash refund.

The main metric is `Recorded spending = eligible payments - eligible refunds`, grouped by event date. Label it “Based on connected receipts, not bank-verified.” Show unpaid/unknown invoices separately. Keep pending-review amounts out of trusted totals; show their count and value where known.

Use integer minor units for stored amounts; exact decimal/rational arithmetic for conversion; string money values over JSON. Keep original currency and dated FX provenance. Missing conversion rates must remain visible and excluded from the converted total, not silently treated as 1:1.

Deduplication is tenant-scoped and evidence-based. Never globally merge or cache another user’s financial data. Same merchant, same amount, and same day is not enough to merge two purchases.

## 7. Ingestion pipeline

1. Explicitly authorized mailbox is connected and its source settings recorded.
2. Create a resumable backfill with a fixed date interval. Prioritize recent records without losing the rest.
3. Enumerate message references using deterministic multilingual receipt criteria; preserve pagination and coverage status.
4. Fetch candidate content, bound size/types, normalize HTML to inert text, and distinguish attachments from inline logos.
5. Parse text PDFs through the document-text port. Use image/scanned-document processing only through a verified capable adapter; unsupported or unreadable files go to review.
6. Run deterministic extraction where a supported template proves the needed fields. Otherwise send only the necessary purchase evidence to the selected AI adapter.
7. Validate schema, money/date/reference consistency, evidence, duplicates, and status transitions.
8. Commit structured observations and any eligible ledger effect idempotently. User overrides survive re-extraction.
9. Independently archive originals to Drive if enabled. Archive failure cannot roll back valid extraction.
10. Update review items, derived dashboard data, and recurrence suggestions.

“All receipts found” is not a supported claim. Track the date interval, query mode, folders, skipped types, pending jobs, and reasons. Offer a broader rescan of a chosen range as a correction path.

## 8. Reliability invariants

Queues deliver at least once; handlers cannot assume order or exactly-once execution. [S05] D1 durable job records are the source of truth, with leases, retry state, deduplication keys, and rescheduling. The queue is a delivery mechanism, not the only record of pending work.

A cursor is advanced only after the work represented by that page is durably recorded. A job is acknowledged only after its outcome is committed or a terminal state is recorded. Duplicate delivery, lease expiry, HTTP retry, and callback replay must not double-count a purchase.

External effects cannot share a database transaction. Use stable idempotency markers for uploads and bounded retries for model calls. A timed-out inference request may already have been billed; do not claim exactly-once external billing.

Disconnection increments a connection generation and stops new jobs. Consumers re-check tenant/connection status and generation before side effects and writes. Already submitted network requests cannot be retroactively unsent. No late result may resurrect deleted application records.

## 9. AI and cost contract

The application owns extraction rules and output schemas; adapters own vendor wire formats. “OpenAI-compatible” does not imply identical PDF, image, JSON-schema, reasoning, or output-limit support. Record capabilities explicitly and test them.

No unrestricted arbitrary BYOK endpoints in public hosting. Allow user-supplied keys for operator-approved HTTPS destinations with exact host/path rules. Self-hosted operators may configure additional reviewed destinations. A denied destination is a security constraint, not a reason to expose a server-side open proxy.

Allow only one configured inference destination per extraction attempt. Pause on invalid keys, exhausted allowance, or missing capability. Never send the same invoice to several providers “to compare” without explicit user consent. No model tools, browsing, autonomous actions, or secrets in prompts.

Use per-user and global budgets, bounded input/output, fair background processing, and deterministic merchant categorization rules. Known merchants may avoid classification calls; they cannot bypass extracting a new amount/date.

Workers/Queues/D1 have free allowances, not unlimited free operation. Current Queues free usage includes 10,000 operations daily and 24-hour retention; retain durable job state outside the queue. [S06] Current D1 database size is capped at 500 MB on Free and 10 GB on Paid; this design is a starting point, not infinite database scaling. [S07]

## 10. Required verification

Before any real data: tenant isolation, OAuth state binding, credential encryption, log redaction, request destination restrictions, and deletion barriers.

Before marking M0 complete: real workerd tests, auth/mailbox smoke evidence when credentials are available, PDF/text fixtures, idempotent retries, transparent import status, corrections that survive reprocessing, and no fake completed features.

Before M1: all mandatory acceptance cases, Graph folder coverage, Drive retry behavior, FX/refund/date correctness, recurring estimates, export safety, recovery exercise, and an independent security/principal review.

The detailed commands, coverage thresholds, model-evaluation gates, and reviewer evidence contracts are in `docs/07-engineering-quality.md` and `docs/05-ai-and-evaluations.md`. Coverage percentages supplement behavioral proof; they do not replace it.

## 11. What agents must not invent

OAuth client credentials, provider approvals, a model’s capabilities, pricing, legal compliance, installed CLI versions, test outcomes, exact serverless capacity, real user consent, or confidence in undocumented financial evidence. Unknowns become a blocked task or a Needs Review item, not a confident guess.

The next action is T00, followed by the smallest tested vertical slice. Apply the v1.1 presentation/onboarding tasks T27–T30 according to dependencies, not numeric order. `CHANGELOG.md` lists the revision; `docs/13-presentation-and-onboarding.md` controls detailed UX and `docs/14-market-validation.md` records evidence versus hypotheses. There is no need for another product-scope interview.
