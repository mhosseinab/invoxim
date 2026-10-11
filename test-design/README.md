# Test design, not test results

`acceptance-cases.json` is the behavioral matrix. Each case has an owner task, milestone and intended test layer. Implement tests from it; do not count JSON entries as tests passed. Cases are deliberately adversarial at the expensive/irreversible boundaries: money, identity, duplicate processing, raw-data retention, and provider calls.

`financial-cases.json` contains exact expected numeric examples. Rates and purchases are invented fixtures, not current market data. Implement money parsing and conversion independently using integer/rational arithmetic, then test against these oracles. Test properties as well: additivity in one currency, dedupe idempotence, sign preservation, safe bounds, and no cross-tenant observation. Multi-currency conversion rounds each entry before aggregation.

`fixtures/receipts.json` contains small synthetic text inputs and labeled extraction outputs. The evidence quotes must occur verbatim in the identified input part. The expected object is a label, not proof a model returned it. Do not build a model adapter that recognizes fixture IDs or simply returns these objects. Expand to the documented corpus of at least 120 examples, including 40 held out, and generated binary PDF/MIME/image fixtures. Keep model evaluation separate from deterministic application tests.

Mandatory additional challenge categories: malformed MIME, zipped/encrypted documents, multilingual dates/currency symbols, unrelated promotions, subtotal versus total, duplicated forward chains, partial card/store-credit payments, existing category overrides, conflicting corrected invoices, test prompts embedded inside receipts, and document text too long for the chosen endpoint. Add synthetic fixtures for each discovered regression before fixing it.

Live-provider/model tests are opt-in, bounded and require approved credentials/destinations. Record endpoint adapter, model ID, prompt/schema version, fixture-set hash, costs/latency, attempted versus accepted counts, error reasons, and unsupported cases. Store redacted aggregate reports, not real customer receipts. A passing deterministic test suite does not establish extraction accuracy or OAuth approval.

## Version 1.1 additions

53 new acceptance specifications cover presentation, static demo, explicit Start, recent-first full history, purchase-first Home, deferred Drive, recurring evidence, simple tags, accessibility, and optional pilot measurement. Their status is not_executed; they are not passing application tests.

`fixtures/onboarding-views.json` contains 16 labeled display projections checked against the new JSON Schema and copy keys. `fixtures/presentation-demo.json` supplies a synthetic four-purchase example with independently checked paid/refunded/net values. `market-benchmark-template.md` is an unrun worksheet, not market evidence. Implementation must still create and run behavioral component/API/E2E tests with real state transitions.
