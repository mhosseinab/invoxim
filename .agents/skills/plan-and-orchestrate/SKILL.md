---
name: plan-and-orchestrate
description: "Plan and coordinate bounded implementation tasks without inventing results."
---

# plan and orchestrate

## When to use

Starting work, selecting a task, integrating parallel patches or declaring a milestone complete.

## Inputs

Read root `AGENTS.md`, the assigned task and these files: `.agents/backlog.json`, `docs/08-implementation-plan.md`, `docs/10-decisions-and-release-gates.md`.

## Procedure

1. Inspect repository state and installed tool capabilities. Read AGENTS and the selected task, its dependencies, relevant rules and acceptance IDs.

2. Select only dependency-ready work. Freeze shared contracts first. Assign at most four specialists and disjoint writable paths using the handoff template.

3. Require RED/GREEN evidence, then independent QA/review when available. Integrate one bounded patch at a time and rerun cross-package checks.

4. Update task status only with actual evidence. Missing credentials, external approval and absent tools remain explicit blockers; do not reopen settled product choices.

## Deliverable

A short task plan, bounded assignments, dependency/status update and an evidence-linked completion or blocked report.

## Quality gate

Prove the task graph has no cycles and all claimed checks/reviews have actual evidence. Never fabricate subagents.

Respect the assigned writable paths. A review assignment is read-only. Record what was actually run and distinguish blocked checks from successful checks.

## Version 1.1 presentation responsibilities

For related changes load `.agents/skills/product-presentation-and-onboarding/SKILL.md`. Check explicit review/start before scanning, recent-first full-range import, synthetic/private isolation, truthful capabilities, and optional setup/measurement boundaries. Do not substitute feature-list completeness for a tested path to usable purchase evidence.
