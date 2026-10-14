# Reference-design refinement: independent QA — 2026-10-11

Task: bounded T28 visual refinement to user-provided docs/design references, with public-config display-name alignment.
Status: approve scoped visual regression after writer fixes; no milestone/live-auth/release certification.
Independence: separate QA agent; frontend/orchestrator own all source/config/test fixes. QA edited only assigned evidence and own transient /tmp diagnostic.
Final identity: 70 source/config/specification files, manifest SHA256 `e3e8fabe6914f5258d2fca20f80a0f7ffc52a0a3c915d1a74276101be353ac4f`; exact hashes and zero post-verification source differences in `design-match-qa-snapshot-final.txt`.

## Isolation and inspected files

Approved isolated snapshot `/tmp/invoxim-design-qa-lRsWHbne/source`, copied frozen roots/apps/packages/tools/contracts/config/test fixtures, excluding installed dependencies, generated outputs, .git and credential files. This is an isolated filesystem snapshot, not a Git worktree/commit or sandbox enforcement certification. Node v24.21.0, pnpm 12.6.0. No T01 spike rerun.

Viewed all five supplied docs/design PNGs, writer draft desktop screenshot, final QA mobile/zoom screenshots. Source review covers web app/styles/icons/copy, unchanged browser tests/config and monetary fixture/adapter, Worker strict public-config response and exact response test. All business/kernel/contracts checks remain unchanged. References inform typography, white/blue surfaces, navy headings, inline tray/document mark and rail/card structure; sample connected-account/dashboard claims do not authorize those unimplemented features.

## Actual executed checks

Working directory: approved snapshot. `pnpm install --frozen-lockfile` exit 0, five workspace projects including root, 271 supply-chain policy entries, 186 packages. Explicit workspace ignoreScripts:true, no dependency build approval. Evidence `design-match-qa-install.txt`.

Exact verification command on each source revision:

`CI=true WRANGLER_LOG_PATH=/tmp/invoxim-design-qa-lRsWHbne/wrangler.log PLAYWRIGHT_BROWSERS_PATH=/tmp/invoxim-playwright-browsers TURBO_TELEMETRY_DISABLED=1 WRANGLER_SEND_METRICS=false pnpm verify`

| Revision | Actual exit | Evidence |
| --- | --- | --- |
| Initial frozen visual source | 1: footer contrast, 4/5 browser tests pass | design-match-qa-verify.txt |
| Writer footer-color correction | 1: CSS 200% zoom overflow, 4/5 browser tests pass | design-match-qa-verify-contrastfix.txt |
| Writer amount/header wrapping correction | 1: remaining CSS zoom min-content overflow, 4/5 browser tests pass | design-match-qa-verify-wrapfix.txt |
| Writer explicit grid/min-width/evidence-wrap correction | 0: 5/5 browser tests pass, axe zero violations and zoom reflow pass | design-match-qa-verify-final.txt |

Root gate includes package boundaries, format, lint, four package typechecks, seven tooling tests, 39 core tests, 39 contract tests, five actual workerd tests, builds and five Playwright tests (95 test cases represented). Initial run freshly executes all tests and 1500 property cases across three fixed-seed tests (20261011/12/13, 500 each); subsequent CSS-only reruns reuse unchanged core/contracts tests, typechecks and Worker build from that QA run via local Turbo cache. Each rerun actually executes seven root tooling tests, five workerd tests, five browser tests, changed web typecheck and Vite/Pages build; final is not falsely described as a second fresh execution of unchanged 78 domain/contract tests. Worker dry-run actually ran initially; no deployment.

Playwright uses one headless Chromium worker and local Vite at127.0.0.1:4175, isolated browser outputs. Parent preview4176 is separate. Final 5 browser tests pass in2.4s. Final browser screenshots copied to `design-match-qa-mobile.png` and `design-match-qa-zoom.png`; exact earlier failure screenshots/diagnostics preserved separately.

## Findings returned and independently rechecked

P2 contrast: `apps/web/src/styles.css` footer foreground #6b7da6 against white measured4.11:1 at11px, below4.5:1. Axe marks two footer paragraphs serious. Writer changes footer to existing muted palette #5b6b94. Test assertion remains zero violations. Subsequent actual axe scan passes.

P2 zoom/reflow: 360px viewport with document CSS zoom2 initially produces scrollWidth488 vs innerWidth360. Actual transient diagnostic identifies summary amounts extending right487.8 and purchase header/card beyond402px. Writer wraps monetary amounts/header; subsequent diagnostic improves to376px but still fails. Remaining implicit purchase-list grid minimum and evidence text expand card. Writer uses explicit minmax(0,1fr), min-width0 and evidence wrapping; final unchanged zoom assertion passes. No overflow hiding, data removal, assertion weakening or QA production edits.

Diagnostic command actually executed twice: `PLAYWRIGHT_BROWSERS_PATH=/tmp/invoxim-playwright-browsers node /tmp/invoxim-design-qa-lRsWHbne/reflow-probe.mjs`, exits0, prints observed layout measurements and captures synthetic screenshots. Outputs `design-match-qa-reflow-probe.txt` and `design-match-qa-reflow-afterwrap.txt`; images `design-match-qa-zoom-failure.png` and `design-match-qa-zoom-afterwrap.png`. Probe is transient QA script, not product/test-suite code.

No unresolved scoped QA defect observed in final source. Separate read-only principal review owns its decision; QA does not impersonate that review. Historical display-name RED/GREEN belongs to orchestrator; QA independently executes final exact unauthenticated public-config response test showing Invoxim.

## Acceptance, privacy and limits

PRESENT-02 and PRESENT-03: sign-in unavailable, capability guards unchanged; strict Pages-to-Worker public-config allowlist now uses Invoxim and no-store. DEMO-01/03/04: static example banner, local evidence/search/filter, disabled mutation controls, no tested-path /api or external host requests; exact paid150/refunded30/net120, headphones net90, unpaid80 excluded and distinct15 purchases retained. Production fixture parity remains tested.

Mobile:360x800 viewport, reduced-motion preference, keyboard search/Tab to filter and purchase summary/Enter history, visible focus, horizontal-overflow assertions, WCAG2A/AA/2.1AA/2.2AA axe scan zero violations. Zoom uses CSS document zoom2, not native browser zoom; content can wrap and remain in the document. Screenshot review confirms synthetic labels, money and unavailable-live actions. Native zoom, real screen-reader/account journeys and full desktop pixel equivalence are not certified.

DEMO-02 remains static local/session-storage sentinel independence only. No real signed-in records, logout/account-switch cache integration or live OAuth proof exists. No provider/model/mailbox calls, cloud provisioning/deploy, paid services, credentials or real financial data. No permission/retention/destination behavior change. Runtime results are local, not executed GitHub CI or public release. Broader release/security/evals remain unimplemented gates already recorded in prior task evidence.
