# T19 bounded full-period API checkpoint — 2026-10-13

The existing FX reporting API exposes explicit page subtotals. Added a separate POST /api/fx/reporting/period endpoint for bounded full-filter traversal: two joined256-event chunks per invocation, exact BigInt payment/refund/net reduction, scalar converted/pending/unconverted coverage and reason counts. Only terminal completion returns summaryScope=period. Large traversals return signed continuation state; they do not narrow the requested interval.

The service reuses purchase filters and the existing valuation decoder, including immutable rate/snapshot validation. First/final profile reporting_revision checks invalidate changed reports. Stamp and continuation purpose, tenant, session, canonical filters, profile/currency/timezone, policy, revision and expiry are bound. Root HMAC signer uses the existing auth secret with a separate signature domain, canonical base64url and exact two-segment verification. No revaluation/provider HTTP occurs during reads.

## Executed evidence

- Existing service RED/GREEN history: five full-period cases passed1.94s (/tmp/invoxim-fx-period-green-v2.txt); more than2200events, large exact totals, missing/pending coverage, same-timestamp earlier mutation, session/tamper and orphan cases. This was not route proof.
- Real Worker route RED: three failures because endpoint404instead200/denial (/tmp/invoxim-fx-period-route-red.txt),5.75s.
- Initial route/service/repository regression:47tests/fivefiles12.76s exit0 (/tmp/invoxim-fx-period-green-v3.txt). A type-only normalization fix omits undefined optional values instead of weakening exactOptionalPropertyTypes.
- Independent reviewer identified valid HMAC tokens with extra empty segments being accepted. Real signer RED /tmp/invoxim-fx-token-format-red.txt reproduced it. Exact parts.length=2 repair; pure signer GREEN /tmp/invoxim-fx-token-format-green.txt accepts canonical token and refuses trailing dot/double-dot junk.
- Final native post-repair47tests/fivefiles12.81s exit0 (/tmp/invoxim-fx-period-final.txt). Route tests exercise trusted signed sessions, invalid client authority/origin, missing session, foreign stamp, canonical token refusal and profile-revision change, using shared40-statement instrumentation.
- Root scoped12-path Biome/Prettier/ESLint exit0. Workspace typecheck passed before the token-format-only repair and again during subsequent file-based AI composition (/tmp/invoxim-ai-file-types.txt).
- Independent read-only review deployed_login_browser_qa approved bounded service then signing/contracts/route source and verified the token repair; final native artifact supplied afterward. Reviewer ran no tests and edited no code.

## Still required for full T19

Native period coverage needs actual quote/refund/per-event rounding and corrupt-snapshot/in-request mutation/expiry/policy cases beyond the existing repository/service regression. List and lifecycle export still need the same report stamp, per-event reporting provenance and full-period summary equality; frontend continuations and preference-driven queued revaluation are incomplete. This checkpoint does not claim full T19, live reference quality, export completeness or production activation. FX stays disabled, and this source increment is excluded from the isolated AI deployment. No schema reset/provider credentials/new processor was introduced.
