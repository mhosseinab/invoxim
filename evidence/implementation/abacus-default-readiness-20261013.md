# Abacus default inference preparation — 2026-10-13

Owner-selected default: Abacus.AI RouteLLM, fixed model `gpt-6-luna`. Keep operator-funded hosted inference and encrypted BYOK through the existing provider-neutral port. Reuse server secret `AI_HOSTED_KEY`; no vendor alias, SDK, adapter rewrite or application fallback was added. Cloudflare GPT-OSS remains an inactive optional preset, not the default.

## Documentation and limits

Context7 tools were unavailable in the tool inventory. Official primary sources were read:

- [Chat completions](https://api.abacus.ai/help/route-llm/chat-completions/): self-serve base URL, bearer key, messages, `max_tokens`, non-streaming usage fields and JSON-object mode. Requests explicitly name `gpt-6-luna`; `route-llm` is never sent. The template enables JSON-object mode, keeps JSON-schema and provider idempotency disabled, and sends no tools, `abacus_tools`, storage/logging extensions or multimodal fields. Exact model behavior still requires live synthetic verification.
- [RouteLLM overview](https://api.abacus.ai/help/route-llm/): lists `gpt-6-luna` under OpenAI chat models and directs current prices to `GET /v1/models`. The linked pricing documentation resolved to a generic help landing page. No verified GPT-6 Luna chat price was obtained. Decisions API tariffs are unrelated and were not reused. The requested developer-platform URL returned no readable content.
- [Abacus product page](https://routellm-apis.abacus.ai/publications): advertises provider failover. Application requests a fixed model and has no destination fallback, but these docs do not prove Abacus disables its own failover for fixed-model calls. Operator disclosure must account for Abacus and upstream OpenAI; confirm the provider-managed failover policy before enabling private processing.
- [Abacus privacy policy](https://abacus.ai/privacy-policy): states no model training using customer/API content and upstream zero-retention agreements. It also allows retained user content for backups, archival or audit after account deactivation. These statements do not establish zero retention by Abacus itself or approve this application's disclosures.

Public template: `config/ai.abacus.example.json`. It is intentionally disabled, contains explicit unapproved pricing placeholders, and is not consumed by the application. Do not serialize its wrapper as a registry. This phase is configuration preparation, so no artificial RED or new runtime code was introduced.

## Operator inputs and sequence

1. Obtain a RouteLLM API key for the selected self-serve Abacus account and store it with the platform secret mechanism under `AI_HOSTED_KEY`. Root's remote inventory reported this name absent; this task did not inspect any secret values. Enterprise accounts need a separately reviewed workspace endpoint and may reject the self-serve host.
2. Retrieve the authorized model catalog/prices without inference, verify exact `gpt-6-luna` availability, and fill the model pricing snapshot with exact integer USD-micro rates, current source/date and actual approval. Do not use invented zero prices or change guards to allow missing pricing.
3. Review and replace both Abacus and OpenAI notice summaries, including applicable retention and provider-managed failover. Retain explicit consent/version/digest behavior.
4. Set `AI_REGISTRY_JSON` to the serialized reviewed `registry` array, `AI_HOSTED_DESTINATION=abacus-routellm`, `AI_HOSTED_MODEL=gpt-6-luna`, approved `AI_BUDGET_JSON`, and existing server-only `CREDENTIAL_KEYRING`. Keep other BYOK destinations only if independently approved. Unknown prices/terms keep `AI_ENABLED=false`.
5. After separately authorized bounded synthetic live smoke and readiness review, enable with `AI_ENABLED=true`. The existing job binding/dispatch prerequisites must also be ready. Users review and start processing through existing consent; login or selecting a default does not authorize content scanning.

BYOK remains a user choice within the approved destination registry, encrypted by the existing keyring. Changing models/destinations never silently switches the user's processing destination. Hosted and BYOK requests share the same bounded HTTP adapter, budget reservation, timeout, redirect refusal and strict downstream extraction validation.

Runtime/data effects when eventually enabled: bounded inert evidence text goes to the exact Abacus endpoint for the selected model; no new mailbox queries, migration, raw storage, model tools or logging were added. Existing potentially billed timeout/retry semantics remain. Subscription credits do not imply unlimited application allowance.

## Actual evidence

Prior Cloudflare implementation: root-brokered RED exit 1 with 5 intended failures / 6 passes / 11 total; root-brokered GREEN plus existing AI regressions exit 0 with 89 tests / 6 files, 13.64 s, `/tmp/invoxim-ai-cloudflare-green-v1.txt`. Generic namespaced support and regressions remain intact.

Abacus configuration tests in `apps/worker/test/ai-abacus.test.ts`: four cases verify disabled/unapproved template rejection, reusable hosted secret, preserved BYOK, missing hosted key failure, exact fixed-model JSON payload, no tools or router, reservation-before-call and reported usage. All data, prices and keys are explicitly synthetic; test approval cannot authorize production.

Executed static checks: `pnpm exec biome check apps/worker/test/ai-abacus.test.ts config/ai.abacus.example.json --error-on-warnings`, exit 0, two files; `pnpm exec eslint apps/worker/test/ai-abacus.test.ts`, exit 0. Formatting applied with Prettier. Root-brokered native test results, repository checks and independent review await actual completion.

Not performed: deployment, remote variables/secrets changes, model catalog request, inference, paid operations, raw user content transfer or production/private-content smoke. Live model availability/pricing, bounded wire compatibility, actual extraction quality and processor disclosure review remain required.
