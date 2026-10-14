# T28 completion report

Task: T28 / M0. Status: review; source frozen and independent QA/principal review assigned by root. No independent outcome is invented here. Increment is a static landing page and isolated read-only `/demo`; auth, processing, import, archive, private caching and account switching remain unimplemented.

## Implemented behavior

Approved purchase-first headline/description, configurable working-name prop typed from shared `PublicConfig`, labeled synthetic preview, in-page permission/coverage explanations and example navigation. Live sign-in is disabled and explained; no active mailbox/Drive/Outlook/Recurring action or hosted/free allowance promise. No invented operator, legal details, commercial name, prices, customer claims or processor.

Typed production synthetic fixture copied from canonical fixture with test-only parity check. Money uses `@invoxim/core` `ledgerTotals`/`formatMinor`, never a separate financial kernel. Four distinct purchases: EUR 150 paid, EUR 30 completed refund, EUR 120 period net; headphones EUR 90 lifecycle net; EUR 80 unpaid invoice visibly excluded; two separate EUR 15 same-merchant/day records preserved. Search/filter and source evidence disclosures stay local. Edit/export/sync/archive controls are disabled and explained. No API loader/fetch, session/storage read, private state, provider/model call, external source navigation or persistence in production source.

Files owned/changed: `apps/web/src/main.tsx`, `app.tsx`, `copy.ts`, `demo.ts`, `demo-fixture.ts`, `styles.css`, `vite-env.d.ts`; `apps/web/tests/demo.spec.ts`, `fixture.spec.ts`; `apps/web/playwright.config.ts`, `apps/web/tsconfig.json`; `evidence/implementation/t28-*` except the previously frozen handoff. Root owns/changed manifests, workspace links, scripts and browser installation separately.

## Actual commands and results

Environment: root-pinned React 19.3.0 / Vite 8.3.4 / Playwright 1.64.0 / axe Playwright 4.13.0. Browser path `/tmp/invoxim-playwright-browsers`, provided/installed by root. Current docs verified via primary React useState and Playwright web-server/assertion/accessibility documentation because Context7 has no callable tool. No dependency installation by this writer.

RED: `pnpm exec playwright test -c apps/web/playwright.config.ts --grep PRESENT-02` was first run against the real scaffold before implementation. Initial attempt lacked the pinned browser path; corrected attempt showed failing test (5.2s), but pnpm-dev nested server teardown stalled and final exit was not observed. Those incomplete logs (`t28-red.txt`, `t28-red-ready.txt`, `t28-red-assertion.txt`) are not claimed successful RED command exits. Direct Vite server replaced the nested launcher. `t28-red-baseline-rerun.txt` records a subsequent explicit original-scaffold reconstruction, failing approved-heading DOM assertion, observed Playwright exit 1; implementation source restored in `finally` before freeze. This rerun is labeled as reconstruction, not fabricated original chronology. One interrupted verification also observed the unpaid-label DOM defect before it was corrected (`t28-green.txt`, exit 1).

GREEN: `PLAYWRIGHT_BROWSERS_PATH=/tmp/invoxim-playwright-browsers pnpm exec playwright test -c apps/web/playwright.config.ts`, observed exit 0, 5 tests / 2.5 seconds in `t28-green-final.txt`; repeated after central-copy/typecheck inclusion cleanup: exit 0, 5 tests / 2.4 seconds in `t28-green-refreeze.txt`. This executed:

- PRESENT-02 unavailable sign-in and working labeled example.
- DEMO-01/03/04 exact displayed summary/lifecycle values, separate same-price receipts, unpaid exclusion, local search/filter/evidence, disabled mutations and request capture rejecting `/api/*` or external hosts.
- DEMO-02 synthetic private-storage sentinel independence; explicitly not real auth/query-cache/logout integration.
- 360 CSS px keyboard focus/Enter, reduced-motion emulation, no horizontal overflow, axe WCAG A/AA-tag automated scan with zero violations, then 200% **CSS zoom/reflow** (effective 180 CSS px content). Native browser zoom was not exercised.
- DEMO-03 canonical fixture parity via test-only file read; production imports only its copied typed fixture, never testkit.

Corrections during GREEN: Vite CSS type declaration, exact unpaid-label span, synthetic evidence locator scoped to opened evidence, repository-absolute screenshot paths, test-only fixture parity removed shared core Node loading because canonical JSON import lacks native Node import attributes (runtime browser imports through Vite and core's own Vitest tests remain unchanged). No assertions weakened; exact totals and isolation checks stay fixed. Prior failed results are retained in `t28-green.txt`, `t28-green-2.txt`.

Scoped regression commands, each observed exit 0:

- `pnpm exec prettier --check apps/web/src apps/web/tests apps/web/playwright.config.ts apps/web/tsconfig.json` → `t28-format.txt`.
- `pnpm exec eslint apps/web/src apps/web/tests apps/web/playwright.config.ts` → `t28-lint.txt`.
- `pnpm --filter @invoxim/web typecheck` → `t28-types.txt` initially source/functions; `t28-types-final.txt` now also checks Playwright tests/config with Node types, observed exit 0.
- `pnpm --filter @invoxim/web build` → `t28-build.txt` (Vite bundle plus Pages Function build; no deployment).

After final central-copy/test-typecheck inclusion cleanup the same scoped formatter/linter/build commands were repeated: all observed exit 0, recorded in `t28-format-final.txt`, `t28-lint-final.txt`, `t28-build-final.txt`. Current source state, not the superseded initial typecheck boundary, is the final review target.

Root owns full repository `pnpm verify` and independent QA snapshot execution. This report does not claim writer execution of that full gate, migration/security/eval suites or an independent review result.

## Browser evidence and precise limitations

Synthetic screenshots `t28-demo-mobile.png` and `t28-demo-zoom.png`; mobile image visually inspected by this writer, root also inspected both. Purchase values/privacy controls reflow in one column with text status and visible keyboard focus. Automated axe scan is not WCAG certification or screen-reader testing. No desktop screenshot/native browser zoom/real screen-reader run by this writer. CSS has no animation; reduced-motion emulation is recorded.

Network proof covers browser app requests during demo navigation and specified interactions. Production source has no provider/API/database/queue path; there is no real Worker/database instrumentation in this static increment. DEMO-02's real signed-in cache clearing, logout and two-user switch remain a mandatory future regression once auth/cache exists; sentinel storage is not a signed-in session. DEMO-04 cannot prove a real account export excludes demo entries because no authenticated export path exists. No private demo tenant/account was created.

At final refreeze, the shared public-config type is used for display-name input, while live controls remain disabled based on actual absence of implementation; no speculative capability service was added. `copy.ts` merges the canonical catalog with stable keys for existing preview/help/action/a11y labels, without new wording or features. Canonical messages remain authoritative. Source AST inspection returned no residual user-facing JSX text beyond punctuation (exit 0). Playwright tests/config are now included in typecheck. Independent QA was notified to snapshot final refreeze rather than earlier source.

No database/migration/retention/credential/permission changes, remote upload, external account, provider/model smoke, paid service, deployment or real receipt processing occurred. No first-result/import speed or market-fit result. Next real integrations remain dependency-ordered auth/mailbox/onboarding tasks; none are silently enabled by this static example.
