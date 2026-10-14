# Design-reference refinement — complete

T28 visual refinement, 2026-10-11. Existing demo and landing now follow the five images in `docs/design`: Invoxim tray/document mark, royal-blue accents, navy sans-serif typography, white/pale-blue surfaces, 240px desktop sidebar, outlined icons, rounded bordered purchase/evidence panels and a summary column. Mobile stacks the content and preserves keyboard access.

Changes: `apps/web/src/app.tsx`, `styles.css`, `icons.tsx`, `copy.ts`; `apps/worker/src/index.ts` and its existing public-config integration test align the display name with Invoxim. No new dependency or configuration. Synthetic fixtures, exact monetary rules and unavailable live features are preserved. The mockups guide appearance; live dashboard statistics, accounts, onboarding, recurring and settings functionality are not implemented by this task. Source PNGs and existing user changes were preserved.

## Verification and independent review

The existing public-config test failed for the old name (exit 1, `design-match-brand-red.txt`), then all five workerd tests passed with Invoxim (exit 0, `design-match-brand-green.txt`). Scoped frontend format/lint/types/build exited 0; [implementation detail](design-match-report.md).

Independent QA `/root/runtime_qa` ran frozen install and full `pnpm verify` in a clean isolated snapshot. Final exit 0: 95 tests represented, including 5 fresh browser tests, 5 fresh workerd tests and 7 boundary tests. Unchanged 39 core + 39 contract tests and 1,500 property runs were executed fresh in the initial QA run and reused from cache in the final CSS-only runs. No test was skipped or weakened. Final 70-file source manifest: `e3e8fabe6914f5258d2fca20f80a0f7ffc52a0a3c915d1a74276101be353ac4f`. [QA report](design-match-qa.md), [final command output](design-match-qa-verify-final.txt), [snapshot](design-match-qa-snapshot-final.txt).

QA caught and verified fixes for footer contrast and 200% CSS-zoom overflow. Contrast uses the darker existing palette; explicit grid minimums and content wrapping repair reflow without clipping. Browser checks cover exact figures, local retrieval and evidence, disabled mutations, no API/external traffic, storage-sentinel independence, keyboard focus, 360px mobile, zero axe violations and CSS zoom. Root also checked landing reflow: viewport/content both 360px at normal scale and CSS zoom2. Native browser zoom and assistive-technology certification were not performed.

Separate read-only principal reviewer `/root/discovery_review` approved the final source and all five reference images plus desktop/landing/detail/mobile/zoom screenshots and QA evidence. No open findings. Reviewer performed no edits or test executions; implementer fixed findings and QA executed regression evidence. T28 is recorded done again after review. M0 remains incomplete.

## Screenshots and preview

- [Desktop demo](design-match-desktop.png) and [landing](design-match-landing.png).
- [Expanded synthetic evidence](design-match-evidence.png).
- [Mobile demo](design-match-qa-mobile.png) and [CSS zoom](design-match-qa-zoom.png).
- [Mobile landing](design-match-landing-mobile.png); [normal reflow](design-match-landing-reflow.txt), [CSS-zoom reflow](design-match-landing-zoom-reflow.txt).
- [Local demo](http://127.0.0.1:4176/demo).

No data, migration, credentials, permissions, retention, processor destination, cost or deployment changes. Actual login/import/export and real authenticated cache isolation remain unimplemented; synthetic sentinel tests do not prove them. No public site or CI run was claimed.
