# Independent local login recovery review

Task: bounded fixes for deployed browser QA P2/P3; related T05/T29. Reviewer: separate standalone QA agent. Decision: approve this local patch's recovery and copy behavior, subject to remaining repository checks owned by the orchestrator. This is not deployed login approval.

## Reviewed identity and scope

Inspected the current uncommitted Git diff for these exact files:

- `apps/web/src/onboarding/page.tsx`
- `apps/web/src/onboarding/copy.ts`
- `apps/web/src/private/page.tsx`
- `apps/web/src/private/copy.ts`
- `apps/web/tests/public-login.spec.ts`

No production files were edited by this reviewer. The only new artifact is this report. The deployed site was not rerun because its deployment is unchanged.

## Findings and reasoning

No blocking findings in this bounded diff.

Private recovery checks public capability data through the existing `publicConfigSchema`, begins with `loginReady=false`, and only offers sign-in following 401/403 when validated `loginEnabled` is true. Missing, unavailable, invalid or false capability data cannot enable the action. The fixed `/onboarding` anchor is semantic and introduces no arbitrary return destination or unsafe URL parameter. Demo fallback remains available.

The new asynchronous private capability branch commits an error state only while the effect is active and its request is not aborted. Cleanup marks it inactive and aborts; the delayed-capability regression verifies that an obsolete anonymous result cannot replace a refreshed authenticated workspace. The additional revision comparison is not the sole protection; active/abort guards provide the meaningful stale-effect guard.

Onboarding clears previous `loginReady` at each load and retains existing request-abort guards on successful capability updates. Anonymous copy no longer assumes a prior authenticated session. The neutral message matches both new and expired signed-out states without inventing identity or session history.

Tests exercise anonymous Home/Purchases/Connections recovery, keyboard Enter activation of the recovery anchor, neutral onboarding copy after Retry, invalid/disabled/unavailable public capabilities, and delayed private capability completion. Keyboard tests explicitly focus the anchor and activate it; they do not establish a full Tab-order/contrast audit. Mocked responses prove local rendering behavior, not live identity authorization or backend isolation.

## Execution and evidence inspected

This reviewer executed only read-only `git diff`, scoped source-location searches, and artifact reads through `exec_command`; observed exit codes were 0. No browser/native/heavy test process or test suite was launched by this reviewer.

Inspected orchestrator-broker evidence:

- `/tmp/invoxim-login-recovery-green-v1.txt`: output lists all 10 `public-login.spec.ts` tests passing, 4.6 seconds. Orchestrator reported terminal exit 0; artifact does not independently encode an exit status.
- `/tmp/invoxim-next-typecheck-v4.txt`: output reports 5 successful tasks, 0 cached, 10.291 seconds. Orchestrator reported terminal exit 0.

No RED artifact or full final lint/format/build/regression gate was inspected in this bounded review. These must be reported by their actual executor. No authored fixture was mistaken for live provider proof.

## Remaining gates and effects

Original deployed P1 is unresolved: **Continue with Google** failed before the provider screen. Successful live identity authorization, callback, allowlist handling, secure session lifecycle and logout remain unverified. P2/P3 are approved in source only; this report does not claim they are deployed or verified against the unchanged public site.

No financial arithmetic, mailbox/Drive grants, import consent, inference, storage destination or production configuration changed in the reviewed diff. No new credentials, costs or private data were introduced. Recovery is a fixed same-origin navigation and continues to depend on server authorization; UI readiness is not permission to access private records.
