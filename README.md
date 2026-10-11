# Inbox Ledger: agent-ready build blueprint

Version 1.1 • Prepared October 11, 2026 • Working name, not a cleared product brand

This is a specification and coding-agent instruction package. It is **not an implemented application**. No application tests, OAuth connections, deployments, or live extraction benchmarks have been run. The included package validation checks only this blueprint’s structure and supplied fixtures.

## Start

1. Read `START_HERE.md`, then the root `AGENTS.md`. For an existing implementation, read `CHANGELOG.md` before merging this revision.
2. Read `BLUEPRINT.md` and `docs/13-presentation-and-onboarding.md`. Load other specialist documents and skills only when the current task needs them.
3. Begin with task `T00` in `.agents/backlog.json`. Do not launch public signup or process real mailbox data before the relevant gates are satisfied.

The first delivery is a small, authenticated, multi-tenant Gmail vertical slice. The full MVP also includes Outlook, optional Google Drive archiving, background sync, user corrections, currency conversion, recurring-payment detection, exports, and deletion. These are separate milestones, not permission to quietly drop agreed features.

## Package map

| Path | Purpose |
|---|---|
| `BLUEPRINT.md` | Product contract, architecture, scope, invariants, and milestone definition |
| `docs/01-product-and-ux.md` | Screens, user journeys, financial presentation, and failure states |
| `docs/02-architecture.md` | Monorepo, boundaries, runtime, jobs, deployment, and scalability |
| `docs/03-data-model.md` | Tables, constraints, states, provenance, and monetary semantics |
| `docs/04-email-and-storage.md` | OAuth, Gmail, Microsoft Graph, Drive, sync, and retry details |
| `docs/05-ai-and-evaluations.md` | Provider interfaces, extraction, document parsing, and evaluation gates |
| `docs/06-security-and-privacy.md` | Threat model, consent, tenant isolation, deletion, and release restrictions |
| `docs/07-engineering-quality.md` | TDD, SOLID/DRY/KISS/YAGNI, CI, test evidence, and review rules |
| `docs/08-implementation-plan.md` | Human-readable task plan and dependencies |
| `docs/09-operations-and-costs.md` | Budgets, deployment runbook, recovery, limits, and monitoring |
| `docs/10-decisions-and-release-gates.md` | Decisions, defaults, unresolved operator inputs, and launch gates |
| `docs/11-source-register.md` | Dated primary sources supporting platform/API decisions |
| `docs/12-api-contracts.md` | Routes, request behavior, authorization, and API errors |
| `docs/13-presentation-and-onboarding.md` | Positioning, landing page, example mode, explicit onboarding, progressive import, and first-value UX |
| `docs/14-market-validation.md` | Competitor evidence, audience hypotheses, bounded pilot goals, and optional measurement |
| `contracts/` | Extraction/configuration/onboarding schemas and centralized user-facing copy |
| `config/app.example.json` | Safe initial configuration, with live AI disabled until configured |
| `test-design/` | Acceptance matrix, extraction/financial/onboarding fixtures, synthetic demo data, and an unexecuted market benchmark worksheet |
| `.agents/` | Canonical rules, skills, role instructions, task backlog, and handoff templates |
| `.codex/`, `.claude/`, `.opencode/` | Thin native agent adapters; canonical instructions remain under `.agents/` |
| `tools/` | Blueprint validation and optional Claude skill-copy helper |
| `CHANGELOG.md` | Changes from v1.0, scope boundaries, and safe upgrade instructions |
| `VALIDATION.md` | What was actually checked during packaging, and what was not |

## What is intentionally absent

No billing integration, bank access, accounting suite, native mobile app, microservices, vector database, production credentials, or fabricated implementation results. No product name, pricing tier, legal compliance status, or universal inbox compatibility is assumed to be settled.

Source IDs such as `[S01]` refer to `docs/11-source-register.md`. Requirements and numerical product limits are design decisions unless identified as verified platform facts. Recheck changing platform details before implementation and before public launch.

## Package contents at a glance

16 project-specific skills, 13 role definitions, seven engineering rule files, native adapters for Codex/Claude Code/OpenCode, 31 dependency-ordered tasks, 160 acceptance cases, 14 synthetic extraction fixtures, 20 exact financial examples, 16 onboarding display fixtures, and 73 centralized copy keys. Start with the master blueprint and load specialist files only as needed. These are implementation instructions and test designs, not a completed application.

## What changed in v1.1

The presentation now leads with **Your purchase records, across inboxes.** People can inspect a clearly labeled synthetic example without authorizing email. First use is **Sign in → Connect → Review and start**; signing in and granting mailbox access do not themselves start reading messages. Actual processing destinations and limits appear before the explicit Start action.

Recent 30-day results get priority within the unchanged 12-month default import. Home leads with searchable purchase records and linked payment/refund evidence, not a wall of charts. Drive archiving and BYOK remain optional, and incomplete features cannot be advertised as working. These are planned implementation requirements, not features already shipped.
