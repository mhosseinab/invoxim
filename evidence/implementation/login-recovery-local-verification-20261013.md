# Local login recovery verification

P2/P3 from the independent deployed login QA are repaired locally: anonymous private pages offer a fixed same-origin onboarding sign-in link only when validated capability permits it; unavailable capability remains explicit. Anonymous onboarding uses neutral signed-out copy. Aborted/stale capability responses cannot overwrite a refreshed private workspace. Existing authentication callback destinations are preserved.

RED: seven new browser behavioral cases failed as intended, exit 1, `/tmp/invoxim-login-recovery-red-v1.txt`. GREEN: full `public-login.spec.ts`, exit 0, 10 tests passed in 4.6 seconds, `/tmp/invoxim-login-recovery-green-v1.txt`. New delayed-response case also passed. Browser tests use synthetic intercepted APIs; they do not establish successful live authentication.

Whole `pnpm typecheck` passed five uncached tasks, exit 0, 10.291 seconds, `/tmp/invoxim-next-typecheck-v4.txt`. Focused Biome, ESLint, Prettier and diff checks passed. Independent read-only QA review is recorded separately in `login-recovery-review-20261013.md`.

P1 remains unresolved: deployed initiation fails before Google. The documented CUA surface does not expose request/response inspection. A shell request to public and login endpoints received edge 403 without application JSON; this does not identify the browser failure. Remote D1 schema inspection was not executed: Wrangler exited 1 because no CLOUDFLARE_API_TOKEN was available. No migration, secret change, account grant, deployment or production fix was performed. Owner deployment identity and migration status requested; successful account/MFA/callback/session/logout remains a separate manual and live QA checkpoint.
