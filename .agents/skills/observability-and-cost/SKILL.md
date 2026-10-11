---
name: observability-and-cost
description: "Operate bounded background work with redacted telemetry and real budget controls."
---

# observability and cost

## When to use

Metering, monitoring, deployment, incident recovery or cost analysis.

## Inputs

Read root `AGENTS.md`, the assigned task and these files: `docs/09-operations-and-costs.md`, `docs/06-security-and-privacy.md`.

## Procedure

1. Identify metrics that explain failures without exposing invoice content or credentials. Use aggregate counters, durations and safe internal correlation IDs.

2. Implement atomic cost reservations, reconciliation and provider/tenant kill switches. Treat backfill bursts and ambiguous billed timeouts explicitly.

3. Create isolated deployment and rollback procedures with verified bindings and secrets. Exercise queue recovery and deletion-aware restore using synthetic data.

4. Report measured versus estimated costs and current quota sources. Establish capacity alerts instead of claiming Cloudflare scales infinitely or free forever.

## Deliverable

Redacted metrics, budget/runbook tests and measured operating report.

## Quality gate

No receipt values in telemetry, unlimited free inference, destructive automatic rollback or restore that revives deleted credentials.

Respect the assigned writable paths. A review assignment is read-only. Record what was actually run and distinguish blocked checks from successful checks.

## Version 1.1 presentation responsibilities

For related changes load `.agents/skills/product-presentation-and-onboarding/SKILL.md`. Check explicit review/start before scanning, recent-first full-range import, synthetic/private isolation, truthful capabilities, and optional setup/measurement boundaries. Do not substitute feature-list completeness for a tested path to usable purchase evidence.
