# Compact import review completion

Task UX-REVIEW-01. Status: done, not deployed. Implementation `6313933`, plan `93839d6`. Frontend implementer `/root/compact_import_review`; independent read-only reviewer `/root/langchain_review`; parent integration.

The default review now shows compact verified mailbox/calendar-range, timezone/currency, named processing/model/classifier and local conversion, funding, remaining document allowance/reset, originals location and hourly-check authorization. Long policies open in a named native desktop modal/mobile bottom sheet. Policies precede allowances, with exact frozen boundaries, raw provider/parser configuration and unit quotas in final collapsed Technical details. Preferences and optional BYOK remain discoverable. No extra library, API/schema/provider or background behavior change.

User explicitly requested on-demand explanations; that overrides expanded prose in docs13. Named material destinations and clear consent stay visible. Original unchecked consent, actor verification, stale/dirty/busy guards, token payload, duplicate/unknown Start handling and idempotency-key reuse remain intact. Native close/keyboard Escape, initial/contained/returned focus, internal mobile scrolling and sticky close control are exercised. No live inbox/provider actions were performed for UI verification.

## Evidence

- RED: focused compact-review browser case failed because Start was below the desktop viewport, exit 1. `compact-review-red-20261014.log`.
- GREEN: `pnpm --filter @invoxim/web exec playwright test`, final frozen five-path revision: 89 passed in 41.7 seconds, exit 0. `compact-review-all-browser-final-20261014.log`. An earlier post-reorder run had 88 pass/1 ambiguous synthetic policy-text locator; classifier fixture policy text was made distinct, preserving both notices, before the final green run.
- Desktop 1280×900 full inference/classifier/conversion fixture: Start bottom 885.8 px, fully visible; disabled until unchecked consent deliberately selected. Mobile 360×800: no horizontal overflow, sheet scrollable, close remains visible after scrolling. Axe, keyboard, focus return, identity/stale/adverse and other existing browser coverage passed. Synthetic previews: `compact-review-desktop-authorized-20261014.png`, `compact-review-mobile-details-20261014.png`.
- Scoped Prettier/Biome/ESLint/web types exit 0; `/tmp/ux-review-{prettier,biome,eslint,type}-final.log`.
- Parent clean archive of `6313933`, `/tmp/invoxim-mail-perf-clean`: `pnpm check:boundaries && pnpm check:secrets && pnpm check:dependency-policy && pnpm format:check && pnpm lint:biome && pnpm lint && pnpm typecheck && pnpm build`, exit 0 (execution session 91418). Scanner: 753 files, no findings; root styles/types/builds and production test/debug publication guard passed. Existing unchanged Turbo package checks may replay cached successful outputs. Owner working changes excluded/preserved. Backend integration/full `pnpm verify` not rerun for this UI-only patch.
- Independent reviewer approved frozen code and final 89-test log, with no unresolved findings. Reviewer made no edits/test runs; root gates were parent-executed and reported explicitly.

Native dialog behavior was verified against MDN and real Chromium tests: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog. Context7 unavailable. No deployment, migration, new dependency or production consent change. Production still serves the prior UI until a separately authorized Pages deployment.
