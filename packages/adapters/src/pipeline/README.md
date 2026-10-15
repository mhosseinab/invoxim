# Internal extraction-to-ledger pipeline

The Worker composition root (`apps/worker/src/mailbox-runtime.ts`, `pipeline-runtime.ts`) builds one pipeline per mailbox provider from validated server bindings: `createGmailContentFactory` or `createOutlookContentFactory` for transient content, plus the approved AI adapters. The content/inference ports carry transient document inputs and approved configuration; domain reconciliation imports neither vendor clients nor environment bindings. In the checked-in `apps/worker/wrangler.jsonc`, `EXTRACTION_ENABLED`, `GMAIL_ENABLED` and `JOBS_ENABLED` are `true` and `OUTLOOK_ENABLED` is `false`. These flags do not prove live provider or model behavior.

## Modules

- `service.ts`: `createPipelineService().run()` drives one leased `source-extract`/`reprocess` job through the stages below and maps every result to a job outcome.
- `repository.ts`: `createPipelineRepository()` with the `PipelineRepository` port (`load`, `checkpoint`, `stageDocuments`, `advance`, `cachedResult`, `loadSnapshot`, `commit`, `skipDocument`, `skipSource`, `failDocument`, `fail`). Every write is one fenced native D1 batch.
- `ledger-snapshot.ts`: `loadLedgerSnapshot()`, the bounded tenant-scoped read that feeds core `planLedgerIngestion`.
- `plan-validation.ts`: Zod identifiers/metadata, `checkedResult`/`checkedInput` and `validatePlan`, which checks a core plan before it is written.
- `repository-guards.ts`: shared SQL fragments and batch helpers, also used by `jobs/`, `corrections/`, `lifecycle/`, `purchase-views/`, `mailbox/` and the Worker.
- `gmail-content.ts`, `gmail-batch.ts`, `outlook-content.ts` and the two factories: bounded transient content readers.

## Shared guard fragments (`repository-guards.ts`)

- `connectionConsentLiveSql()`: the single connection/consent "live" rule (connected, active mailbox with credentials, active profile, non-revoked background consent). Callers append their own `accepted_at<=?`.
- `leaseLive({alias, extras})`: the lease/consent live predicate. The joined form binds the held lease (user, job, lease, fence, expiry, connection, generation, consent). The correlated form (`alias.jobs: "jobs"`) checks an existing jobs row without lease binds. `extras` adds caller conditions.
- `liveWhere`/`liveGuard`/`cachedGuard` build the pipeline guard on `leaseLive`. They also require matching AI settings revision, destination and disclosure version, an active complete AI configuration, a live source at the current generation that is not discarded (`sourceNotDiscardedSql`), and, for the cache guard, a completed extraction bound to the document hash and AI identity.
- `currentDocumentGuard()` pins the job's current document in the `infer`/`reconcile` stage. `failDocument` uses `checkParseState: false` because its own batch rewrites `parse_state`. `nextDocumentGuard()` checks the successor document.
- `activeProfile(alias)`, `activeProfileSql` and `sessionLiveWhere()` (session exists, not expired, profile active; no recent-auth window).
- `driveFileScopeSql()`, `mailboxScopeSql()`, `processingSelectionSchema`/`processingSelectionSql()` (the one consent-review selection projection), `versionGuard()` and `executeBatch()`.
- `SOURCE_STATUS_CASE`: the single source-status derivation shared by `commit` and `skipDocument`. An open review item or any document outside `ready`/`extracted` keeps the source at `review`. Otherwise a `ready` document gives `discovered`, an `extracted` one `processed`, and the rest `unsupported`.

## Stages

Processing uses the existing durable source jobs in three stages:

1. Parse fetches bounded transient MIME content and persists document identity/hash/parser metadata. At most eight unique attachments are downloaded in one parse stage. Parser limits are 4 MiB decoded bytes, 64 parts and eight levels (`DOCUMENT_LIMITS`).
2. Infer refetches the selected part, verifies its hash/parser identity and uses the selected hosted/BYOK provider with one paid attempt. Before any paid classification or extraction call, the service requires `PAID_ATTEMPT_STATEMENT_RESERVE` (23) remaining statements for settlement and continuation. A shortfall returns a transient retry before a model is called. Budget, in-progress and rate-limit outcomes pause on budget. Invalid keys and settings changes pause on authorization.
3. Reconcile reads a quote-free cached result, loads the ledger snapshot and applies the validated pure ledger plan in one fenced native D1 batch. A continuation advances to the next document. No raw bytes, text, quotes or transcripts enter durable jobs or records.

## Write guards and the consent digest gate

`createPipelineRepository` requires a `processingDigest(selection)` resolver; it is no longer optional. `load`/`checkpoint` read the processing selection through the live guard and compare the resolver's digest with the consent's `accepted_configuration_digest`. Writes are refused unless they match. Every later write adds an `EXISTS` on that accepted digest. Without an accepted digest the guard is `0` and the write is stale. The Worker passes `createProcessingReviewResolver(ai)`.

Every write therefore checks the trusted job lease/fence/deadline, active profile, connection generation, accepted background consent and digest, AI settings and disclosure. Financial commits additionally bind document/hash/cache identity and the plan's expected purchase versions (`versionGuard`, which also refuses purchases under lifecycle deletion or recompute). A live optimistic conflict retries with a fresh snapshot. Authorization changes refuse writes. Uncertain inference usage retains its reservation and cannot authorize another paid call for that attempt.

## Unsupported siblings and document failures (PIPE-1)

Owner rule (final): keep the current flow. During parse, a non-ready document (for example a ZIP sibling of a receipt) is staged with its non-ready `parse_state`. When the pipeline reaches it, the service fails it through `failDocument`, which does the following in one batch:

- sets `parse_state='needs_review'` with the parser code (for example `unsupported_type`);
- inserts one operational `document-review` review item (`document-review:<documentId>`);
- continues to the next document, or sets the source to `review` if it was the last document.

The source therefore ends at `review`, and the import progress review count equals the open review items. This is pinned end to end in `apps/worker/test/pipeline-adversarial.test.ts` ("PIPE-1 receipt with an unsupported ZIP sibling…"). After parse, per-document timeout/input-limit/unsupported/refusal/outage inference failures, content byte limits and unavailable sources follow the same document-review path, and siblings continue. A failure before any document is staged settles the whole source through `fail`. Original bytes and parser output are transient. The local PDF adapter supports only its documented conservative subset.

## Ledger snapshot (`ledger-snapshot.ts`)

The snapshot loads the candidate purchases (invoice/order reference, content hash, merchant/date/total hint, cash business keys and manual evidence), their observations and ledger events. It also loads match decisions, manual evidence and three sets of facts that let ingestion recompute payment state with the same rules as corrections:

- Credit proofs: `creditProofSql`/`parseCreditProofRows` from `corrections/allocation.ts` (OQ-A).
- Cash proofs per event: observation document, evidence code, whether the observation is accepted, and `connectionDeletionPending` from `corrections/data.ts` `deletionPendingSql` (OQ-C).
- Open financial reviews that can block cash. These are purchase-scoped, linked through an entry's observation or, without observation, its document, or on the current document. `payment-allocation-review` is excluded (OQ-B).

Every read is bounded and fails closed:

- more than 100 purchases, 1,000 observations or 1,000 events raises `PIPELINE_LIMIT`;
- more than 200 credit rows for a purchase also raises `PIPELINE_LIMIT`;
- more than 1,000 decisions or reviews, 100 manual-evidence rows or 20 field overrides on a purchase also raises `PIPELINE_LIMIT` (the SQL reads one row past each bound, checked before schema validation);
- a candidate purchase under lifecycle deletion or recompute raises `PIPELINE_CONFLICT`;
- a missing authorization row returns `null`, which the service treats as stale.

Core `planLedgerIngestion` then derives payment state with the corrections rules: core `settlementEvents` plus `evaluateCorrectionSettlement` over the currently supported cash and credit. Ineligible (excluded/merged) cash, unaccepted cash, cash of a connection pending deletion and cash blocked by an open financial review never raise payment state. This plan's own explicitly-paid observations count as credit proofs only when they carry no planned or open financial review, so a possible-duplicate or reviewed receipt stays `unknown` until the review is resolved; no document forces `paid` directly. A stored `paid` is not retained without support. A user `paymentState` override is kept.

## Ledger rules and schema

The ledger treats invoice/order amounts as gross evidence, independent cash references as event identities and merchant/amount/day as a review hint. It preserves established gross totals/manual fields and records conflicts. Refund document totals stay separate from the original invoice gross. Unrecognized legacy financial identities cannot authorize an additional cash event. A later larger order total does not silently replace an already retained installment total; financial review preserves both observations.

Migration 0010 preserves legacy observation fields and adds an optional versioned structured payload, indexed observation references, document/stage metadata and tenant-owned review items. SQL constrains outer payload keys and size. Application validation checks the complete nested allowlist, including quote-free provenance. SQL constraints alone do not represent the full extraction schema. Native upgrade tests exercise populated legacy rows.

## Statement budget (G-40)

One queue message is consumed per Worker invocation, with one shared D1 statement counter capped at 40 (`QUERY_LIMIT` in `apps/worker/src/job-configuration.ts`, `JOBS_QUERY_LIMIT`). The repository's `batch()` raises `PIPELINE_LIMIT` before sending a batch whose statements plus settlement headroom exceed `remainingStatements()`. Guard consolidation must not add statements on these paths. The deployed Queue configuration must match this policy. Native synthetic tests measure this local bound. They imply no production consumer, live processor, public onboarding journey or release approval.

## Neighbouring modules without their own README

- `../corrections/`: `createCorrectionStore()` runs the user correction commands (purchase edit, event edit, cash confirm, exclude/restore, merge/unmerge, review actions, not-a-purchase source discard). Each command first checks a live session (`activeProfileSql`) and replays by route/key, and a different body conflicts. It owns the SQL that the pipeline snapshot and lifecycle recompute reuse: `creditProofSql`/`parseCreditProofRows` (`allocation.ts`), `deletionPendingSql` and the cash-blocking review superset loaded by `reviews()` (`data.ts`), and `sourceNotDiscardedSql` (`source-decision.ts`). The purchase view (`reader.ts`) lists the whole superset because it blocks the purchase's cash, but offers actions only on reviews the purchase owns. Unmerge evaluates each restored side against its own reviews plus the superset reviews linked to that side's entries. Resolving a financial review (review action or cash confirm) runs `review-unblock.ts`: it re-enables entries that review alone kept ineligible on included linked purchases (at most four, otherwise `TOO_LARGE`) and recomputes their payment state and allocation questions in the same atomic batch. Settlement arithmetic lives in core (`evaluateCorrectionSettlement`, `settlementEvents`).
- `../fx/`: reporting-currency valuation of eligible ledger entries. It contains the public reference-rate reader (`reference.ts`, disabled in checked-in config by `FX_REFERENCE_ENABLED=false`), the `entry_valuations` repository with policy-hash and version guards (`repository.ts`), and paged reporting/revaluation (`service.ts`). It also has signed historical period summaries (`period.ts`, `period-signing.ts`) with one shared valuation join, entry mapper, `minorBinding` and period-totals reducer (`period-valuation.ts`). FX code does not write `ledger_entries`, and a missing rate has no fallback.
