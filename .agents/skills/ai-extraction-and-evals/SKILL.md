---
name: ai-extraction-and-evals
description: "Extract evidence-backed receipt fields through bounded provider-agnostic inference."
---

# ai extraction and evals

## When to use

AI adapter, parser capability, prompt/schema, categorization or evaluation change.

## Inputs

Read root `AGENTS.md`, the assigned task and these files: `docs/05-ai-and-evaluations.md`, `contracts/extraction.schema.json`, `test-design/README.md`.

## Procedure

1. Separate document-to-text from invoice extraction. Verify the endpoint capabilities and processor policy; never assume OpenAI-compatible means PDF-capable.

2. Use inert input, no runtime tools and strict bounded JSON output. Validate evidence against input, money/date/currency semantics and explicit paid/refund signals.

3. Reserve allowance before calls; preserve chosen destination, encrypt BYOK and cap attempts. Strip raw input/output/evidence quotes before persistence.

4. Evaluate synthetic labeled challenge and held-out sets; report exact accepted/incorrect/review counts, coverage and costs. Add regressions for every observed failure.

## Deliverable

Adapter/prompt/schema changes, deterministic fixtures and separately labeled live-model evaluation.

## Quality gate

No self-reported confidence acceptance, raw transcript logging, invented OCR support, arbitrary endpoint proxy or fake benchmark score.

Respect the assigned writable paths. A review assignment is read-only. Record what was actually run and distinguish blocked checks from successful checks.
