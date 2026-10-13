# GitHub Actions pnpm bootstrap repair

Status: verified on GitHub. Only the verification workflow was changed and pushed; unfinished local application changes were excluded.

The first failed run was https://github.com/mhosseinab/invoxim/actions/runs/38386375621 on `8a95ec00422f45cb2404a32271297b0d0f4722ca`: setup-node attempted automatic pnpm caching before pnpm installation. Commit `0932c2d` disables that automatic cache.

The next run https://github.com/mhosseinab/invoxim/actions/runs/38386748888 passed bootstrap but failed spawning Turbo tasks with `Exec format error (os error 8)`. The pinned pnpm 12.6.0 package contains a shell placeholder without a shebang. Its native installer replaces that placeholder, but the global installation skipped all scripts. The subagent verified the exact registry tarball integrity and installer/native-binary source and reproduced ENOEXEC using a direct subprocess.

Commit `6735cf3f2aa8fb0bc67e1eaad00f0d54228112bb` explicitly executes only that pinned pnpm native installer after the global installation. Workspace installation still uses `--frozen-lockfile --ignore-scripts`; dependency build policies remain intact. The reviewed hook links/copies the installed optional platform binary and does not download one itself.

## Actual remote verification

Successful run: https://github.com/mhosseinab/invoxim/actions/runs/38387177083, exact SHA `6735cf3f2aa8fb0bc67e1eaad00f0d54228112bb`. GitHub reports completed/success for every step, including `pnpm verify`, `pnpm check:deps` and `pnpm test:security`. The verify job lasted 7 minutes 50 seconds. Root independently re-read the run/job/step conclusions after the subagent report.

Observed counts: 48 contract tests, 372 core tests, 1,041 native integration tests across 76 files, 62 browser tests, and 393 overlapping security tests across 30 files. Node tooling tests are separate. No sum is presented as a count of independent security coverage. The dependency audit reports no advisories.

Implementation and investigation: separate subagent `/root/github_pipeline_fix`. Root committed and published the two isolated workflow changes. Workflow triggers only verification on main pushes and pull requests, with read-only contents permission; no deployment was performed.

Primary sources inspected were the exact pinned setup-node action and pnpm package sources. Context7 was unavailable. The complete downloaded GitHub log is retained locally at `/tmp/invoxim-ci-success-38387177083.log`; this report does not certify later unpublished feature work.
