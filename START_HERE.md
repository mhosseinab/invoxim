# Start here

Version 1.1. Specification and agent instructions, not an application build.

## Prompt to give the coding orchestrator

You are implementing the application defined in this repository. Read `AGENTS.md`, `BLUEPRINT.md`, `CHANGELOG.md`, and `docs/13-presentation-and-onboarding.md` first. Treat `.agents/` as the canonical instruction source. Read `.agents/backlog.json`, `.agents/skill-registry.json`, and the documents needed for your next task. Load `.agents/skills/product-presentation-and-onboarding/SKILL.md` and `.agents/rules/07-truthful-product-ux.md` for product-facing work.

Start with T00. Report the repository's actual state, the installed agent/runtime versions, and any blocked external prerequisites. For an existing implementation, preserve code, migrations, credentials, configuration, and completed evidence; reconcile the v1.1 requirements rather than replacing the repository or resetting its task statuses. Report which existing behaviors must change. Verify native role/skill discovery; if the harness cannot spawn subagents, use the same role instructions sequentially and label that limitation accurately. Do not claim an independent review if the same agent performed it.

Build milestone M0 first. This is a multi-user application from the first migration, even though M0 only implements Gmail. Preserve the full MVP scope in the backlog. Treat presentation and onboarding as product behavior, not end-of-project cosmetic work. T27 defines the copy/capability contract; T28 supplies the static example and landing page; T29 integrates explicit, resumable review/start; T09 and T13 deliver recent-first processing and purchase-first Home. Follow actual dependencies, not numerical task order. T30 is bounded, opt-in validation support in M1, not a prerequisite for first value or a claim of market fit.

The approved experience is: inspect an example; sign in; connect one mailbox; see the real account, range, processing destinations, limits, and background behavior; explicitly start import; open useful purchase records while older history continues. An OAuth callback alone must not read message content or schedule a new scan. Do not require Drive or an API key when approved hosted processing is available. Default history remains 12 months with a recent 30-day priority slice. Do not invent a speed promise, completed feature, savings claim, domain, final brand, or permanent free plan.

Use test-driven development for behavioral code. Keep domain logic independent of Cloudflare and providers. Make small, reviewable changes with one owner per shared file and at most four active specialist subagents. For every task, write the failing test first, observe the intended failure, implement the smallest correct solution, refactor, run the applicable quality gates, and request an independent review. Report exact commands, outcomes, changed files, unresolved issues, and the next task. Never weaken tests, hide skipped tests, invent results, or mark an external integration verified using mocks alone.

Do not deploy publicly, add paid services, change OAuth scopes, change retention behavior, enable an unapproved AI destination, or perform destructive remote actions without the owner's explicit approval. Credentials and accounts are operator inputs, not values to invent. A blocked live integration does not prevent safe local work with synthetic fixtures. Keep public sample data separate from authenticated user state and never present it as a working live integration.

Deliver working increments, not scaffolding advertised as a finished product. Keep the backlog and evidence current. Stop when the requested milestone passes its gates, and give an honest delivery report.

## First expected response

A short T00 report containing: actual repository state; selected milestone; installed tooling and adapter discovery; dependency/version verification plan; prerequisite blockers; the first bounded task and its tests. For an existing build include a v1.1 impact map. Do not reopen product decisions already recorded in the blueprint.
