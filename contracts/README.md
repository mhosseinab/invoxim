# Contract implementation notes

These schemas are design artifacts, not an implemented validator or API. Generate or hand-write matching strict Zod validators during T03/T11 and test parity. Do not maintain divergent permissive variants.

`extraction.schema.json` describes transient AI output. Validate byte limits before parsing; JSON Schema success is only the first check. Verify ISO currency support/minor digits against a pinned reference, actual calendar dates, evidence quotes against identified input parts, magnitude bounds, total/tax consistency, payment direction and explicit payment/refund evidence. Null means unknown, not zero. Positive decimal amount strings describe magnitudes; the domain determines sign from validated ledger-event type. Never store evidence quotes, original input, or full model responses in D1/logs. A category is an inference, not evidence of payment.

One email may contain several documents and one document may describe multiple records. Use a separate extraction per document unless a tested combined-document strategy preserves input-part provenance. Statements do not become aggregate payments. Model output cannot provide a trusted user ID, source URL, provider destination, archive location, or execution instruction.

`config.schema.json` is intentionally nonsecret. Runtime validation adds semantic checks: public signup requires Gate D; enabled hosted inference needs an approved model, known prices, valid secret binding and adapter-specific endpoint; approved BYOK URLs need exact host/path allowlisting, no credentials/query fragments, no redirects and SSRF defense; supported mail providers remain capability-gated until their integration tests pass. A provider’s presence in the example is an intended capability, not an already working integration. For non-Cloudflare AI adapters, enabled hosted inference requires a valid approved HTTPS base URL. Cloudflare AI may use a binding instead.

The default timezone is a suggested initial preference, not a restriction on other users. Offer the user’s browser timezone during onboarding and persist an explicit IANA timezone. The configured maximum prior FX-rate age prevents stale rates from being silently reused during long gaps. If no supported rate exists in that interval, exclude only that unvalued entry from converted totals and show the original value and missing-rate count.

The operator’s AI price cap is denominated in integer millionths of a US dollar. It is a spending guardrail, not a published provider tariff. The example deliberately enables neither hosted AI nor a document converter until the operator selects and verifies them. Deterministic synthetic development can proceed without credentials.


## Document totals versus paid/refunded amounts

`total` is the gross document/order total. `paymentAmount` is the amount actually paid in the evidenced event, `refundAmount` is the evidenced refund amount, and `storeCreditAmount` is credit redeemed, if stated. These are separate nullable magnitude strings. Payment/refund completion is still controlled by the evidence enums. A pending refund can have a known amount without generating a refund entry. Never substitute `total` for an ambiguous installment or mixed-tender amount.

For a receipt clearly stating the full total was paid, paymentAmount can equal total when the evidence establishes that relationship. For EUR 100 total with EUR 70 paid by card and EUR 30 store credit redeemed, the cash-spending event is EUR 70, not EUR 100 plus EUR 30. Keep the gross purchase total for the detail view. An ambiguous split goes to financial review. For a EUR 100 order with one EUR 50 installment, record only the EUR 50 payment event. Model output must include input-grounded evidence for the chosen payment/refund magnitude.

## Presentation/onboarding additions, v1.1

`ux-copy.en.json` is the central copy-key catalog and guarded runtime templates. It is not a substitute for actual approved processor details. `onboarding-view.schema.json` specifies a bounded authenticated display projection; the full start/consent guards live in the API/domain contract. `test-design/fixtures/onboarding-views.json` supplies labeled projections for schema and copy-key tests; these are not implemented reducer results.

`test-design/fixtures/presentation-demo.json` contains only synthetic, read-only records and exact money expectations. Production example mode uses a small reviewed fixture adapter with a parity test, not a D1 demo tenant or a production import of testkit. Copy templates and capability conditions must be tested in browser states during implementation.

The config schema adds safe M0 presentation flags, recent-first day count, and off-by-default opt-in pilot measurement. Schemas use the same shape-version 1 because no application has shipped; package version is 1.1. Do not overwrite a live deployment's config with these disabled example values.
