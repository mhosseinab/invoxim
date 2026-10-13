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

## Verified optional-usage release

Isolated commit49b0e21 ran full pnpm verify successfully:38 Node tooling tests,48 contract tests,372 core tests,1,213native tests/96files203.14s and82browser tests36.6s; type/lint/format/boundary/security/dependency/build and publication guards passed (/tmp/invoxim-ai-final-release-verify.txt). Worker641835b9-074f-42eb-b5b0-b7ceb8095641 deployed exit0 and deployment history confirms100percent traffic (/tmp/invoxim-ai-usage-worker-deploy.txt,/tmp/invoxim-ai-usage-deploy-confirm.txt). Real signed-out production browser sees publicconfig200/no-store and protected AI settings/disclosure401/no-store. Full authenticated/live-model smoke remains unperformed without the owner's session; no new key was read or session minted.

## Owner-requested simplification: read the file directly

Owner rejected generating/copying AI configuration into Wrangler. Generator scripts/tests/commands and the five duplicated AI variables are removed. The Worker imports config/ai.abacus.production.json into its server bundle through a small Worker composition helper. API fetch and scheduled/queue runtime use the same defaults; explicit environment overrides remain supported and fail closed. Keys/keyring remain Wrangler secrets, never bundled file values. The public template is inactive and not imported. No new infrastructure/config framework or provider fallback is introduced.

Real Worker RED without copied AI variables:1fail/7pass6.87s (/tmp/invoxim-ai-file-default-red.txt),503where200expected. Initial current file-default composition GREEN39tests/sixfiles16.35s (/tmp/invoxim-ai-file-default-green.txt). Final focused22tests/fourfiles13.63s exit0 (/tmp/invoxim-ai-file-final-green.txt) also verifies actual Worker explicit AI_ENABLED=false and missing hosted key refusal. Five-package typecheck8.519s exit0 (/tmp/invoxim-ai-file-types.txt); scoped Biome/ESLint/Prettier0. Source review by deployed_login_browser_qa approved helper/Hono fetch/context preservation and bracketing activation gates; execution evidence supplied afterward.

Remote plain-variable-name comparison confirms the only names removed are AI_ENABLED,AI_HOSTED_DESTINATION,AI_HOSTED_MODEL,AI_REGISTRY_JSON,AI_BUDGET_JSON. All other production plain variables are retained in Wrangler and platform secrets are unaffected. Final isolated verification/deployment of this simplification is pending at this checkpoint. Unfinished FX working edits to the shared Worker index are preserved and excluded from its release commit.

## Final file-based deployment

The first isolated simplification gate stopped at Prettier formatting of the staged fetch signature (/tmp/invoxim-ai-file-release-verify.txt); no upload occurred from that failure. Isolated style commit302bc1f corrected formatting only (main already contains that formatting). Full rerun exited0:34Node tooling tests,48contract tests,372core tests,1,214native tests/96files214.44s,82browser tests37.5s and all required type/lint/format/boundary/security/dependency/build/publication checks (/tmp/invoxim-ai-file-release-verify-v2.txt).

Final command wrangler deploy --keep-vars=false --no-upload-source-maps exited0 from isolated302bc1f. Production Worker f16337fc-4321-4f39-b0cd-6a36907a5080 has100percent traffic (/tmp/invoxim-ai-file-worker-deploy.txt,/tmp/invoxim-ai-file-traffic-confirm.txt). Version inspection confirms none of the five copied AI plain variables remain and both AI_HOSTED_KEY/CREDENTIAL_KEYRING secret names remain; no values were read. All other audited OAuth/runtime variables are preserved. Code imports the server preset; no generator/deployment copy is involved. Pages source and API response contracts did not change in this final simplification, so no additional frontend upload was needed.

Outstanding owner smoke remains: refresh the existing authenticated onboarding page and verify settings/disclosure, then the explicit synthetic model connection test. Available verification browsers remain signed out; native authenticated200 evidence is not presented as live authenticated200 evidence. Imports remain gated on Queue/discovery/extraction and explicit review/start. Full MVP goal is active, not complete.
