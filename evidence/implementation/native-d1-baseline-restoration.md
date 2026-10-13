# T31 native D1 restoration and consolidated baseline

Status: complete for the final native restoration and baseline scope. Actual full verification and independent review are recorded in `native-d1-restoration-final-certificate.md`; earlier checkpoints below remain historical. The owner's latest decision supersedes the Prisma migration: restore native D1 and established Drizzle authentication, retain one consolidated initial SQL baseline. No reset, remote database mutation, deployment or paid resource is authorized or executed.

## Bounded restoration plan and implementation

The orchestrator assigns adapter source/manifests/documentation to the migration writer, Worker source to the native-runtime writer, all Worker fixtures to the fixture writer, and global tooling/lock/install/protected rules to the orchestrator. Each writer preserves unrelated work. Heavy/native checks run only through the orchestrator's broker.

1. Restore established native D1 types and direct parameterized query/batch semantics in the adapters; preserve tenant predicates, changes()/RETURNING ordering, exact monetary text aggregates, fences and transaction boundaries.
2. Restore Better Auth 1.7.7's Drizzle adapter and exact Drizzle 0.45.4 schema/configuration, including INTEGER epoch-millisecond dates and boolean mappings. Remove Prisma runtime, custom driver, generated client, schema/config, exports and direct dependencies.
3. Restore the original native invocation statement meter and fixture observation paths. Keep one shared 40-statement budget across authentication and repository queries, whole-batch preflight and session sharing. Worker and fixture writers own these changes.
4. Keep the consolidated initial migration, archived historical SQL, scheduler initialization and meaningful folder metadata/lifecycle cleanup/refresh race repairs. Do not restore old source wholesale where newer changes exist.
5. Run clean install/audit, types, native baseline/populated upgrade/auth/atomic/tenant/money/lease/query-budget regressions and required full verification/security/database checks. Record actual results, obtain independent review and make scoped recoverable commits through the orchestrator.

Adapter reversal is implemented. The pre-cutover inventory was compared with the original synthetic QA snapshot at `/tmp/invoxim-m1-qa-final-jidkc38t/source`. The exact restored `auth/login.ts` hash is `858eabd69e6c3cb729341355b57378595fa8217b43d88ddffcec0777b00bea08`; `auth-schema.ts` is `20cce927440677ec7820ada93a86e42ee254155d7fddd232d1d26bad718da3fa`. The original Worker meter backup supplied to its writer hashes `eace3c65bc78bbd4aa10d36bf36d95b07c7518659d0d8df2c2d633f1c982ce9b`. These are copy/provenance checks, not runtime verification.

Abandoned Prisma-only adapter source/schema/generated snapshots are retained under `/tmp/invoxim-abandoned-prisma7-20261013/adapters`, outside repository runtime/test includes. Earlier Prisma logs/reviews are historical and do not certify the restored runtime. The restoration introduces no persistence abstraction or infrastructure.

## Retained baseline and regression evidence

The sole active migration is `packages/adapters/migrations/0001_initial.sql`, unchanged SHA-256 `a9e200f7314995740439925756dad7f80cc5138613cc0d7b84721674ab777323`: 94 statements, 47 application tables, 46 explicit indexes and three required scheduler rows. Original 19 migration bytes remain in `apps/worker/test/migrations/historical`; hashes are recorded in `prisma-d1-migration-hashes.json`. Ordinary fixtures initialize the baseline; explicit historical fixtures exercise populated upgrades. CHECKs, partial indexes, composite tenant FKs, integer milliseconds and exact financial values are retained. The [transition checklist](baseline-transition-checklist.md) requires a separately authorized procedure for an existing database; replaying the baseline is prohibited.

The earlier genuine missing-seed RED remains applicable to the retained SQL: broker run exited 1 with one failed/five passed across two files (`/tmp/invoxim-prisma7-seed-red-v1.txt`). Adding historical 0006's dispatch/schedule/recovery seed defaults fixed the baseline. The broker's seed/codec run then exited 0, eight passed across three files (`/tmp/invoxim-prisma7-seed-codec-green-v1.txt`). That run used the superseded Prisma stack; native restoration baseline checks remain required.

Earlier full Prisma verification was not complete: v1 exited 1 with 33 failed/947 passed/20 skipped across 77 native files; v2 exited 1 with two failed/1005 passed/zero skipped across 78 files. Logs `/tmp/invoxim-prisma7-verify-v1.txt` and `/tmp/invoxim-prisma7-verify-v2.txt` remain historical diagnostics. No final Prisma completion is claimed.

## Acceptance and effects

Acceptance scope: BASELINE, HISTORICAL-UPGRADE, DB-01 through DB-04. The restored-native runs must prove clean/populated schema equivalence and defaults, tenant constraints/indexes, late CHECK/FK rollback, stale lease writes, exact aggregates beyond JavaScript safe integers, auth date/boolean compatibility and shared query limits. Planned checks are not passing evidence.

Privacy/permissions: no broadened provider scopes, original retention or live provider access. Synthetic fixtures only. Cost/runtime: no new service, credentials or paid resource; Prisma engine/dependencies and its custom persistence layer are removed. Reviewed folder metadata/lifecycle cleanup and refresh fixes remain; the full T18 upload coordinator is outside this task and remains unfinished. Live OAuth, provider APIs and deployment require separate authorized smoke tests.

## Restored-native execution evidence

Pending broker results: dependency installation/audit, typechecks, baseline/populated historical and native regressions, format/lint/build/full `pnpm verify`, security/database checks, independent review and scoped integration commit identities. No passing result is inferred from source inspection.

Broker checkpoint after adapter/runtime/fixture restoration:

- Root native session 54544 exited 0. Exact command: `WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/invoxim-native-baseline-green-v1.log pnpm --filter @invoxim/worker exec vitest run test/baseline.test.ts test/historical-upgrade.test.ts test/invocation-database.test.ts test/auth.test.ts test/auth-adversarial.test.ts test/m1-lifecycle.test.ts > /tmp/invoxim-native-baseline-green-v1.txt 2>&1`. Six files, 49 tests passed, 13.39 seconds. The writer read the returned log; this is orchestrator execution, not an independent QA run.
- Root typecheck v2: `turbo run typecheck`, exit 0, five successful tasks; three replayed cache hits. `/tmp/invoxim-native-restoration-types-v2.txt`.
- Root frozen installation exited 0; final restored lockfile passed supply-chain policies for 304 entries. `/tmp/invoxim-native-restoration-frozen-v1.txt`. The earlier 425-entry install is intermediate, not the final restored dependency graph.
- Root dependency audit reports zero vulnerabilities at all severities. `/tmp/invoxim-native-restoration-audit-v1.json`. No audit waiver was used.
- Root Biome v2: `biome check . --error-on-warnings`, exit 0, 343 files checked with no fixes. `/tmp/invoxim-native-restoration-biome-v2.txt`.
- First restored `pnpm verify` exited 1 on formatting only in `packages/adapters/src/jobs/store.ts` and `apps/worker/src/pipeline-runtime.ts`. `/tmp/invoxim-native-restoration-verify-v1.txt`. The orchestrator formatted those two files and froze 379 source inputs for rerun; no behavioral assertion was changed to resolve this failure.
- Full restored verification v2 is running in root session 20156, `/tmp/invoxim-native-restoration-verify-v2.txt`, with `/tmp/invoxim-native-inputs-before-v2.json` recording frozen inputs. Final verification, database/security gates and independent review remain pending until actual results are returned.
