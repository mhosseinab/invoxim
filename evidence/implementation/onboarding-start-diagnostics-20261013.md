# Onboarding Start failure diagnostics — 2026-10-13

The owner reported `POST /api/onboarding/start-import` returning 503 `processing_unavailable`. This report records diagnostics, not a root-cause fix.

Production inspection with explicit API Wrangler config confirmed version `85d1c6c1-1c98-4492-b36f-e3c41c246e51` at 100%, required JOBS binding and enabled extraction/discovery/job gates. A prior implicit Wrangler command selected the Pages project; its version is not evidence of API rollback. Read-only D1 metadata confirmed required Start tables, a connected mailbox awaiting import, and zero committed import/command records. No credential values or receipt contents were read.

Patch `fb0c950` adds a Start warning correlated to the returned request ID, allowlisted domain error codes, fixed Gmail preparation stages and provider HTTP status. No raw exceptions, provider bodies, headers, tokens, mailbox identifiers or receipt contents are logged. Existing authorization, statuses and consent checks remain intact.

Executed evidence:

- Route RED: `pnpm --filter @invoxim/worker exec vitest run test/onboarding-diagnostics.test.ts`: exit 1, five failed/one passed; missing diagnostic warnings were the intended failures. `/tmp/invoxim-start-route-diagnostics-red.txt`.
- Gmail HTTP diagnostic RED: matching single-file command: exit 1, one failed, missing warning. `/tmp/invoxim-start-gmail-diagnostics-red.txt`.
- Combined GREEN: `pnpm --filter @invoxim/worker exec vitest run test/onboarding-diagnostics.test.ts test/gmail-request-diagnostics.test.ts test/onboarding.test.ts test/gmail-stream-bounds.test.ts`: exit 0, 24 tests/four files, 12.03 seconds. `/tmp/invoxim-start-diagnostics-green.txt`.
- Typecheck: exit 0, all five tasks; four cached. `/tmp/invoxim-start-diagnostics-types-green.txt`. An initial new-fixture TenantContext type error was repaired before deployment.
- Scoped Prettier/Biome/ESLint: exit 0 after formatting corrections. Independent read-only review by `outlook_runtime_map`: no blocking security/behavior finding.
- Isolated Worker build at committed source: exit 0. `/tmp/invoxim-start-diagnostics-build.txt`.
- API Worker deployment: exit 0, `7e0ebb51-a946-4c2d-b064-2793a39cbb3d`, minute cron and existing queue producer/consumer confirmed. `/tmp/invoxim-start-diagnostics-deploy.txt`.

Full `pnpm verify` was not repeated for this diagnostic-only patch; previous isolated `0418f5f` verification passed. Live failure diagnosis is pending another owner-authorized Start attempt. No successful live import is claimed.

Separate source finding: refreshing an expired Gmail token during Start increments its credential version after the signed review/prepare snapshot, causing the final strict CAS to reject with 409. A bounded repair is in progress; this does not yet establish the reported 503's cause.
