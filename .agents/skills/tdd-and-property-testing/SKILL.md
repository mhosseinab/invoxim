---
name: tdd-and-property-testing
description: "Use behavioral TDD, independent oracles and runtime integration tests."
---

# tdd and property testing

## When to use

Any implementation or bug fix that changes behavior.

## Inputs

Read root `AGENTS.md`, the assigned task and these files: `docs/07-engineering-quality.md`, `test-design/README.md`.

## Procedure

1. Translate acceptance IDs into named tests with concrete assertions. Start with the simplest failure and one high-risk adversarial case.

2. Run RED and identify the precise intended failure. Implement a minimal fix, run GREEN, then refactor without weakening assertions.

3. Use synthetic clocks/provider responses and exact monetary oracles. Add property tests for invariants and failure injection for duplicate deliveries/races.

4. Run actual workerd tests for D1 and bindings; add E2E where behavior crosses the UI. Record commands, exit codes and what remains untested.

## Deliverable

Executable tests plus RED/GREEN/regression evidence tied to task and acceptance IDs.

## Quality gate

No mock-only proof for database atomicity; no fixture-ID hardcoding; no skipped failing assertions to meet coverage.

Respect the assigned writable paths. A review assignment is read-only. Record what was actually run and distinguish blocked checks from successful checks.
