# AI runtime activation and optional usage — 2026-10-13

## Actual configuration failure and repair

Owner reported authenticated AI settings and processing-disclosure 503s. Wrangler version inspection confirmed AI_ENABLED=false, AI_HOSTED_KEY present, and missing AI_REGISTRY_JSON/AI_BUDGET_JSON. The configured hosted destination/model alone could not satisfy aiConfiguration(). No database reset was required.

Owner approved USD1/day and USD10/month application inference caps. Primary Abacus public HTML at https://routellm-apis.abacus.ai/ contained the exact GPT-6 Luna row with Price/1M USD0.10 input / USD0.50 output. Root fetched and inspected that row; web text extraction omitted the model table. Public policy https://abacus.ai/privacy-policy describes no model training, upstream zero-retention agreements and separate Abacus backup/archive/audit retention. Notices reflect these as vendor statements, not an independent zero-retention certification; provider-managed failover remains disclosed.

Configuration source: config/ai.abacus.production.json. Runtime selection is fixed Abacus RouteLLM gpt-6-luna, reusable AI_HOSTED_KEY, input/output USDmicros per million100000/500000, other units conservatively at500000. Global daily/monthly inference caps1000000/10000000 USDmicros. Existing per-user defaults50/500 documents and1M/10M units. Application accounting does not configure provider account billing or subscription limits.

Main commit1fda31f; isolated release equivalent a6409dc. Fresh native validation of committed release:77tests/sixfiles,17.12s, exit0 (/tmp/invoxim-ai-isolated-verification.txt). Both actual authenticated read routes return200 with synthetic sessions/credentials and this preset, without HTTP/provider calls or jobs/consents/import runs. Initial validation76pass/1fail was a test expectation using processing.modelId instead of the real inference.model contract; corrected without runtime weakening. Main combined104tests/ninefiles24.54s also passed (77AI+9Drive+18Outlook subcases).

Production build and all three bundle publication guards passed (/tmp/invoxim-ai-release-build.txt). Configuration-only deployment exited0: Worker da0a5f26-11e9-46bf-b576-042650853cbb; deployment history confirms100percent traffic (/tmp/invoxim-ai-worker-deploy.txt,/tmp/invoxim-ai-live-confirm.txt). Read-only affected-workspace selection query returned no saved override, changes0/rows_written0; no keys or receipt data read. Independent read-only config review by outlook_runtime_map approved the bounded patch.

Jobs, extraction and discovery remain disabled. A valid disclosure therefore reports configuration unavailable/canStartImport=false rather than failing to load. Enabling an AI provider never silently starts an import. Full production authenticated endpoint smoke and live synthetic model test require the owner's existing browser session; the available test browsers are signed out. No credentialed model call or actual receipt import was performed.

## Optional usage metadata

Owner requested accepting valid OpenAI-compatible answers with missing usage, warning rather than rejection. Generic HTTP adapter now parses usage independently from response choices. Omitted/null/partial/malformed/inconsistent/out-of-bounds usage becomes null with static ai_usage_unavailable warning (no fields/content/IDs/keys). Valid choices still undergo refusal/tool/truncation/byte/deadline checks, and downstream extraction/schema validation remains required. Valid reported usage remains supported.

Core and D1 accounting already treat null usage as uncertain and retain the conservative reservation; they were not changed. Initial RED:13cases,8behavior failures plus1invalid prompt-version fixture failure and4pass (/tmp/invoxim-ai-optional-usage-red.txt). Fixture now uses EXTRACTION_PROMPT_VERSION; no guard relaxed. GREEN:113tests/ninefiles17.93s, exit0 (/tmp/invoxim-ai-optional-usage-green.txt), including native hosted reservation retention. Scoped Biome/ESLint/Prettier exit0. Independent read-only review by deployed_login_browser_qa approved source and inspected the113-case evidence; reviewer did not execute tests.

## Preset consistency

pnpm ai:config generates only five existing Wrangler AI variable lines from the public preset; credentials stay in platform secrets. pnpm ai:config:check rejects drift and is included in pnpm verify. Four Node tests prove parity, model-change generation preserving unrelated OAuth/resources, missing/duplicate target refusal and forbidden credential/unapproved variable rejection. All4pass; parity/static checks pass. This is a consistency guard, not a substitute for native registry/budget validation.

Full release verification and deployment of the optional-usage increment are pending at this checkpoint; results will be appended after execution. Unfinished M1 changes are excluded from its isolated release.
