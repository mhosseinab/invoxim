# Independent production bundle publication review

Task: owner-required exclusion of Playwright/test/debugging packages from published production artifacts. Reviewer: separate read-only QA agent. Decision after repairs: approve the bounded source/publication guard increment; initial findings below are resolved. No observed forbidden package leak. This is local publication evidence only, not remote deployment certification.

## Reviewed scope

Inspected `tools/implementation/production-artifacts.mjs`, its test file, `apps/web/vite.config.ts`, root build/check scripts, web/Worker build scripts and `turbo.json` outputs. Only this report was written; no source/test edits, heavy build, browser, deployment or child agent was executed by this reviewer.

## Findings

### P1 — Worker metadata directory absent on clean build (resolved)

Initial `apps/worker/package.json` passed `.production/worker.json` to Wrangler without creating the directory. Actual root build artifact `/tmp/invoxim-production-build-guarded.txt` recorded Worker exit 1 for a missing metadata file/directory and 4 of 5 build tasks successful. This was a genuine build failure, not GREEN.

Root subsequently added recursive `.production` directory creation before Wrangler. Re-read that correction; `/tmp/invoxim-production-build-final.txt` records 5 successful tasks (4 cached) and the publication guard success. Final process exit status is executor-owned, not independently captured here.

### P2 — Web graph omits external imports

Status: resolved in final inventory and guard re-review below.

Location: `apps/web/vite.config.ts`, `production-module-inventory.generateBundle`.

Inventory collects chunk `modules` IDs only and writes `{inputs:[...]}`. It does not record chunk static/dynamic imports. The guard checks external imports only through `graph.outputs[*].imports`, so frontend externalized forbidden imports are invisible to the generated web graph.

Reproduction from source boundary: an emitted frontend chunk with an external import such as `@playwright/test` but no bundled module ID for that external package generates only ordinary input IDs. The guard sees neither a forbidden input nor an output import. No such externalization or package leak was observed in current production output; this is a fail-closed evidence gap.

Smallest fix: include chunk static/dynamic import references in the private web inventory using a guard-supported output representation. Add a focused synthetic regression for a forbidden external web import and legitimate local chunk/preload imports. Preserve the current module inventory and keep metadata outside public `dist`.

### P2 — Empty emitted-output evidence accepted for esbuild graphs

Status: resolved in final guard re-review below.

Location: `tools/implementation/production-artifacts.mjs`, `graphInputs`.

Object-form inputs require an outputs object but accept `outputs:{}`. A graph with nonempty source inputs and no emitted-output evidence is accepted; the baseline test fixture explicitly uses that shape. This weakens the stated fail-closed check for actual emitted build evidence.

Smallest fix: require nonempty, structurally valid output evidence for esbuild-form graphs and update the synthetic valid fixture. Add a missing-output regression. Handle the separate Vite inventory format deliberately rather than manufacturing esbuild metadata.

## Positive assessment

The guard normalizes Windows path separators, resolves package names using the final `node_modules` segment (including pnpm nested layouts), rejects explicit testing/debug/build tooling and testkit/test source paths, and checks esbuild external imports. It scans the full public web artifact tree for tests, reports, dependency/browser directories, source maps, build graphs and symlinks. It fails for absent graphs/artifact roots and unreadable/malformed inputs. Ordinary runtime functions named debug are not incorrectly treated as published debug tools.

Root build requires all three named metadata files (web, Pages Function and Worker), and runs the guard after Turbo. Vite captures actual bundled module IDs in `generateBundle`, disables public sourcemaps and places its graph outside `dist`. Pages Function metadata is similarly private. Worker dry-run artifacts are not the web directory being uploaded; `--no-upload-source-maps` explicitly disables map upload. Wrangler-generated facade paths are legitimate runtime composition rather than test-origin exceptions. Turbo restores both `dist/**` and `.production/**` together, so graph evidence is available on cache hits.

## Execution/evidence inspected

Read-only source/diff/artifact commands were executed. No guard unit test or build was run by this reviewer. Root reports genuine initial RED/GREEN guard tests (six intended failures, then seven passes); that raw unit output was not inspected in this review at initial report creation.

Inspected root build outputs listed above. Final output records five successful tasks and a passing test/debug publication guard. The root reports inventories of 996 Worker, 4 Pages Function and 90 web module origins; these counts are executor-reported, not independently recomputed here. Build output inspection was limited to outcomes; runtime settings or identities are not copied into this repository report.

## Remaining gates and limits

Local guard success does not prove remotely uploaded content, current deployed version or absence of all possible runtime debugging behavior. No new dependencies are required by the reviewed approach. Production/public deployment remains a separate explicitly authorized operation; no live login/session/provider result is established by this review.

## Final repaired source and actual local publication evidence

The Vite inventory now records nonempty emitted chunk outputs with both static and dynamic import references and explicit external classification alongside actual chunk module IDs. Both graph representations now require nonempty outputs with import arrays. An additional repair rejects absent/malformed external classification and empty paths; explicit internal chunk imports are distinguished from external forbidden packages. Inspected regressions cover missing/empty outputs, forbidden static/dynamic imports, legitimate internal chunk names and malformed classification in both graph forms. No remaining blocking source findings.

Inspected `/tmp/invoxim-production-final-inventory.txt`: fresh build records 5 successful tasks, 0 cached, 6.489 seconds after the inventory repair. Root reported build process exit 0 and its publication check exit 0. This reviewer did not run a build or deploy.

Independently executed the read-only local guard:

```text
node tools/implementation/production-artifacts.mjs --artifact apps/web/dist --graph apps/web/.production/web.json --graph apps/web/.production/pages.json --graph apps/worker/.production/worker.json
```

Observed exit code 0 and the passing test/debug publication guard message. This operation only reads artifact directories and graph files; it is independent execution of this guard, not a unit test or build.

Independently parsed the actual three graph files: web 90 inputs, 1 output, 0 external imports; Pages Function 4 inputs, 1 output, 0 external imports; Worker 996 inputs, 1 output, 2 external imports. Every actual graph passed the final classifier/public directory guard. Private Worker dry-run output is not recursively uploaded as public web content and explicitly disables source-map upload. Public web source maps/reports/dependencies and symlink publication escapes are rejected by the actual executed check.

Inspected `/tmp/invoxim-production-guard-tests-final.txt` after the final malformed-classification regression: 11 tests, 11 pass, 0 fail, 0 skipped. Root reported terminal exit 0; the reviewer inspected its raw output rather than executing the suite. Also inspected `/tmp/invoxim-production-guard-final.txt`, which records root's passing publication check (reported exit 0), in addition to this reviewer's independently executed passing check. No remote migration or browser login result is claimed as production bundle validation.
