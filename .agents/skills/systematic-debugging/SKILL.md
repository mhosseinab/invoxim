---
name: systematic-debugging
description: "Reproduce failures and repair root causes without weakening safeguards."
---

# systematic debugging

## When to use

Unexpected test/runtime/provider failure or intermittent race.

## Inputs

Read root `AGENTS.md`, the assigned task and these files: `docs/07-engineering-quality.md`, `docs/09-operations-and-costs.md`.

## Procedure

1. Capture the smallest safe reproduction with synthetic data and identify the violated invariant. Separate provider/environment failures from application defects.

2. Form a falsifiable hypothesis and inspect the relevant boundary with redacted instrumentation. Do not change several unrelated settings at once.

3. Write a regression test that fails for the root cause, make the smallest fix and verify nearby edge cases, including retries and concurrency.

4. Remove temporary instrumentation, preserve user data and report commands/evidence. Never solve a failure by bypassing tenant checks, lowering validation or deleting data.

## Deliverable

Root-cause report, minimal fix and reproducible regression evidence.

## Quality gate

No shotgun config changes, secret dumps, assertion deletion, blind retries or destructive cleanup.

Respect the assigned writable paths. A review assignment is read-only. Record what was actually run and distinguish blocked checks from successful checks.
