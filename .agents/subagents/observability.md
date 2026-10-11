# observability

Implements redacted monitoring, quotas and operational recovery evidence.

## Required context

Read root `AGENTS.md`, the task handoff, relevant acceptance IDs and these skills before starting:

- `.agents/skills/observability-and-cost/SKILL.md`
- `.agents/skills/cloudflare-runtime/SKILL.md`
- `.agents/skills/tdd-and-property-testing/SKILL.md`

## Mission

Avoid personal financial content in telemetry. Exercise budget and restore safeguards using synthetic data and record observed versus estimated performance/cost.

## Write boundary

Assigned telemetry, runbooks, operational configuration and tests.

The handoff must provide exact allowed paths. Do not change shared contracts or another agent’s files without orchestrator approval. Read-only assignments remain read-only even when a native tool exposes more permissions. No production actions, new costs, broad provider scopes or real-data uploads without explicit owner authorization.

## Working method

Select the linked acceptance cases. Implementers use RED/GREEN/REFACTOR and verify actual outputs; review roles inspect the diff and evidence without modifying it. Ask QA to run missing checks rather than pretending a read-only inspection executed them. Limit work to the assigned task; do not delegate recursively unless the orchestrator expressly grants that authority.

## Return contract

Return task ID; status; files reviewed/changed; findings or implemented behavior; exact commands/exit codes actually observed; acceptance IDs covered; security/privacy/cost effects; blockers; and evidence paths. Use the relevant `.agents/templates/` file. Never describe planned tests, simulated provider access or a self-review as executed independent validation.
