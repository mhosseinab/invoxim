# Money, evidence and AI


An invoice is not proof of payment. A credit note or refund request is not necessarily a completed cash refund. Maintain documents/evidence separately from purchases and actual ledger events. Forecasts never create ledger entries. Pending/ambiguous financial facts remain visible but do not silently inflate spending.

Use integer minor units, BigInt/exact decimal or rational arithmetic, explicit currencies and decimal-string JSON. Never use floating-point arithmetic for financial totals. Parse currency-specific precision, reject unsupported magnitudes and dates, snapshot historical FX, and round each converted ledger entry consistently. Missing FX is not a rate of one.

Dedupe exact sources/content and strong purchase/payment identifiers. Same merchant, amount and day are insufficient for automatic merging. Preserve conflicting versions and user overrides. All repeated queue deliveries and sync replays must be financially idempotent.

AI extracts candidates, not authoritative facts. Strictly validate schema, evidence, dates, amounts, payment/refund semantics and destination capabilities. A model’s confidence score cannot authorize automatic acceptance. Bound bytes, tokens, retries and spend before calling any model. Retain only allowed structured fields and provenance codes, never evidence quotes or full responses.
