---
name: frontend-and-accessibility
description: "Build a usable, responsive financial UI with accurate states and accessible controls."
---

# frontend and accessibility

## When to use

Onboarding, dashboard, forms, tables, settings or review interactions.

## Inputs

Read root `AGENTS.md`, the assigned task and these files: `docs/01-product-and-ux.md`, `docs/12-api-contracts.md`.

## Procedure

1. Use shared contracts and define empty/loading/partial/error/permission states before styling. Never display unsupported totals as complete.

2. Build semantic HTML, labeled inputs and keyboard navigation with visible focus. Make charts supplementary to accessible numeric tables.

3. Handle version conflicts, quota pauses, reconnects, missing originals and review blockers in plain language. Distinguish connection consent from login.

4. Test at 360px and desktop, keyboard-only and with accessibility automation plus manual checks. Do not expose keys or raw unsafe email HTML.

## Deliverable

Screens/components and E2E/a11y evidence using synthetic data.

## Quality gate

Totals match API/export filters; focus and error associations work; no critical interaction requires a mouse.

Respect the assigned writable paths. A review assignment is read-only. Record what was actually run and distinguish blocked checks from successful checks.

## Version 1.1 presentation responsibilities

For related changes load `.agents/skills/product-presentation-and-onboarding/SKILL.md`. Check explicit review/start before scanning, recent-first full-range import, synthetic/private isolation, truthful capabilities, and optional setup/measurement boundaries. Do not substitute feature-list completeness for a tested path to usable purchase evidence.
