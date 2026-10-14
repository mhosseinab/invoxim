# LangChain OpenAI-compatible adapter refactor — 2026-10-14

Task: AI-LANGCHAIN-01. Implementation checkpoint: 5f9be5c. Status: implemented, independently code reviewed and fully verified in a clean checkout.

## Scope and design

The existing provider-agnostic `InvoiceExtractor` seam now invokes public LangChain `ChatOpenAICompletions`. SDK types stay inside adapters. Pinned dependencies: `@langchain/openai@1.6.2`, `@langchain/core@1.2.17`; Worker tests declare the OpenAI integration as a dev dependency to spy on its public invocation. Existing LangSmith pin remains `0.10.11`. No LangGraph, model tools, provider fallback, mailbox-provider change or migration.

The custom HTTP boundary intentionally preserves the exact approved endpoint, canonical request JSON, provider-declared token parameter/schema capability, idempotency header and reservation computation. SDK model-name heuristics/defaults cannot change the actual paid request. `readChatResponse` retains original HTTP status/Retry-After handling, bounded UTF-8/JSON streams, exact assistant/choice/tool/refusal/finish checks and reported-usage validation before LangChain conversion. SDK-normalized usage never becomes metering authority. The LangChain message must reproduce the original validated content exactly.

Both SDK retry layers are disabled. Per-call abort/deadline handling remains. Cache, streaming and SDK logging are disabled. A private public-API callback-manager instance blocks all inherited/ambient handlers, including copies, without mutating global environment variables. Only the separately configured redacted LangSmith wrapper can export telemetry. Hosted/BYOK routing, consent, budgets, financial validation, durable queues, paid caches and mandatory Clef classification remain on their established paths.

Material deviation from standard SDK examples: canonical custom transport and explicit callback block are necessary to preserve this repository's bounded financial request/privacy contract. Core contains no vendor SDK import. Public Chat Completions is selected directly because the general ChatOpenAI class can force Responses API for model names even when `useResponsesApi` is false. Output version is explicitly `v0` to prevent ambient content-block conversion.

## Acceptance and executed focused evidence

- LC-01: one public LangChain invocation and one provider HTTP call; original content and absent usage preserved.
- LC-02: hostile `LANGSMITH_TRACING`, `LANGCHAIN_TRACING*`, `LANGCHAIN_VERBOSE`, synthetic ambient key and `LC_OUTPUT_VERSION=v1` cannot leak source/output or alter successful output.
- LC-03: 401, 403, 429, 503 and redirects cannot trigger SDK retries or destination fallback.
- LC-04: approved GPT-5.6 and custom Codex IDs remain exact model IDs on the approved Chat Completions wire request.

Initial dependency-resolution error was a harness error, not RED evidence. After declaring the test dependency, the original transport produced **6 failing / 1 passing** tests, exit 1 (`/tmp/invoxim-langchain-red.txt`). Reviewer-discovered output-version regression reproduced **1 failing / 8 passing**, exit 1 (`/tmp/invoxim-langchain-output-version-red.txt`).

Latest focused GREEN: **74 tests across 7 files passed**, exit 0 (`/tmp/invoxim-langchain-green.txt`): new LangChain tests plus existing stream limits, optional usage, schema/prompt, Abacus wire protocol, adversarial and tracing suites. Workspace typecheck passed all five tasks (`/tmp/invoxim-langchain-types.txt`). Focused Prettier, Biome, ESLint and diff whitespace checks passed.

## Independent review

Reviewer: `/root/langchain_review`, principal reviewer, read-only. Inspected implementation, pinned SDK source/types and actual test logs; did not edit or execute tests. Found P1 general ChatOpenAI forcing Responses API for model-name heuristics and P2 ambient output version turning content into blocks. Both corrected and re-reviewed. Approved functional code conditional on the full gate; no unresolved tenant/privacy/financial/cost blocker reported. Live behavior was not asserted.

## Operational effects and exclusions

No application schema/data/credential change and no provider/model destination switch. No production deployment, LangSmith enablement, real credential provisioning, live model call or content upload performed. Existing PDF/image and date-extraction limitations are unaffected. Library bundle/runtime compatibility is checked by workerd tests and Worker production dry-run; live provider quality remains separate evidence.

Context7 was unavailable. Consulted official LangChain OpenAI integration documentation and installed pinned SDK exports/types/source for constructor, retry, callback, output-version and API-routing behavior. Configuration/runbook: `apps/worker/CONFIGURATION.md`, LangChain OpenAI-compatible transport.

Full verification runs from a temporary clean archive of checkpoint 5f9be5c at `/tmp/invoxim-langchain-clean`, with a frozen-lockfile dependency install. Owner WIP is preserved. The original working checkout previously hit the existing aggregate secret-scan byte bound; that bound is not relaxed and unrelated owner changes are not certified by the clean result.


## Final verification

`WRANGLER_LOG_PATH=/tmp/invoxim-langchain-clean-wrangler.log pnpm verify` in `/tmp/invoxim-langchain-clean` exited **0**. Full log: `/tmp/invoxim-langchain-clean-verify.txt`.

Passed package boundaries, secret scan, pinned dependency policy, Prettier, Biome, ESLint, workspace typechecks, implementation-tool unit tests, 48 contract tests, 431 core tests, 1,479 native Worker tests across 124 files, production builds, production test/debug publication guard, and 87 Playwright browser tests (39.3 seconds). All seven implementation paths were SHA-256 compared with the original checkout and matched the committed implementation.

Worker dry-run bundle: 8,399.71 KiB / gzip 1,651.19 KiB. Previous LangSmith-only checkpoint: 6,539.61 KiB / gzip 1,332.48 KiB. Compressed increase: 318.71 KiB. Runtime latency/cold-start performance and real provider behavior were not benchmarked; the build is not a production deployment. No existing scanner limits or assertions were weakened. Unrelated owner WIP remains uncommitted and outside this certification.

Final reviewer disposition: `/root/langchain_review` approved frozen checkpoint `5f9be5c` after inspecting full verification evidence; previous conditional approval is satisfied. Both findings remain fixed and no blocking finding remains. Reviewer did not independently execute tests, call providers or deploy.
