# Native D1 restoration and baseline completion

Task T31 is complete for the owner's final scope: revert Prisma, retain the consolidated baseline, preserve required fixes, and establish recoverable commits. Source checkpoint: `016e34508193332f37f6aeeb432d0ac646198df6`. This does not complete T18, the full MVP, deployment or live provider gates.

## Result

Native D1 persistence and the original Drizzle authentication adapter are restored from verified pre-refactor snapshots. The custom Prisma driver, generated client, schema/config, direct dependencies and generation/Prisma-check scripts are removed. The original shared invocation meter preserves whole-batch preflight, atomicity, session accounting and disabled bulk operations.

The sole active `0001_initial.sql` contains 47 tables, 46 explicit indexes and the three required scheduler cursor seeds in 94 statements. Its SHA-256 is `a9e200f7314995740439925756dad7f80cc5138613cc0d7b84721674ab777323`. Nineteen historical migration fixtures remain byte-preserved. Fresh and populated schema comparison, constraints, initial data, existing ownership/timestamps/exact money and foreign-key checks pass. Existing databases require the separately reviewed non-destructive transition; no reset or migration was run remotely.

Retained fixes include source availability checks, one-clock archive completion, storage refresh subject/scope fences, folder metadata and its bounded lifecycle cleanup, correct profile-race fixture, native method forwarding, genuine historical fixtures, and scheduler initialization. Prisma experiments remain historical evidence, not current runtime code.

## Actual root verification

All commands used synthetic local data. Root serialized native/browser execution with unique temporary Wrangler logs and telemetry disabled. Raw outputs and provenance are preserved in `native-d1-restoration-final/`.

| Command | Actual result | Retained output |
| --- | --- | --- |
| `pnpm install --frozen-lockfile --ignore-scripts` | Exit 0; 304 dependency policy entries validated | `install.txt` |
| `pnpm verify` | Exit 0; formatting, Biome with no warnings, ESLint, strict types, boundaries, secrets, dependency policy, unit/integration/build/browser gates passed | `verify.txt` |
| `pnpm test:security` | Exit 0; 393 tests, 30 native files, 78.95 seconds | `security.txt` |
| `pnpm db:check` | Exit 0; 79 tests, five native files, 18.59 seconds | `database.txt` |
| `pnpm audit --json` | Exit 0; zero advisories at every severity | `audit.json` |
| Focused native baseline/history/invocation/auth/lifecycle command | Exit 0; 49 tests, six files, 13.39 seconds | `focused.txt` |

The full verification reports 1,491 passing checks: 23 tooling, 48 contracts, 372 core, 986 native integration and 62 browser tests. Contracts unit output reused an unchanged Turbo cache; core/native/browser/tooling executed in this run. Security and database counts overlap integration and are not added to that total. Native integration ran 70 files with no skips in 161.83 seconds; browser tests passed in 28.9 seconds.

Earlier failed attempts are recorded, not presented as passing: the missing scheduler seeds and folder parent-erasure failures were reproduced and repaired; one native wrapper typing error was corrected without casts; the first final native verify stopped on two formatting files, corrected before the passing run. The protected build policy now explicitly denies only the reviewed esbuild/workerd script versions while keeping scripts disabled and strict handling for other builds.

All 379 recorded source/config inputs were byte-identical at the end of verification. Five shared contract files independently match the verified pre-refactor snapshot. The combined 384 hashes describe source checkpoint `016e345` in `frozen-inputs.json`. Only completion documentation and Git's PDF binary attribute were updated afterward; no executable code or fixture bytes changed. The binary attribute preserves required byte-level xref spacing.

## Independent review and commits

Separate read-only architecture and security reviewers approved the restored source with no new required finding. They inspected hashes and actual outputs; they did not implement fixes or execute root's commands. Details: `native-d1-restoration-independent-review.md`. The folder deletion P2 finding is closed with actual owner/foreign, journal, 100-row and query-budget proofs; see `t18-drive-folders-security-review.md` and the final native integration run.

- `86595fd`: persistent scoped checkpoint-commit rule.
- `6ddf6ba`: consolidated baseline and preserved historical fixtures.
- `016e345`: verified local application, tests and build/runtime configuration checkpoint.

The initial implementation had been untracked; the application checkpoint makes future refactors recoverable. Unrelated blueprint/owner working-tree edits were preserved.

## Limits and operational effects

No live database, OAuth account, model endpoint, paid resource, deployment or remote user data was accessed. Provider-agnostic configuration and environment/secrets seams remain. Original bytes remain transient unless separately authorized user Drive archiving is enabled. Full archive coordinator, upload/backfill, live smoke, real model quality and remaining MVP work are not certified by this task. `MANUAL_TASKS.md`, `DEPLOYMENT_CHECKLIST.md` and `baseline-transition-checklist.md` retain those prerequisites.
