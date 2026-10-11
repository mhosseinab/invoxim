---
name: money-dedup-recurring
description: "Maintain correct payments, refunds, FX, deduplication and recurring estimates."
---

# money dedup recurring

## When to use

Any ledger amount, merge, refund, valuation, override or subscription logic.

## Inputs

Read root `AGENTS.md`, the assigned task and these files: `docs/03-data-model.md`, `test-design/financial-cases.json`.

## Procedure

1. Classify the actual event and evidence first: invoice/order versus completed payment, credit note versus completed cash refund. Keep original documents separate.

2. Use exact minor-unit/rational arithmetic and currency-specific precision. Apply historical rate snapshots and explicit per-entry rounding/date basis.

3. Dedupe only safe identifiers/content; same amount/day is a review hint. Preserve overrides and corrected documents with optimistic versioning.

4. Derive recurrence as a suggestion with anchored calendar handling and distinguish usage variation from price changes. Forecasts never mutate historical spending.

## Deliverable

Pure domain functions with exact oracle, property and replay tests.

## Quality gate

No false payment/refund, double counted installments, erased manual edit, later-date FX, missing-rate=1 or phantom forecast charge.

Respect the assigned writable paths. A review assignment is read-only. Record what was actually run and distinguish blocked checks from successful checks.
