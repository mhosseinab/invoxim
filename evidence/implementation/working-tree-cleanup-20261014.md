# Working-tree cleanup — October 14, 2026

## Scope and decisions

The owner authorized reviewing every remaining uncommitted path, committing useful work and deleting unnecessary leftovers. This was repository cleanup, not authorization to deploy, add providers, alter production data or run paid models.

- Removed two unconnected Worker runtime wrappers and their two experimental tests. Restored the related Outlook and onboarding adapter edits to committed behavior, including the dormant Outlook retry experiment. No new provider was enabled. Restored stale additions to data-model/API docs and an unnecessary START_HERE wording edit.
- Deleted the 75 MB untracked failed helper-test output. Other ignored local files were not swept indiscriminately.
- Recorded removal of seven obsolete blueprint packaging files: VALIDATION.md, root manifest/validation report, packaging syntax script, and three preparation logs/reports. Git history retains their original contents. Kept the actual blueprint helper implementation and application verification tools.
- Retained five owner-supplied PNG design references. They are valid PNGs under docs/design, outside production assets. Inspected the logo reference and validated image formats/dimensions; no new visual implementation is claimed.
- Replaced the stale whole-message/optional-classification/uncompressed-PDF flow draft with current mandatory per-document Clef and bounded PDF behavior. Preserved the native-D1/frequent-commit decision while adding provider-neutral configuration guidance consistent with direct JSON-file AI defaults.
- Retained explicit LangSmith metadata tracing/project configuration, switched content capture off, and corrected configuration documentation. No credentials were added and no production deployment or telemetry/model request occurred.
- Preserved historical backlog progress with 118 newly committed referenced evidence files (approximately 630 KB). All newly referenced paths existed; credential-signature/assignment scan found no findings and no consumer-email domains were found. Trailing whitespace was normalized in 12 historical text records; recorded outcomes and source hashes were not changed. These are historical records, not newly executed claims.

## Review and checkpoints

Read-only specialist /root/cleanup_runtime_review examined remaining runtime edits and actual production consumers, then re-reviewed the cleanup decisions and current flow docs. Its initial synthetic runtime check passed 30 tests in three files; those experiments were subsequently removed, so this does not represent enabled Outlook production behavior. The reviewer found no cleanup blockers and identified the tracing-default wording inconsistency, which the parent corrected. The reviewer did not edit or deploy.

- faac350: retained metadata-only LangSmith configuration and matching docs.
- f87ce14: retained design/current docs and removed obsolete packaging artifacts.
- 29e4995: historical task progress plus referenced verification records.

## Fresh verification

Parent retained-configuration tests: `pnpm --filter @invoxim/worker exec vitest run test/operational-configuration.test.ts test/mandatory-classification-config.test.ts test/ai-tracing.test.ts` — exit 0, 29 tests / 3 files. Log: /tmp/invoxim-cleanup-retained-config.log. Formatting checks and scoped diff checks passed. A focused backlog integrity check passed for 49 unique tasks, valid states, dependency references and an acyclic graph. It does not claim the legacy blueprint validator supports later ad-hoc task shapes. PNG formats/dimensions were checked with file; credential scanning reused the repository's existing secretFindings implementation.

`WRANGLER_LOG_PATH=/tmp/invoxim-cleanup-wrangler.log pnpm verify` passed, actual exit 0, on a clean archive of committed source 29e4995. Boundary, secret, dependency-policy, Prettier, strict Biome, ESLint, type, Node helper and unit checks passed. Contracts: 48 tests / 5 files. Core: 431 tests / 21 files. Worker: 1,626 integration tests / 132 files. Build and production test/debug publication guard passed. Browser: all 104 tests passed. Log: /tmp/invoxim-cleanup-verify.log.

A scoped diff against starting source 6dd7ec0 confirms no changes to packages, Worker runtime source or Worker tests. `git status --porcelain` and `git diff --check` were empty after the three cleanup checkpoints. This final report/task-reference commit changes no runtime behavior.

No production deployment, database migration/reset, provider enablement or paid model evaluation was performed. The earlier separate paid Clef accuracy request remains pending; this cleanup does not mark live quality measured.
