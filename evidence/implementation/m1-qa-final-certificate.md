# M1 frozen local integration verification certificate

Status: current bounded M1 increment passed required local repository gates. This does not mark T16, T17, T18, T19, T20, T22, M0, M1, full MVP, or release complete. Runtime/provider/UI integration and live operational gates remain as documented by their owners.

## Frozen source and dependency setup

Approved isolated copy: `/tmp/invoxim-m1-qa-final-jidkc38t/source`. **385 input files**, manifest SHA-256 **33802d037c251ec9d1154fecaa13697f0be655153a5fe6f6e5196e2e526bb235**. Node24.21.0/pnpm12.6.0. `m1-qa-final-snapshot.json` records every included path and hash.

Actual `pnpm install --frozen-lockfile --ignore-scripts` exited0. Supply-chain policy checked304 lock entries and passed;212 packages reused,0downloaded. Registry metadata access was explicitly authorized after offline metadata failure; no new dependency/version or lifecycle scripts were introduced. The new copy contained no dependencies or generated build/runtime/Turbo state before install. All15 workspace links resolve within this snapshot, including core/contracts/adapters/testkit (`m1-qa-final-workspace-resolution.json`). Testkit intentionally has no package entrypoint; its actual workspace directory is checked rather than claiming a nonexistent root module export.

## Actual gates

| Command                                           | Exit | Observed result                                                                                            | Immutable raw log                  |
| ------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `pnpm install --frozen-lockfile --ignore-scripts` | 0    | Policy304passed;212reused,0downloaded                                                                      | `m1-qa-frozen-install-network.txt` |
| `pnpm verify`                                     | 0    | **1361 distinct tests**:22tooling+45contracts+372core+860native Worker+62browser                           | `m1-qa-frozen-verify-final.txt`    |
| `pnpm db:check`                                   | 0    | **79 repeated tests**,5files                                                                               | `m1-qa-frozen-db-check.txt`        |
| `pnpm test:security`                              | 0    | **261 repeated tests**,18explicitfiles                                                                     | `m1-qa-frozen-security.txt`        |
| `pnpm check:deps`                                 | 0    | Seven manifests pass policy;319 dependency entries audited with0info/low/moderate/high/critical advisories | `m1-qa-frozen-deps.txt`            |
| `python3 /tmp/invoxim-m1-qa-snapshot.py compare`  | 0    | Initial/tested and root/tested differences both empty                                                      | `m1-qa-source-match.json`          |

Database/security counts overlap the1361 and are not added to it. No skipped/todo tests were reported by final unfiltered gates. Actual native run:57files/860passed; browser62passed. Plain verify executed boundaries,secrets,dependency policy,formatting,fatal-warning Biome,ESLint,types,unit/native tests,builds/dry-run and browser tests. Initial type/unit graph had0cache hits; later build hits reused only results produced within this invocation. No workspace caches were copied.

The sole heavy lane serialized install,plain verification,db,security and dependency commands. Environment: `CI=true COREPACK_ENABLE_NETWORK=0 TURBO_TELEMETRY_DISABLED=1 WRANGLER_SEND_METRICS=false`; each native command had its own writable `.log` Wrangler path. Verify used `PLAYWRIGHT_BROWSERS_PATH=/tmp/invoxim-playwright-browsers`. User browser server4176 remained untouched; the configured test server used its own4175 lifecycle. Exact observed exits/counts/raw-log hashes appear in `m1-qa-frozen-results.json`.

## Scope and honest provenance

The input inventory includes current runtime/core/contracts/barrels,migrations0015/0016,testkit corpus,all native/browser tests and implementation tools/configuration/docs. It excludes dependencies/generated state,environment credential files,root evidence and protected `.agents` metadata. Its only specific nested-output exception is `apps/web/evidence/implementation/t29-frontend-mobile.png`. This is not a whole-filesystem secret-free claim. The copied scanner actually inspected374text files/3456393bytes, skipped11recognized binaries,and found0configured-pattern matches. Root whole-checkout scans/reviews remain separate evidence.

The final native suite includes Outlook authorization/service/routes/transport/folder inventory,Drive authorization/transport,exact transient-original bytes,FX reference/persistence,M1 bounded leaf cleanup,recurring domain and extraction corpus behavior,and finite reader resource regressions. These assertions use synthetic protocol fixtures/local D1; no real mailbox,model,Drive,reference service,provider approval,external deletion journal restore,or deployed queue was exercised. Folder completion means inventory traversal only; transport/original-reader ports are not proof of full runtime source retrieval or archiving. Offline fixture/oracle evaluation is not a real-model quality result. QA execution does not substitute for independent source review; root owns recording those actual approvals.

## Preserved failures

`m1-qa-frozen-install.txt` preserves offline install exit1 because registry metadata was absent. The first explicitly authorized local-dependency-reuse attempt then passed860native tests/builds but exited1 before E2E when pnpm refused a symlinked `.pnpm-task-run-state-v1` directory. `m1-qa-frozen-verify-first.txt`, `m1-qa-reuse-snapshot.json` and `m1-qa-reuse-source-match.json` remain preserved. No task-state security check was disabled. A new clean copy and actual frozen install repaired setup; no product test or source was weakened. Any future local dependency reuse must omit generated pnpm task-run state as well as other runtime/cache artifacts.

Initial behavioral RED and partial failed commands remain in their scoped immutable logs, including Drive cancellation-fixture diagnosis and all reader bound failures. `m1-qa-reader-resource-wave.md` records those separately. The earlier319selected native proof and T16certificate remain historical; neither was relabeled as this source. No further tests are required merely to increase counts; any later input edits require a separately bounded delta or justified revalidation.
