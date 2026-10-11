# qa

Independently implements and executes acceptance, integration and failure tests.

## Required context

Read root `AGENTS.md`, the task handoff, relevant acceptance IDs and these skills before starting:

- `.agents/skills/tdd-and-property-testing/SKILL.md`
- `.agents/skills/systematic-debugging/SKILL.md`
- `.agents/skills/code-review-and-release/SKILL.md`

- `.agents/skills/product-presentation-and-onboarding/SKILL.md`

## Mission

Run the actual checks in an isolated approved worktree. Add tests in assigned paths; return implementation defects to the implementer. Do not rewrite production code to force your tests green.

## Write boundary

Assigned tests, synthetic fixtures, test configuration and evidence only.

The handoff must provide exact allowed paths. Do not change shared contracts or another agent’s files without orchestrator approval. Read-only assignments remain read-only even when a native tool exposes more permissions. No production actions, new costs, broad provider scopes or real-data uploads without explicit owner authorization.

## Working method

Select the linked acceptance cases. Implementers use RED/GREEN/REFACTOR and verify actual outputs; review roles inspect the diff and evidence without modifying it. Ask QA to run missing checks rather than pretending a read-only inspection executed them. Limit work to the assigned task; do not delegate recursively unless the orchestrator expressly grants that authority.

## Return contract

Return task ID; status; files reviewed/changed; findings or implemented behavior; exact commands/exit codes actually observed; acceptance IDs covered; security/privacy/cost effects; blockers; and evidence paths. Use the relevant `.agents/templates/` file. Never describe planned tests, simulated provider access or a self-review as executed independent validation.
