# Loaded processing disclosure with import disabled

The owner's screenshot shows processor notices and allowance successfully loaded while Start remains disabled. A read-only Wrangler version query for deployed Worker `f16337fc-4321-4f39-b0cd-6a36907a5080` confirmed `EXTRACTION_ENABLED=false`, `GMAIL_DISCOVERY_ENABLED=false`, `JOBS_ENABLED=false`, and no `JOBS` Queue binding. No secret values were read or copied into evidence. The AI-only deployment did not activate the background import runtime.

Onboarding readiness requires approved inference, mailbox configuration, extraction/discovery enabled and a configured 40-statement job policy with Queue binding. Loading processor notices or allowance does not satisfy those separate runtime gates. Consent cannot bypass server readiness.

The frontend previously reused the failed-disclosure-read message for a successful disclosure with `availability=configuration`. That incorrectly claimed displayed details were unavailable. The resolved configuration state now explains that import is not enabled on the service; failed/invalid reads retain their existing retry behavior. All consent/Start guards are unchanged.

## Verification

- Genuine browser RED: `/tmp/invoxim-onboarding-service-copy-red.txt`, exit 1, one case failed because the corrected warning was absent after processor details became visible.
- Browser GREEN: `pnpm --filter @invoxim/web exec playwright test --config playwright.config.ts tests/onboarding-ui.spec.ts --grep 'resolved processing disclosure explains service configuration|unavailable or invalid processing envelope'`, `/tmp/invoxim-onboarding-service-copy-green.txt`, exit 0, 4 passed in 2.4 seconds. Assertions preserve visible details, disabled Start/consent and no Start request; three failed/invalid envelope cases retain manual retry.
- Scoped Prettier, Biome, ESLint and diff checks passed. `pnpm typecheck`, `/tmp/invoxim-m1-start-cohort-types-v2.txt`, exit 0, all 5 tasks successful in 8.513 seconds, 2 cached.

The copy repair is local. No deployment, Queue provisioning, background activation, content read or live inference was performed. Background configuration, reviewed runtime release and authenticated synthetic/provider smoke remain separate deployment work; do not enable processing solely from this UI check.
