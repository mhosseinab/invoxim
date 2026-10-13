# Independent deployed login browser QA

Task: owner-requested deployed login QA; related backlog T05 and T29. Reviewer: standalone QA subagent, independent of implementation. Status: request changes; live login blocked before Google authorization.

Target: `https://invoxim-web.pages.dev/`. Actual browser: dedicated new Codex IAB tab, background because visible tabs are unsupported in a subagent. Desktop and temporary 360 × 800 CSS-pixel viewport exercised; override reset. No local server, mocked identity, production edits, deployment, credentials, mailbox/Drive permission, import or inference were used.

## Findings

### P1 — Google login cannot start

Reproduction: open landing, wait for capability loading, choose **Sign in with Google**, then **Continue with Google** on `/onboarding`.

Observed: stays on `/onboarding`; displays alert **Sign-in could not be started. Try again when you are ready.** No Google page or account prompt appears. Reproduced with mouse click, keyboard Enter, double-click, after reload and browser Back. During initiation the button temporarily disables; it returns to enabled after failure. **Retry** reloads the signed-out view and returns the session-ended message; a subsequent login attempt fails again.

Expected: eligible deployed login initiates the Google identity flow, or readiness truthfully disables unavailable login with an actionable explanation. Root cause cannot be determined from UI evidence alone. Local implementation boundary inspected: `apps/web/src/onboarding/page.tsx:186` and error handling at line 207; this is a locator for investigation, not proof of deployed source identity.

Required regression evidence: live configured identity initiation reaches the official Google authorization/account screen, refusal returns safely, and approved account completion reaches the workspace without mailbox/Drive authorization. No full successful login was observed.

### P2 — Signed-out private routes provide no sign-in recovery action

Reproduction: from `/onboarding` use header **Home**, then workspace **Purchases** and **Connections**.

Observed on `/home`, `/purchases`, `/connections`: **Workspace unavailable** and **Your session has ended. Sign in again when login is available, or explore the example.** Only **Try an example** and private navigation are available; no sign-in action. Landing and onboarding advertise login availability.

Expected: a signed-out visitor receives a direct route to the available sign-in screen. User impact: navigating to private content leaves the user without a visible login recovery action. Local boundary inspected: `apps/web/src/private/page.tsx:536` and `apps/web/src/private/copy.ts:10`.

Required regression: unauthorized private route presents a keyboard-accessible sign-in action and preserves appropriate return destination; no private data is rendered.

### P3 — Fresh logged-out visit is described as an expired session

First visit to `/onboarding` says **Your session has ended. Sign in again to continue.** No app login had been completed in this QA tab. This message also returns after Retry and reload. Prefer neutral signed-out copy when there is no evidence of expiration. Local boundary: `apps/web/src/onboarding/page.tsx:88`, `apps/web/src/onboarding/copy.ts:7`.

## Actual executed scenario results

| Scenario | Result | Observed evidence |
|---|---|---|
| Landing login entry after capability hydration | Pass with transient caveat | Initial disabled beta CTA and unavailable message changed to enabled Google link without reload; initial state is not persistent login unavailability. |
| Google identity initiation | Fail | Safe login-start error, no external redirect. |
| Reload and explicit Retry | Fail to recover login | Signed-out screen restored; new initiation still fails. |
| Keyboard focus/activation | Pass for control accessibility; login fails | Tab from Privacy focuses Continue with Google, visible focus ring; Enter initiates same failing action. |
| In-flight duplicate activation | Bounded UI observation | Double-click observed temporary disabled button, then safe error; request counts/idempotency not inspected. |
| Error announcement | Pass | DOM snapshot exposes error as `alert`. |
| Mobile 360px login screen | Pass for core usability | Heading, error and sign-in button readable and visible; fallback link wraps across lines but remains available. |
| Browser Back | Pass for reconstruction | Returns to appropriate prior route and signed-out login screen; no blank or stale private content observed. |
| Anonymous Home/Purchases/Connections | Pass for visible absence of private data; recovery issue above | Workspace-unavailable UI; no financial records rendered. |
| Example fallback | Pass | `/demo` opens four labeled synthetic purchase records; no login required. |
| Google account choice, allowlist, callback, successful session, logout, wrong account, consent refusal | Not run | Initiation failed before provider UI. |
| Cookie flags, state replay, CSRF, two-tenant isolation, API/background status authorization | Not run by browser reviewer | No authenticated session; browser UI evidence does not establish these properties. |

## Acceptance scope

Read T05 AUTH-01 through AUTH-05 and ONBOARD-01 from `test-design/acceptance-cases.json`. AUTH-01 has only partial UI corroboration here: private routes showed no records; protected API/background-status checks were not executed by this reviewer. AUTH-02/03/04/05 and ONBOARD-01 remain unverified live. Read onboarding identity separation, recovery, keyboard/mobile requirements in docs/13. Login screen never requested company, card, bank or AI-key details, but this does not prove completed identity scopes.

## Execution and evidence limits

Actual checks were `mcp__cua_repl` browser interactions (`createBrowserTab`, AX/DOM snapshots, semantic clicks/keyboard presses, reload/back, screenshots and supported viewport override). No CLI test suite or `pnpm verify` was run; no invented test counts or exit codes. Repository instruction/context reads and source-location searches exited 0 except one combined read exiting 1 for a mistaken nonexistent repository Context7 skill path; the actual skill was then read from `/home/geek/.codex/skills/context7-verification/SKILL.md` successfully. Context7 metadata exposed no available tool; supplied browser API documentation governed browser operations. One read-only locator evaluation timed out after the initial CTA was replaced; no hidden runtime/network state was inspected.

Public screenshots were captured in browser tool results at keyboard-focus, loading, and mobile failure states; no private screenshots or raw HTML, OAuth URLs/query/state, cookies, tokens or personal identities were saved. This report is the only repository artifact written. No source/build identity assertion or security certification is made.

Security/privacy/cost: no private data observed or transmitted, no permission grants or paid service operations, and no mailbox scan initiated. Remaining manual checkpoint: after fixing initiation, an explicitly approved Google test identity must complete account/MFA and any required consent to verify the callback, authenticated workspace and logout. Browser QA should then recheck the live flow independently.

## Follow-up: response diagnosis capability

Orchestrator requested safe HTTP status, error code, and presence of a URL field for the actual browser POST `/api/auth/sign-in/social`. This could not be obtained through supported CUA APIs. `tab.capabilities.list()` advertised only `pageAssets` and `webmcp`; supplied `TabDevAPI` exposes console logs but no request/response inspection. Read-only DOM evaluation is not network inspection and was not used to access hidden state. The prior browser binding additionally reported unavailable after the completed QA turn. No further login retry, raw fetch, edge bypass, unsupported API, headers, cookies or OAuth state were attempted. HTTP status, backend error code and response URL-field presence remain **unknown**. An external shell edge response cannot establish the response to the actual browser login request.
