# T13/T15 independent frozen verification certificate

Independent QA agent pipeline_qa. Approved fresh isolated copy: `/tmp/invoxim-t13-t15-qa-final-h1g481uc/source`. Source/code/docs/config identity:258 files, manifest SHA256 `b92849ab2b74f4459dcbe2bf0f445b82689c9e479d16800dc8e0fba6cda8bb02`. Inventory and hashes are in t13-qa-final-snapshot.txt. Evidence/status metadata, dependencies and generated output excluded. No Git history/worktree/cache was copied; this isolation was expressly approved by the orchestrator.

Actual commands in that directory:

- `pnpm install --frozen-lockfile`: exit0; reused212, downloaded0. An earlier offline attempt failed because pnpm supply-chain metadata was absent; normal frozen install checked metadata without downloading packages. t13-qa-fresh-install.txt.
- `WRANGLER_LOG_PATH=/tmp/t13-qa-fresh-wrangler.log PLAYWRIGHT_BROWSERS_PATH=/tmp/invoxim-playwright-browsers pnpm verify`: exit0. Tooling10 + contracts45 + core168 + native Worker394 + browser24 =641 distinct tests, no skipped/todo tests reported. The three money property tests execute1500 seeded samples within their test count. Formatting, strict Biome198 supported copied files, ESLint, types, boundaries and builds pass. Initial tasks run cold/cache misses; later build cache hits reuse tasks run earlier in the same command. No copied or root Turbo success cache is used. t13-qa-fresh-verify.txt.
- `WRANGLER_LOG_PATH=/tmp/t15-qa-fresh-db.log pnpm db:check`: exit0;5 files73 tests, repeated from the full run, not extra distinct tests. Native legacy/database/pipeline/lifecycle/adversarial tests exercise migrations through0012 and bounded deletion. t15-qa-fresh-db-check.txt.
- `python3 /tmp/invoxim-t13-t15-qa-snapshot.py compare`: exit0 after both commands. Tested versus initial differences[]; root versus tested differences[]. t13-qa-source-match.txt.

Focused QA details and authentic RED evidence: t13-qa.md / t15-qa.md. Independent source-review records are separate t13-final-review.md and t15-security-review.md; this certificate does not manufacture review approval. The actual keyboard/720px navigation/360px equivalent200% reflow screenshot was visually inspected, and the copied browser suite reran these cases successfully.

No live provider/OAuth/revocation/model/Drive/deployment smoke, production journal independence, source-original retrieval or active-data24-hour erasure target is proved by these checks. Original retrieval remains explicitly unavailable. No credentials or production data were used. This certificate applies to the exact baseline source; any later documentation-only changes require separate comparison, and source changes require new applicable verification.
