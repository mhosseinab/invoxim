# LangSmith adapter tracing — 2026-10-14

Task: AI-TRACE-01. Implementation commit: 5517490. Scope: optional tracing of the existing OpenAI-compatible extraction adapter and built-in synthetic credential probe. No LangChain/LangGraph dependency or workflow migration.

## Acceptance evidence

Native workerd tests: `apps/worker/test/ai-tracing.test.ts`.

- TRACE-01: disabled/malformed optional configuration causes no export; ordinary inference remains usable.
- TRACE-02: one completed metadata-only run excludes private input, output, identifiers and credentials; missing usage remains unavailable.
- TRACE-03: exporter 503/timeout cannot change a successful model result or cause another model call; timeout aborts export.
- TRACE-04: content flag cannot expose private import content; only synthetic probes can include bounded content, with known keys scrubbed.
- TRACE-05: thrown provider errors preserve their identity and their message never enters tracing.

RED: temporary pass-through implementation produced 3 failures and 1 passing test, exit 1 (`/tmp/invoxim-langsmith-red.txt`). Failures demonstrated absent exports/content behavior. GREEN: 7 native tests passed, exit 0 (`/tmp/invoxim-langsmith-green.txt`). Typecheck passed in the working checkout (`/tmp/invoxim-langsmith-types.txt`). Focused Biome, ESLint, Prettier and diff whitespace checks passed.

Full verification is recorded separately below when finished. The original working checkout contains unrelated owner changes; its secret scanner hit `scan-byte-limit`. No scanner limit was weakened and no owner files were removed. A temporary clean copy of HEAD plus precisely the seven implementation paths was created at `/tmp/invoxim-langsmith-clean`, with a frozen-lockfile dependency install. No real credentials or mailbox data were copied.

## Configuration and runtime effects

Worker-only bindings: `AI_TRACING_ENABLED`, `AI_TRACING_INCLUDE_CONTENT`, `LANGSMITH_PROJECT`; credential: Wrangler secret `LANGSMITH_API_KEY`. Tracing defaults disabled. Project default: `invoxim-ai`. Export is fixed to the US LangSmith `/runs` endpoint; redirects/custom destinations are rejected. Invalid telemetry configuration does not invalidate AI provider configuration.

Metadata allowlist: provider/model IDs, prompt/schema version, hosted/BYOK mode, generic status/reason, completion state, elapsed time and optional reported usage. No tenant/session/source/consent/attempt identifiers, exception text or receipt values. Runtime/environment enrichment is disabled. Trace IDs are independent random UUIDs.

Content flag permits only built-in synthetic probe content. Private content tracing remains unavailable until the separate processor-disclosure/consent path exists. Synthetic content is capped at 16,000 characters per part and output; known provider/tracing keys are removed. No database migration, stored application transcript, queue payload change, new retry behavior or financial-policy change.

One completed run is exported after each enabled adapter invocation; at most one second is awaited. Export has zero retries; SDK background batching/prompt caching/debug output are disabled. Export bodies are never copied into errors. Original inference results and exceptions are preserved. Enabled tracing adds a network request and can add up to one second of latency; LangSmith account limits/pricing are external to the model allowance.

Only adapter invocations are covered. Clef classification, downstream financial validation and cached outcomes are not separately traced by this change. No LangSmith credential provisioned, production tracing enabled, live LangSmith upload, live-model smoke test or deployment performed. Independent review was not run.

## Documentation verification

Context7 was unavailable. Official LangSmith custom-instrumentation, privacy and serverless documentation were consulted; SDK APIs were verified against installed `langsmith@0.10.11` types and source. Version is pinned; no release-age policy exception retained. Operator instructions: `apps/worker/CONFIGURATION.md`, Optional LangSmith adapter tracing.

## Final verification

Status: implemented and verified; production enablement remains an operator action. `WRANGLER_LOG_PATH=/tmp/invoxim-langsmith-clean-wrangler.log pnpm verify` in the clean checkout exited **0**. Log: `/tmp/invoxim-langsmith-clean-verify.txt`.

Passed: package boundaries, secret scan (726 files, no findings), pinned dependency policy (7 manifests, no findings), Prettier, Biome, ESLint, strict workspace typechecks, implementation-tool unit tests, 48 contract tests, 431 core tests, 1,470 native Worker tests across 123 files, production builds, test/debug artifact publication guard, and 87 Playwright browser tests (39.2 seconds). Worker dry-run bundle: 6,539.61 KiB / gzip 1,332.48 KiB. Seven implementation paths were SHA-256 compared with the original checkout and all matched the committed implementation.

The working checkout's full verify remains blocked by pre-existing aggregate scan size, not this patch. Clean verification contains committed baseline plus this change; unrelated owner work is preserved and is not certified by this result. No tests were disabled, no scanner bounds relaxed and no provider/budget/auth safeguards weakened.
