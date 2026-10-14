# T17 local mailbox disconnect checkpoint

Parent implementation: provider-neutral owner management in the existing mailbox service lets authenticated users list/disconnect Gmail or Outlook connections even when provider OAuth is disabled. OAuth start/callback remain configured-provider operations. Scoped service callers retain their provider constraint. Recent/live session, active profile, tenant ownership, generation/credential CAS, idempotence, credential erasure and background pause remain enforced.

RED: `pnpm --filter @invoxim/worker exec vitest run test/outlook-disconnect.test.ts` exited 1, two tests failed with 503 instead of 204/409, `/tmp/t17-disconnect-red.log`.
Initial regression exposed an error-redaction wrapper lost during extraction; corrected without weakening its assertion. Initial typecheck exposed insufficient union narrowing; corrected with an explicit local/OAuth discriminator.

Final command: `WRANGLER_LOG_PATH=/tmp/t17-disconnect-wrangler.log pnpm --filter @invoxim/worker exec vitest run test/outlook-disconnect.test.ts test/mailbox.test.ts test/mailbox-adversarial.test.ts`, exit 0, 30 tests / three files, `/tmp/t17-disconnect-final.log`. Includes actual foreign-owned connection, wrong Origin, both-provider configuration, absent OAuth configuration, stale versions, old session and idempotent retry. Worker typecheck exit 0 `/tmp/t17-disconnect-types2.log`; scoped strict Biome and ESLint exit 0; Prettier wrote the three paths.

Independent read-only reviewer inspected this diff alongside runtime changes, found no authority gap, and requested actual cross-tenant witness, which is included. Reviewer executed no tests. Full integration verification is recorded separately. No cloud change or migration.
