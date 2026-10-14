# Outlook onboarding UI checkpoint — October 14, 2026

Parent owns onboarding page/copy/API helpers and the new onboarding-outlook browser suite; the fresh implementation subagent owns backend composition. No backend code is included in this UI checkpoint.

Existing server DTOs already allow Gmail and Outlook. The UI now shows only listed providers, sends a provider-specific authorization request, and retains the selected connection's actual provider on reconnect. An available Gmail provider cannot enable an unavailable Outlook reconnect. Existing before/after actor checks remain; connecting alone does not Start import. Google app login remains Google-only and independent from mailbox choice.

Microsoft mailbox redirects require HTTPS login.microsoftonline.com, no credentials or unexpected port, and a v2 authorize path for the configured authority forms. Cross-provider, lookalike-host and wrong-path responses fail locally. Generic read-only permission copy applies to both providers. A mailbox missing_permission/denied refusal now keeps the signed-in workspace and displays a permission-specific message rather than treating every403 as a login identity failure. Other identity failures still discard the old action and reload trusted actor state.

## Evidence

- Initial RED: 3 browser failures, exit1, /tmp/invoxim-outlook-ui-red.log. No Outlook connect choice; reconnect selected Gmail/rejected the Microsoft redirect; Gmail availability incorrectly offered disabled Outlook reconnect.
- Initial GREEN: 3 passed, exit0, /tmp/invoxim-outlook-ui-green.log.
- Expanded run: 34 passed/2failed, /tmp/invoxim-outlook-ui-regression.log. Exposed the403 permission-refusal UX bug; changed-account test initially assumed sign-out rather than loading the new account. The subsequent fixture revision also needed both new account ID and email updated, not an impossible mixed identity; intermediate /tmp/invoxim-outlook-ui-regression-v2.log is not a passing claim.
- Final `pnpm --filter @invoxim/web exec playwright test --config playwright.config.ts onboarding-outlook.spec.ts onboarding-ui.spec.ts onboarding-adversarial.spec.ts`: exit0, 36 tests passed in16.0s, /tmp/invoxim-outlook-ui-final.log. Ten new Outlook cases cover connect/reconnect, disabled provider, redirect attacks, permission refusal, changed actor with no authorization POST and360px actual Tab navigation/reflow. Requests and Microsoft navigation are intercepted with synthetic responses; no live OAuth or provider call occurred.
- Scoped Biome, ESLint and Prettier checks pass. Web typecheck also passed, exit0. Full repository verification and backend/processor readiness remain integration gates.

Context7 tools were unavailable. Current official sources checked for exact APIs: [Microsoft authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) confirms tenant-authority v2 authorization endpoint forms; [Playwright network interception](https://playwright.dev/docs/network) documents fulfill/abort without real network traffic. No new dependency or credential was introduced.
