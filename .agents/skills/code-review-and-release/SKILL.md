---
name: code-review-and-release
description: "Review correctness independently and reject incomplete or overcomplicated delivery."
---

# code review and release

## When to use

Pull request review, task closure, milestone integration or release decision.

## Inputs

Read root `AGENTS.md`, the assigned task and these files: `docs/07-engineering-quality.md`, `docs/10-decisions-and-release-gates.md`.

## Procedure

1. Read the task, diff, tests and linked evidence, not just the implementer summary. Separate actual executed results from proposed commands.

2. Inspect money/tenant/security/retry invariants, missing edge cases and needless abstractions. Identify the smallest defensible fix.

3. Return actionable P0/P1/P2/P3 findings with path/line, reproduction, user impact and required regression test. Read-only reviewers do not edit the patch.

4. Check scope, docs, migrations, budgets, privacy and remaining live gates before approving. If no independent tool execution exists, say so.

## Deliverable

Independent review/completion decision using the package templates.

## Quality gate

No self-certified independent review, blanket approval from green unit tests, fabricated live result or premature public launch.

Respect the assigned writable paths. A review assignment is read-only. Record what was actually run and distinguish blocked checks from successful checks.

## Version 1.1 presentation responsibilities

For related changes load `.agents/skills/product-presentation-and-onboarding/SKILL.md`. Check explicit review/start before scanning, recent-first full-range import, synthetic/private isolation, truthful capabilities, and optional setup/measurement boundaries. Do not substitute feature-list completeness for a tested path to usable purchase evidence.
