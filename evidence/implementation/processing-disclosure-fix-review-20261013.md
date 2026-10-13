# Independent processing disclosure failure review

Task: owner-reported processing disclosure failure while processing services are disabled/unconfigured. Reviewer: separate read-only QA agent. Final bounded decision: approve the mechanism and narrowed explanatory copy. No provider activation, permission expansion or live processing approval.

## Scope

Inspected diffs in Worker onboarding routes, adapter onboarding read/error class and barrel, web private API failure parsing, onboarding review/copy, native `processing-disclosure-readiness.test.ts` and browser onboarding UI regressions. No user attachment containing real authentication cookies was read. Sanitized HTTP status/code and synthetic evidence were sufficient.

Only this report was written. No production/test edits, heavy test/build/browser/native process, deployment, provider configuration, inference or child agent was performed by this reviewer. A separately requested provider configuration task is outside this review.

## Mechanism assessment

No blocking authorization/configuration-classification findings in the bounded source diff. Missing selected AI configuration raises a specific `ProcessingNotConfiguredError`, derived from the existing domain error. Only this typed error maps disclosure to 503 `processing_not_configured`, `retryable:false`; generic unavailable errors keep `processing_unavailable`, `retryable:true`. The classification occurs after existing session/query/owned-mailbox validation rather than being inferred solely from global disabled flags. The capacity regression specifically prevents misclassifying a different repository failure merely because AI is absent.

Verified tenant context continues to come from the trusted session; origin checks, strict duplicate/unknown query rejection, repository tenant scoping and the shared 40-statement budget remain unchanged. Native synthetic tests reject unauthenticated, unowned and foreign-mailbox requests before exposing the configuration diagnostic. No URL, model endpoint, selected destination, provider grant or key is accepted through this error path; no fallback, new job, import consent or import run is created.

Frontend failure parsing accepts only HTTP 503 with either the exact missing-configuration/non-retryable pair or runtime-unavailable/retryable pair. It never copies provider/error messages into UI. Unknown codes, malformed pairs, missing booleans and generic failures retain the existing generic manual-retry behavior. The review removes Refresh review only for the verified non-retryable configuration state, clears disclosure/authorization attempt, hides Start import and retains access to existing records. Runtime/malformed envelopes retain explicit manual Refresh review rather than an automatic loop.

Existing request abort cleanup, actor-scoped loader and trusted returned identity/connection checks remain in place. No consent or destination is fabricated, no stale start body is automatically submitted, and no CSP or processing-enabled flag changes are included.

## Copy limitation at initial review

The current initial message says the inbox is connected but **nothing has been read**. The failure establishes that this review cannot obtain an approved disclosure/start; it cannot establish all historical mailbox activity. The orchestrator already scoped a truthful correction to state that this review has not started a new import. Approval of final copy is pending that actual source/test update and rerun; no extra subsystem or operator configuration is needed to repair wording.

## Actual evidence inspected

- `/tmp/invoxim-processing-readiness-red-v1.txt`: one intended classification failure, four passing tests; expected non-retryable missing configuration, received retryable generic unavailable.
- `/tmp/invoxim-processing-capacity-red-v1.txt`: one intended capacity-classification failure, five passing tests; expected retryable runtime unavailable, received non-retryable configuration error.
- `/tmp/invoxim-processing-ux-red-v1.txt`: one intended new explanatory-state failure, three passing tests; generic disclosure error remained instead of the targeted message.
- `/tmp/invoxim-processing-readiness-green-v1.txt`: 37 native tests passing across 4 files, 17.99 seconds, including the six readiness cases and related onboarding regressions.
- `/tmp/invoxim-processing-ux-green-v1.txt`: 40 browser tests passing, 18.1 seconds, covering processing failure states and surrounding onboarding/private/login regressions.

The reviewer inspected these raw outputs rather than executing suites. Actual read-only source/diff/artifact commands exited successfully except an optional no-match search; test process exit codes remain executor-owned. Browser fixtures are synthetic mocks; native tests use synthetic auth sessions and bound D1. Neither proves real provider use or deployed flow completion.

Root reports authoritative deployment metadata currently has AI/extraction/discovery/jobs disabled and no active AI/queue bindings. That configuration evidence was supplied by the executor; this reviewer did not independently fetch deployment settings. The reviewed fix diagnoses and explains the state; it does not enable services.

## Remaining gates

The final truthful-copy delta and targeted rerun are inspected below; bounded final approval is recorded. Root owns typecheck/lint/build/publication and any separately authorized deployment gates; they were not inspected in this review yet. Live callback/session/provider processing remains a separate gate. No credentials/private receipt data/raw provider error details or real cookie are stored in this report; no additional service cost, scope or permission is introduced.

## Final copy re-review

Re-read the final source and test expectation: **Import is not available yet because receipt processing has not been configured. Your inbox is connected; this review has not started a new import.** This accurately limits the statement to the current review rather than asserting a history of no mailbox reads. No new start/provider operation is introduced.

Inspected `/tmp/invoxim-processing-ux-trace-v1.txt`: the targeted missing-processing browser regression passed three repetitions, 2.6 seconds. Root reported terminal exit 0; this reviewer inspected raw output rather than executing it. An earlier targeted four-case rerun had a second-read timing failure during concurrent watched edits; a suggested HMR cause remains unproven and this review does not claim that broader flakiness was resolved. The previously inspected full 40-test GREEN establishes its recorded source state; root owns the fresh fully frozen pre-deployment regression/build gate.

Bounded source/copy approval stands. User deployment authorization is executor-owned; this reviewer performed no deployment or runtime inference and does not certify later live behavior.
