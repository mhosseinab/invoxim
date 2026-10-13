# Native D1 restoration independent review

Separate read-only architecture reviewer `/root/discovery_review` and security reviewer `/root/m0_security` approve the bounded restored source, with no new required finding. They inspected source, recorded hashes and root-executed logs; they did not implement fixes or execute native tests.

The original Drizzle authentication configuration/schema and native invocation meter match the verified pre-Prisma snapshot. Native D1 batches retain atomicity and adjacent conditional `changes()` behavior. The meter synchronously charges whole batches before submission, shares counters with sessions/auth/jobs, and rejects bulk execution/dump. The custom Prisma driver, generated client, direct dependencies and generation step are removed. Optional adapter declarations in BetterAuth dependency metadata do not imply application use.

The sole active baseline preserves native constraints, indexes and dispatch/schedule/recovery seeds. Historical migrations remain fixtures; the existing-database transition checklist prohibits replaying the initial schema onto a populated database. Folder cleanup retains its tenant/current-request/journal/100-row guards. Source availability, single-clock archive completion and credential-refresh subject/scope guards are preserved.

Inspected actual root proof: `/tmp/invoxim-native-baseline-green-v1.txt`, exit 0, 49 tests across six files, no skips, 13.39 seconds. The reviewers matched all 379 inputs against `/tmp/invoxim-native-inputs-before-v2.json`. Delta from the first manifest is limited to formatting two files. Recoverable commits `86595fd` (commit policy) and `6ddf6ba` (baseline) are separate checkpoints.

Reviewed hashes:

| File | SHA-256 |
| --- | --- |
| apps/worker/src/invocation-database.ts | eace3c65bc78bbd4aa10d36bf36d95b07c7518659d0d8df2c2d633f1c982ce9b |
| packages/adapters/src/auth/login.ts | 858eabd69e6c3cb729341355b57378595fa8217b43d88ddffcec0777b00bea08 |
| packages/adapters/src/auth-schema.ts | 20cce927440677ec7820ada93a86e42ee254155d7fddd232d1d26bad718da3fa |
| packages/adapters/migrations/0001_initial.sql | a9e200f7314995740439925756dad7f80cc5138613cc0d7b84721674ab777323 |
| packages/adapters/src/drive/folders.ts | f89f3b91b93683bed2206b8ab30bbf592995d559c21de2d1fb0322ad9b7b836d |
| packages/adapters/src/drive/refresh.ts | 2e8a0f155374b08ea2066db71cd21111430f4d8abc7974e35a78b68fea5d5050 |
| packages/adapters/src/lifecycle/m1-leaf-cleanup.ts | 35f2c506aa1a21db577b2756c9ca2895a324473a84b3349a603304c512959870 |

Full verification and remaining applicable gates require the final root certificate. This source approval does not certify full T18/MVP, remote migration, deployment or live provider quality.
