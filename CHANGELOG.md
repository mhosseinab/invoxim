# Changes and safe upgrade guide

Current implementation status lives in `.agents/backlog.json`, `README.md`, `MANUAL_TASKS.md` and `DEPLOYMENT_CHECKLIST.md`, not in this changelog. This file records specification revisions and safe upgrade procedure.

## v1.1 • October 11, 2026

This revision adapts the original agent blueprint to the market evaluation, especially presentation, onboarding, and the first useful result. It updates the existing requirements and task graph, not just a standalone marketing note. No application has been implemented or deployed by this revision.

### Product changes

| Area | v1.1 requirement | Reason |
|---|---|---|
| Positioning | Lead with **Your purchase records, across inboxes.** Show retrieval, documented payments/refunds, and organized history. | An inexpensive AI expense tracker alone is not a demonstrated market gap. |
| Audience | Start with digitally active individuals and solo freelancers as a testable audience hypothesis. | Avoid treating everyone who spends money as one validated audience. |
| Presentation | One responsive landing page with honest provider availability, real allowance details, and clear processing information. | The experience must explain value and limits before requesting inbox access. |
| Try before connecting | Static `/demo`, always labeled synthetic; no login, private API calls, provider connections, or model requests. | Let people inspect the actual workflow before making a trust decision. |
| Onboarding | **Sign in → Connect → Review and start**. One mailbox first, selected account visible, no business survey. | Reduce unnecessary setup without hiding important decisions. |
| Explicit processing start | OAuth callback stores verified connection only. The Start action binds accepted disclosure, range, destination, and background behavior. | Login and mailbox authorization must not silently initiate message reading. |
| AI setup | Approved hosted backend is the ordinary path when available. BYOK is a collapsed optional alternative; real processor destinations remain visible. | Do not turn a consumer workflow into an API configuration exercise. |
| Progressive import | Prioritize the recent 30 days within the unchanged 12-month default; show usable records before history completes. | Provide value sooner without sacrificing historical coverage or financial accuracy. |
| Home and detail | Search, coverage, next useful action, recent purchases, then summaries/charts. Display Paid / Refunded / Net recorded with evidence. | The first screen should solve a receipt/purchase task, not only display totals. |
| Original documents | Optional Drive connection after first value or on demand. It never blocks extraction. Explain that later archiving requires the source to remain available. | Avoid another mandatory authorization screen while preserving the archive choice. |
| M1 refinements | Comparable recurring-charge evidence and simple manual Personal / Work / Unassigned tags. | Support useful review/export without expanding into accounting or claiming subscription usage knowledge. |
| Measurement | Optional, first-party, content-free pilot events, disabled by default and separately opt-in; empty benchmark worksheet. | Test usefulness without adding tracking vendors or fabricating product-market fit. |

### Agent and verification changes

- Added `docs/13-presentation-and-onboarding.md` and `docs/14-market-validation.md`; revised product, architecture, data, integration, security, API, quality, operations, decisions, and implementation documents in place.
- Added `.agents/skills/product-presentation-and-onboarding/SKILL.md` and `.agents/rules/07-truthful-product-ux.md`; updated existing specialist instructions and review/completion evidence requirements. Native adapters still point to canonical roles.
- Added T27–T30 and revised existing task dependencies/acceptance criteria. There are now 31 tasks; the IDs are stable identifiers, not execution order. M0 completion includes its presentation/onboarding tasks, while Outlook/Drive/recurring remain full-MVP work.
- Added 53 acceptance specifications, bringing the total from 107 to 160. They cover sample/private isolation, consent, account selection, double Start, refresh, partial/no-result import, quota pauses, evidence displays, accessibility, optional Drive, and opt-in measurement.
- Added 73 central copy keys, an onboarding projection JSON Schema, 16 labeled onboarding views, and a four-purchase synthetic presentation fixture with independently checked arithmetic.
- Added presentation validation and eight helper regression tests; the original blueprint helper suite contains 20 tests. Application verification uses `pnpm verify`.
- Added five dated primary-source entries for competitor offerings and OAuth/data-use policies. Existing platform-source entries remain; not all were re-researched in this revision. Competitor accuracy, privacy, traction, and product-market fit have not been independently established.

### Decisions preserved

Cloudflare hosting; multi-user isolation from the beginning; multiple mailboxes; Google login; Gmail first and Outlook in the full MVP; 12-month default history; hourly synchronization; currency support; financial correctness; edits; optional user-owned Google Drive originals; no app-owned R2 archive; approved hosted AI plus BYOK; usage caps; no billing implementation; monorepo and TDD; public-release prerequisites.

Inbox Ledger remains a configurable working name. No final name, trademark/domain availability, pricing, license, legal compliance, or public-launch authorization is selected by this revision. The five-minute first-value goal and pilot continuation targets are experiments, not public performance guarantees or evidence of demand.

No bank sync, chat assistant, accounting suite, refund recovery service, cancellation automation, onboarding service, analytics SDK, CRM, waiting-list backend, or new microservice is added. The original extraction fixture set and exact financial examples are preserved.

### Using this package with an existing repository

1. Preserve your current application, uncommitted work, migrations, credentials, runtime configuration, and test evidence. Treat this ZIP as a revised specification package, not a replacement application repository.
2. Diff `BLUEPRINT.md`, the revised documents, contracts/config shape, `.agents/` instructions, and task graph. Merge safe documentation changes; do not overwrite a configured `app.example.json` derivative or completed backlog status blindly.
3. Run T00 as a bounded state/impact review. Map completed work against the new requirements. Add focused follow-up work where an existing OAuth callback starts scans, Home is chart-first, processing destinations are hidden, or onboarding blocks on optional setup.
4. Keep task IDs and evidence. Apply dependencies in topological order; only rerun completed implementation work when its contract has changed. Acceptance IDs remain stable, with new cases appended.
5. Run package validation, then the actual application's affected unit/integration/E2E tests. A passing helper script does not validate the implementation. Public release still requires its separate gates.

For a new repository, start with `START_HERE.md` and T00 normally. For this repository, treat the v1.1 text as the specification baseline and reconcile against the existing implementation rather than restarting. `docs/13-presentation-and-onboarding.md` governs v1.1 presentation details; security, consent, isolation, and financial invariants continue to govern all UX decisions. Flag genuine conflicts instead of silently choosing the weaker requirement.
