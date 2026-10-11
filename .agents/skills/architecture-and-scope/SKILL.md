---
name: architecture-and-scope
description: "Design minimal domain boundaries and challenge unnecessary complexity."
---

# architecture and scope

## When to use

A new package, dependency, persistence boundary or material design deviation.

## Inputs

Read root `AGENTS.md`, the assigned task and these files: `docs/02-architecture.md`, `docs/03-data-model.md`.

## Procedure

1. Map the change to the user journey and the existing domain/application/adapter boundary. Explain what cannot fit without changing an invariant.

2. Check current official platform docs and the local pinned versions for any limiting API assumption. Prefer the smallest compatible solution.

3. Keep core pure and business semantics explicit. Reject speculative abstractions, generic base repositories and new infrastructure without demonstrated need.

4. Review migration, privacy, cost and operational consequences; write a concise decision record before a material deviation.

## Deliverable

Boundary/dependency proposal or read-only review with evidence-backed alternatives.

## Quality gate

No import cycles or adapter-to-core inversion. A simpler solution was considered before adding a component.

Respect the assigned writable paths. A review assignment is read-only. Record what was actually run and distinguish blocked checks from successful checks.
