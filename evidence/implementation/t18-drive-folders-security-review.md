# Folder metadata and cleanup review

Independent read-only security reviewer: `/root/m0_security`. Reviewer inspected source, hashes and root-native evidence; did not implement fixes or execute native tests.

Required P2 finding: `archive_folders` retains a composite foreign key to connections. Omitting it from lifecycle leaf inventory blocked actual account erasure and left metadata after connection cleanup. Root reproduced both failures before the implementer changed cleanup.

The finding is closed in the reviewed patch. Folder metadata uses the existing tenant/target/current-request/stage/profile/journal guards and bounded 100-row deletion. Account cleanup removes the owner identity; connection cleanup drains the plan and permits parent deletion. Foreign plans remain. A 105-row witness proves unacknowledged deletion is blocked and an acknowledged unit leaves five rows without advancing stages or deleting parents; every unit remains within five physical queries. No remote file deletion was added.

Root commands, with telemetry disabled and unique temporary Wrangler log paths:

- `pnpm --filter @invoxim/worker exec vitest run test/drive-folders.test.ts`: exit 0, 13 passing tests, 2.96 seconds; `/tmp/invoxim-drive-folders-green-v1.txt`.
- `pnpm --filter @invoxim/worker exec vitest run test/m1-lifecycle.test.ts`: genuine RED exit 1, two failed and ten passed, 8.48 seconds; `/tmp/invoxim-folder-lifecycle-red-v1.txt`.
- Same lifecycle command after repair: exit 0, 13 passing tests, 8.45 seconds; `/tmp/invoxim-folder-lifecycle-green-v1.txt`.

Reviewed SHA-256:

- Folder store: `2dad3f32914b4ac3f2f1c32546e9ea590c750c4940ff020fa5c903b6c89451a2`.
- Folder tests: `c5ed2b167d911540d269786816d9f80a230ff55b1f16acb94d77f26b8cc76118`.
- Lifecycle leaf cleanup: `04f695c1ade18cba174f822f1a4ffdd6e709e0908ac3b513a54fb939532a9f74`.
- Lifecycle tests: `c5759d68c46a81feec759f3955f56959bf014590e2cb29138c550ffdd67901ed`.

This approves the inspected metadata and cleanup behavior only. Folder completion relies on an internal caller verifying remote creation; it does not prove remote availability. Uploads, coordinator, backfill, live grants and full T18 remain outside this report. Full Prisma cutover verification remains separate.
