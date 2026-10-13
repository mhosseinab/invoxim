# Independent signed-out onboarding visual review

Task: owner-reported signed-out onboarding presentation repair. Reviewer: separate read-only QA agent. Decision: approve the bounded source and visual repair; no blocking findings. This is not a new live identity/session or deployment certificate.

## Scope

Inspected the frozen diff in `apps/web/src/onboarding/page.tsx`, `copy.ts`, new `signin.css`, and `apps/web/tests/public-login.spec.ts`. Viewed the owner-provided `/tmp/codex-clipboard-eae300f6-1d4c-4ae4-b1f7-a69e65ece23f.png` and both fresh synthetic captures `/tmp/invoxim-signin-desktop.png` and `/tmp/invoxim-signin-mobile.png`. Compared against the five `docs/design` references already viewed in this independent review context and the presentation/onboarding contract.

Only this report was written. No production/test code, heavy browser/native process, build, provider permission or deployment was changed or executed by this reviewer.

## Assessment

The original screenshot treats a normal signed-out visit as a session failure and crowds sign-in, example and Retry into a flat row. The repair presents a focused centered card, descriptive heading, one full-width primary sign-in action and separate example action. It removes the normal signed-out alert and irrelevant Retry while retaining explicit recovery and alert semantics for actual load/start failures. No fictional completion state, fake setup progress, active-mailbox identity or unsupported capability is introduced.

The existing central `login.explanation` is visible and is associated with the primary button through `aria-describedby`: signing in creates the private workspace but does not connect an inbox. The follow-up text leaves mailbox choice and import approval after login. No mailbox, Drive, AI, company, card or bank step is added to sign-in. Google initiation code and destination validation are unchanged by the visual diff.

Login readiness still derives from validated public capability data and defaults false. When unavailable, no Google action is fabricated, the example remains usable and explicit Retry can reload capability state. Actual load failure still has an alert and a manual Retry; ordinary anonymous access is no longer announced as an error.

Desktop capture shows a balanced approximately 560px card, legible heading/body, clear primary/secondary hierarchy, permission panel and coherent space around the card. The 360px capture retains all essential content in normal document flow, readable wrapped text, large primary control, separate example control and visible keyboard focus. Navigation wraps cleanly. The cobalt/pale panels, quiet borders and BrandMark align with existing design direction without importing the design references' unsupported integration/security claims.

Authenticated behavior stays under its existing conditional branch. The new page-shell styles are gated by `.onboarding-app.onboarding-signin`; unique `signin-*` selectors affect only the new anonymous card. Authenticated workspace/review/progress markup and logic are not redesigned. Recorded regression checks cover both ordinary and adversarial authenticated flows; no source or screenshot evidence indicates authenticated style leakage.

## Actual evidence inspected

- `/tmp/invoxim-onboarding-signin-visual-red-v1.txt`: genuine RED, one failure and one pass in 6.8 seconds. Anonymous screen had one alert when zero was expected. This is a behavioral assertion failure, not a fixture/import failure.
- `/tmp/invoxim-onboarding-signin-visual-green-v1.txt`: lists 28 browser tests passing across the three scoped files in 12.5 seconds. Root reported terminal exit 0; this reviewer inspected the output rather than executing the suite.
- Fresh desktop and 360 × 800 mobile screenshots above were actually viewed. They are synthetic executor captures, not this reviewer's live browser execution.

The anonymous test asserts the exact identity/mailbox separation copy, no normal alert or Retry, enabled primary sign-in when configured, focus/Tab movement to the example, no horizontal overflow and zero Axe violations. The new load-failure regression checks explicit Retry causes a second profile read and does not expose a sign-in action without readiness. Other scoped tests exercise capability rejection, private-route keyboard recovery, obsolete capability delivery, review/consent conflicts, processor/identity changes, partial progress, optional AI boundaries and denied mailbox authorization.

Read-only source/diff/artifact commands and image viewing were performed by this reviewer. No invented test counts, provider completion, remote account identity or independent build result are claimed.

## Remaining gates and limits

Inspected `/tmp/invoxim-signin-web-build.txt`, which records successful browser build and Pages Function compilation; root reported process exit 0. Root separately reported scoped Biome/ESLint/Prettier, web typecheck and browser/Pages publication guard passing; their raw outputs were not inspected by this reviewer. Root owns any explicitly authorized deployment, and no remote deployment was performed as part of this review. Live Google callback/account/MFA/session/logout and public deployed layout are separate from these mocked browser regressions. Full keyboard journey, zoom/forced-colors/reduced-motion checks and loading/failure screenshot states are not established by the two screenshots. No new costs, scopes, credentials, data persistence, third-party tracking or private artifacts are introduced by the reviewed repair.
