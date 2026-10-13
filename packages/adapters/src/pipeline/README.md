# Internal extraction-to-ledger pipeline

The Worker composition root selects concrete Gmail and approved AI adapters from validated server bindings. The application-facing content/inference ports carry transient document inputs and approved configuration; domain reconciliation imports neither vendor clients nor environment bindings. Checked-in integration flags remain false, and new discovery readiness awaits explicit review/start integration.

Processing uses the existing durable source jobs in three stages:

1. Parse fetches bounded transient MIME content and persists document identity/hash/parser metadata. At most eight unique attachments are downloaded in one parse stage. Existing parser limits remain 4 MiB decoded bytes, 64 parts and eight levels.
2. Infer refetches the selected part, verifies its hash/parser identity and uses the selected hosted/BYOK provider with one paid attempt. The stage reserves 23 remaining database statements before inference for settlement and either success or document-failure continuation. Temporary invocation headroom shortage retries before calling a model. Quota/rate limits and invalid credentials pause processing.
3. Reconcile reads a quote-free cached result, loads tenant-scoped bounded candidates and applies the pure ledger plan in one fenced native D1 batch. A continuation advances to the next document; no raw bytes, text, quotes or transcripts enter durable jobs or records.

Every write checks the trusted job lease/fence/deadline, active profile, connection generation, accepted background consent, AI settings and disclosure. Financial commits additionally bind document/hash/cache identity and expected purchase versions. A live optimistic conflict retries with a fresh snapshot; authorization changes refuse writes. Uncertain inference usage retains its reservation and cannot authorize another paid call for that attempt.

Unsupported documents and per-document refusal/timeout failures retain actionable operational reviews and allow siblings to continue. Invalid keys pause authorization and provider rate limits pause budget. Original bytes and parser output are transient. The local PDF adapter supports only its documented conservative subset; these implementations do not prove live Gmail/model behavior or plan CPU feasibility.

Migration 0010 preserves legacy observation fields and adds an optional versioned structured payload, indexed observation references, document/stage metadata and tenant-owned review items. SQL constrains outer payload keys and size; application validation checks the complete nested allowlist, including quote-free provenance. SQL constraints alone do not represent the full extraction schema. Native upgrade tests exercise populated legacy rows.

The ledger treats invoice/order amounts as gross evidence, independent cash references as event identities and merchant/amount/day as a review hint. It preserves established gross totals/manual fields, records conflicts and derives versioned payment-state projections from accepted events. Refund document totals remain separate from original invoice gross. Unrecognized legacy financial identities cannot authorize an additional cash event. A later larger order total does not silently replace an already retained installment total; financial review preserves both observations. Correction and review-action UI belong to T14.

One queue message is consumed per Worker invocation, with one actual shared D1 counter capped at 40. Deployed Queue configuration must match this policy. Native synthetic tests measure this local bound; no production consumer, live processor, public onboarding journey or release approval is implied.
