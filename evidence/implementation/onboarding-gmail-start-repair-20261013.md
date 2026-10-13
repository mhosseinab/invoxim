# Gmail Start error classification and refreshed credential fence

## Observed failure

Production API version `7e0ebb51-a946-4c2d-b064-2793a39cbb3d` captured the owner's retry. Gmail's metadata-only profile/history-anchor request returned HTTP 403. The same trace correlated Start's `processing_unavailable` to that provider rejection. No import or command committed. Queue flags, AI configuration and existing Start tables were present. The exact Google reason was not available in that initial trace; do not assert API-disabled versus scope/quota solely from HTTP 403.

## Repair

- Bound transient 403 error metadata to 8 KiB, 64 chunks and the existing request abort deadline. Only fixed, allowlisted reason codes leave the provider boundary; no response messages, identifiers, URLs, credentials or contents are logged or persisted.
- Disabled API reasons map to a specific non-retryable `mailbox_api_disabled` error and static operator-action UI copy. Insufficient scopes map to the existing reconnect path. Known quota reasons retain the existing `Retry-After` floor. Unknown reasons remain unavailable.
- A real Gmail factory `openForStart` pins the reviewed connection generation, raw scopes, provider and credential version. Its own serialized refresh supplies the exact server-side version used for the history anchor. The unchanged atomic commit CAS rejects unrelated replacements. Active-owner checks cover both metadata pins.
- No migration, permission widening, new provider destination, silent fallback, mailbox scan or model invocation was added.

## Executed verification

Source checkpoints: `e20a670`, strict core contract assertion repair `6eebd6c`.

- Refresh behavioral RED: one native test failed with the refresh-induced `CONFLICT`, 3.72 seconds, exit 1; `/tmp/invoxim-start-refresh-red.txt`.
- Forbidden classification RED: six failures, 1.66 seconds, exit 1; `/tmp/invoxim-start-forbidden-red.txt`.
- API mapping RED: one failed/six passed, 6.18 seconds, exit 1; `/tmp/invoxim-start-api-disabled-red.txt`.
- Browser copy RED: one failed; `/tmp/invoxim-start-api-disabled-browser-red.txt`.
- Retry-floor RED: one failed/six passed, 1.65 seconds, exit 1; `/tmp/invoxim-start-forbidden-retry-red.txt`.
- Profile-pin RED: expected two OAuth/user-info calls but observed an unwanted third anchor call, 3.69 seconds, exit 1. The later wrapper repair preserves native batch statement identity; `/tmp/invoxim-start-profile-pin-red.txt`.
- Broad relevant native regression: 51 tests/seven files, 18.57 seconds, exit 0; `/tmp/invoxim-start-refresh-forbidden-regression.txt`.
- Additional route/mailbox/discovery regression: 49 tests/three files, 13.56 seconds, exit 0; `/tmp/invoxim-start-api-disabled-native-green.txt`.
- Final native repair set: 18 tests/three files, 10.56 seconds, exit 0; `/tmp/invoxim-start-final-native.txt`. Includes signed-session real HTTP Start with encrypted expired credentials and native D1, a single outer 40-statement execution guard covering authentication/refresh/commit, status 200 and one import. Concurrent credential replacement and profile deletion both prevent authorization/import; no Gmail anchor runs after the tested deletion race.
- Retry/stream regression: 15 tests/two files, 2.49 seconds, exit 0; `/tmp/invoxim-start-forbidden-retry-green.txt`.
- Browser GREEN: one new disabled-API case, 1.3 seconds, exit 0; `/tmp/invoxim-start-api-disabled-browser-green.txt`.
- Typechecks: all five tasks, three cached, 7.912 seconds, exit 0; `/tmp/invoxim-start-fix-types-final.txt`. Scoped Prettier/Biome/ESLint passed.
- Initial full isolated verification caught two old core exact-argument expectations lacking the newly required credential version/scopes. Updated the exact expected object without weakening assertions; seven focused core tests passed, 282 ms, exit 0; `/tmp/invoxim-start-core-contract-green.txt`.
- Independent read-only review by `outlook_runtime_map` found active-profile and provider-retry-floor issues, re-reviewed both repairs and inspected authenticated HTTP budget evidence. No remaining blocking finding in this scope.

Full isolated `pnpm verify` at `6eebd6c` passed, exit 0: 1,368 native tests/109 files (239.74 seconds), 84 browser tests (38.0 seconds), 379 core and 48 contract tests, tooling/static/type/build/publication gates. `/tmp/invoxim-start-fix-isolated-verify-final.txt`. API Worker `963f4705-029b-4014-8360-1f5c2eafe323` was deployed successfully and independently queried at 100%; existing queue producer/consumer and minute cron remain attached. Pages deployment `f5566f14` succeeded. `/tmp/invoxim-start-fix-worker-deploy.txt`, `/tmp/invoxim-start-fix-pages-deploy.txt`, `/tmp/invoxim-start-fix-active.json`. Anonymous browser smoke returned public-config 200 and protected me/settings/disclosure 401, as expected; it does not exercise the owner’s signed session. A live retry to establish the precise Google configuration issue remains pending. Synthetic provider tests do not prove live OAuth, import coverage or model quality. The pending Drive-only `0007_archive_document_order.sql` is unrelated and was not applied.
