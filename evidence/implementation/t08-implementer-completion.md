# T08 implementation handoff

Task: T08, M0 independent Gmail consent adapter. Status: source frozen for independent review and final clean integration verification. This report does not mark M0 complete. No commit/deployment was created by this implementer.

Implemented: fixed Google consent URL/PKCE/nonce, read-only Gmail plus identity scopes, separate mailbox and login credentials, signed OIDC identity bound to bearer userinfo identity, session-bound one-use encrypted state, recent-auth mutation checks, tenant ownership, atomic mailbox limit, encrypted refresh credentials, optimistic reconnect and local disconnect, bounded active-first metadata list with hasMore, lease-before-HTTP refresh and fenced credential/error publication. Callback only authorizes an awaiting_import connection and redirects to fixed /onboarding/review with a safe outcome. No discovery, body/attachment fetch, parser/model, new processing consent, import run or processing job is created.

Changed paths: packages/core/src/mailbox/{types,authorization}.ts; packages/adapters/src/mailbox/{configuration,gmail,service}.ts; packages/adapters/migrations/0007_mailbox.sql; apps/worker/src/mailbox-routes.ts; apps/worker/test/mailbox.test.ts; evidence/implementation/t08-implementer\*. Shared schemas, exports, composition, bindings and OpenAPI belong to the orchestrator.

Acceptance coverage: AUTH-02 and GMAIL-04 independent identities/reconnect/token lifecycle, SECRETS-04 encrypted storage/CAS/serialized refresh, ONBOARD-02 callback gate, ONBOARD-15 missing scopes. GMAIL-06 discovery/source deduplication remains T09; connection identity uniqueness prevents duplicate attachment only. Browser first-use/full-import evidence remains T29/T09. Local disconnect retains connection/source/financial rows and does not implement full T15 deletion/provider revocation.

## Actual evidence

- RED: `WRANGLER_LOG_PATH=/tmp/invoxim-t08-wrangler-logs WRANGLER_SEND_METRICS=false pnpm --filter @invoxim/worker exec vitest run test/mailbox.test.ts` initially exit1, two meaningful unauthenticated requests returned200 instead of401. t08-implementer-red.txt.
- GREEN same command: exit0,5 tests in workerd; t08-implementer-green.txt. Own positive tests use a neutral synthetic authorization port and actual verified library-signed D1 session; they do not claim completed Google login/OIDC exchange. The earlier diagnostic had fixture/table/cap setup failures, preserved in t08-implementer-diagnostic\*.txt and corrected without treating those as behavior RED.
- Independent QA: runtime_qa executed actual signed synthetic RS256 callbacks/intercepted fixed Google control-plane HTTP plus real D1. Latest combined suite exit0,38 cases (22 mailbox adversarial plus16 job cases) in t07-t08-qa-diagnostic-6.txt. Required reproduced regressions include disconnected reactivation limit (t08-qa-cap-red.txt), SQL paired-field NULL bypass/raw driver error leakage (t08-qa-constraint-redaction-red.txt), and disconnect before provider refresh (t08-qa-pre-provider-disconnect-red.txt). All22 mailbox cases passed after fixes. QA owns its fixtures and evidence.
- `pnpm --filter @invoxim/adapters typecheck`: exit0, t08-implementer-types.txt.
- `pnpm --filter @invoxim/worker typecheck`: exit0 after QA narrowed its optional-string fixture, t08-implementer-worker-types.txt. Earlier unrelated in-progress fixture/type failures were reported to their owners, not waived.
- `pnpm exec eslint packages/core/src/mailbox packages/adapters/src/mailbox apps/worker/src/mailbox-routes.ts apps/worker/test/mailbox.test.ts`: exit0, t08-implementer-lint.txt.
- `pnpm exec prettier --check packages/core/src/mailbox packages/adapters/src/mailbox apps/worker/src/mailbox-routes.ts apps/worker/test/mailbox.test.ts evidence/implementation/t08-implementer-provider-notes.md`: exit0, t08-implementer-format.txt.
- `pnpm check:boundaries`: exit0, t08-implementer-boundaries.txt.
- `WRANGLER_LOG_PATH=/tmp/invoxim-t08-wrangler-logs WRANGLER_SEND_METRICS=false pnpm --filter @invoxim/worker build`: exit0, actual Wrangler dry-run only, t08-implementer-build.txt.
- Final clean frozen install/full pnpm verify and independent reviewer report: orchestrator/QA pending at this handoff; this report does not invent their result.

## Effects and limits

Migration0007 adds tenant-scoped callback intents and refresh leases with ownership FKs, explicit nullable-field pairing and monotonic refresh fences. Existing vault cipher and state store remain unchanged. Provider endpoints are fixed; refresh/authorization grants and PKCE remain transient in memory until encrypted persistence. No raw mail content, token, provider description or driver error is intentionally logged or projected.

The operator must separately provide validated Gmail/client/keyring secrets and fixed HTTPS auth origin. GMAIL_ENABLED is false by default and public capabilities stay disabled until reviewed operator readiness. Gmail readonly is technically mailbox-wide read permission, not receipt-only access. No additional dependency, paid infrastructure or live provider request was introduced.

Existing reconnect retains consent/frozen import records, defaulting scheduling to paused unless a future explicitly injected current-consent validator permits resume; active resume also requires a current unrevoked background consent in the atomic write. New connections always await import. Known-invalid refresh credentials cannot be retained on reconnect. Transient failures preserve credentials; stale failures cannot pause newer credentials. Refresh transport timeouts are below the60s lease, and the pre-HTTP checkpoint requires45s remaining plus current connected generation/version and active owner. Details and official-source verification are in t08-implementer-provider-notes.md.

No real Google login/consent/refresh, restricted-scope approval, deployment, browser account review, first-result timing or whole-import completion was executed. These remain explicit separate gates. Final independent review determines task acceptance.
