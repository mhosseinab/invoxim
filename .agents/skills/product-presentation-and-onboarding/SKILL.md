---
name: product-presentation-and-onboarding
description: "Implement truthful purchase-first presentation and a short, consent-safe path to useful records."
---

# Product presentation and onboarding

## When to use

Landing/demo, first login, mailbox connection, import review/progress, purchase-first Home, deferred Drive prompts, UI copy, capability presentation, and optional activation measurement.

## Inputs

Read `AGENTS.md`, the assigned task, `docs/13-presentation-and-onboarding.md`, `docs/01-product-and-ux.md`, `docs/12-api-contracts.md`, and `contracts/ux-copy.en.json`. Read `docs/14-market-validation.md` only for claim or pilot work. Select relevant acceptance IDs; do not load every specialist document indiscriminately.

## Procedure

1. Write a bounded state/capability table before components. Identify the user's task and what the server actually knows. Distinguish login, authorized mailbox, accepted processing, first ready record, full import, and an observed user action.
2. Map copy keys and actions to real DTOs. Show verified account/destination/limits and explain broad read permission accurately. Keep Google/Drive/BYOK authorizations separate. No mail-content read from the callback.
3. Use the shortest normal path: sign in, connect one inbox, review/start. Make optional advanced AI and Drive controls discoverable without turning them into required screens. Do not bypass consent or hide costs to remove clicks.
4. Prioritize recent records without reducing the approved historical range. Render durable stages and record-readiness; allow opening results immediately. Never generate percentages or zero-spend claims from incomplete coverage.
5. Build the static synthetic example with a read-only adapter and no private loaders. Show source-linked paid/refunded/net purchase histories using domain totals, not invented presentation arithmetic.
6. Write failing state/API tests, then component and Playwright tests around denial, wrong account, refresh, double Start, partial/no-results/budget states and processor changes. Use the provided exact demo arithmetic as an independent oracle. Implement the smallest passing behavior.
7. Check 360 CSS px, zoom/reflow, keyboard/focus, screen-reader status changes and reduced motion. Review visible labels against the capability state. Do not auto-navigate when a background count changes.
8. For pilot measurements, use only permitted content-free events after opt-in; test opt-out purge and synthetic exclusion. Leave unrun benchmark results blank. A speed target is not a promise.

## Deliverable

Bounded implementation diff, exact acceptance mappings, synthetic browser evidence, actual command outcomes, capability/copy audit, and explicit limitations. Show whether first results and whole-history completion were tested separately.

## Quality gate

No unsupported marketing claim, pre-consent content request, fake progress, demo/private-data mixing, forced optional setup, inaccessible primary flow, or inconsistent financial figure. Independent reviewer checks behavior and wording together. Do not call self-review independent.
