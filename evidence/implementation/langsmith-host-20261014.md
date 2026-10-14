# LangSmith host environment configuration

Status: done, not deployed. Task AI-TRACE-HOST-01.

`LANGSMITH_HOST` selects an explicit Worker-only HTTPS API origin and maps to LangSmith Client `apiUrl`. Missing configuration retains the US API default; current working Wrangler configuration selects `https://eu.api.smith.langchain.com`. Optional trailing slash normalizes away. Credentials, paths, query strings, fragments, control characters and malformed URLs disable telemetry without preventing inference. Exports remain restricted to the chosen origin’s `/runs`, with no redirects or fallback. Keys remain in Wrangler secrets. Existing private-content boundaries, timeout and no-retry behavior remain unchanged.

RED: `pnpm --filter @invoxim/worker exec vitest run test/ai-tracing.test.ts`: 10 failed/7 passed, exit 1; explicit hosts ignored and invalid hosts incorrectly allowed exports. `/tmp/invoxim-langsmith-host-red.log`.
GREEN: `pnpm --filter @invoxim/worker exec vitest run test/ai-tracing.test.ts test/ai-langchain.test.ts test/ai.test.ts`: 44 passed/3 files, exit 0. `/tmp/invoxim-langsmith-host-green-final.log`.

Prettier on four changed files, scoped Biome with warnings treated as errors, ESLint, Worker typecheck and `pnpm --filter @invoxim/worker build` all exit 0. Worker build is a Wrangler dry run and displays the configured EU binding. `/tmp/invoxim-langsmith-host-{types,build}.log`. No full repository gate, live LangSmith request or deployment performed for this bounded change. Self-reviewed; no delegation requested for this small coupled task.

Context7 unavailable. Official LangSmith setup documentation confirms explicit API endpoint configuration; pinned SDK constructor behavior is exercised by native tests: https://docs.langchain.com/langsmith/create-account-api-key. SDK calls use explicit `apiUrl`; the app’s requested variable name is `LANGSMITH_HOST`, not an ambient SDK environment read.

Commit staging preserves unrelated owner changes, including existing Wrangler tracing flags.
