# Consolidated D1 baseline transition

Operating procedure required before deploying to an existing D1 database. Restored from the former evidence record `baseline-transition-checklist.md`, which was removed from git with the other evidence records in fe99887; the original is in the commit history before that commit.

Persistence retains native D1 and the established Drizzle authentication adapter. The single active `packages/adapters/migrations/0001_initial.sql` initializes an empty database with the application tables, constraints, indexes and required scheduler seeds. Historical migrations remain byte-preserved compatibility fixtures.

Before a separately authorized deployment to an existing database:

1. Preserve an approved backup, migration ledger, historical hashes and the independent deletion journal. Do not restore erased tenants into a serving database.
2. Inventory its actual historical migration level. Compare all table definitions, columns/defaults/nullability, tenant/composite foreign keys, CHECKs, unique/partial/ordinary indexes and required scheduler cursor seeds against the tested baseline. Check foreign-key violations, exact money and integer authentication milliseconds.
3. Halt on any difference. Prepare a separately reviewed forward migration; do not replay the initial baseline, reset, drop or truncate data. Matching names or `IF NOT EXISTS` do not establish equivalence.
4. Reproduce the exact existing level with synthetic local fixtures and exercise populated retention, atomicity, tenant fences, consent, timestamps and shared query limits.
5. Only after equivalence, review a migration-bookkeeping transition against the operator's actual pinned Wrangler/D1 journal. Preserve the former ledger. This repository supplies no guessed live journal SQL or automatic marker.
6. Deploy only with explicit owner authorization and recorded staging smoke tests. Use a compatible code rollback if necessary; do not wipe data to roll back.

The application does not run migrations at request startup. Local tests do not certify a live database, provider connection or release.
