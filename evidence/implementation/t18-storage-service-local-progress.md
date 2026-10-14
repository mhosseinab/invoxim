# T18 storage service local progress

Status: implementation in progress, not a task/milestone or release certificate. Specialist agents stopped at the account usage limit; root inspected their actual saved code, took over the bounded writer files and executed the following checks. Independent QA authored adversarial tests before interruption; root executed them. No independent source review of this new service is claimed.

Separate storage authorization uses storage-purpose OAuth state, encrypted storage credentials and trusted live application sessions. The verified Drive account can differ from login/mailbox accounts. A callback does not enable archiving, read originals, enqueue jobs or upload files. Explicit reconnection requires the same provider subject; a duplicate grant without a selected connection cannot implicitly replace credentials. A consent-version fence prevents an older prompt from clearing newer consent to the same destination, without affecting another selected account.

Migration 0017 adds storage intents, refresh leases and explicit versioned archive settings. The consent repository checks current database session recency, tenant ownership, active profile, destination generation, stored credentials and drive.file permission inside its atomic CAS. OAuth grants remain separate from consent. Refresh use, archive plans, folder/upload workflow, backfill, API/UI composition and live validation remain unfinished.

Local connection metadata and unlinking are now separate from OAuth client/cipher construction. This is a deliberate deviation from the older mailbox configuration coupling: turning off an external provider must not prevent local disconnect. No remote grant revocation or user Drive-file deletion was added.

The lifecycle prepass drains the new leaf tables in bounded units. Connection erasure clears selected settings while retaining/incrementing their revision, preventing version-reset ABA; account erasure can remove those rows once the account is already suppressed. Integer legacy cleanup stages and existing authority guards remain unchanged.

## Executed evidence

- Contracts: valid-schema stub RED had 2 intended failures/1 negative control, then 3 GREEN tests.
- Initial root native run: 33 passed, 2 intended lifecycle failures; root then repaired the missing prepass. The extended seven-file run passed 75 tests.
- Local unlink: actual unavailable stub RED, 1 failed/2 explicitly filtered. First combined run passed 75 and failed one fixture assuming a single authorized account. The corrected fixture requires the added account and preservation of all prior accounts, matching the multiple-grant policy; failure log is retained.
- Final unfiltered seven-file native run: **76/76 passed**, exit 0, 20.67 seconds, no skips. Command: `WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/invoxim-drive-local-unlink-final.log pnpm --filter @invoxim/worker exec vitest run test/drive-service.test.ts test/drive-service-adversarial.test.ts test/drive-consent.test.ts test/drive-lifecycle.test.ts test/m1-lifecycle.test.ts test/lifecycle.test.ts test/lifecycle-adversarial.test.ts`. Raw `t18-root-local-unlink-final-20261013.txt`.
- Worker/core/contracts typechecks, scoped ESLint and formatting exited 0. Repository Biome exited 0, 325 checked files under the current ignore configuration (`t18-root-storage-biome-20261013.txt`). Root repaired import-order diagnostics without disabling rules.

The older 385-input/1361-test certificate remains historical for its frozen source; these new changes require fresh integration verification. No provider, paid service, deployment or remote resource was activated. Source tests contain synthetic data only.

Closeout: current contracts package passed all 48 tests (`t18-storage-contract-final-20261013.txt`); root secret-pattern scan exited 0 (`t18-storage-secrets-final-20261013.txt`). Current scoped source hashes are recorded in `t18-storage-local-source-20261013.txt`. No fresh whole-source verification or independent review is claimed for the new storage service.
