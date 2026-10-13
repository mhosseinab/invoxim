# Cloudflare-hosted inference preparation — 2026-10-13

Scope: prepare GPT-OSS 20B through the existing provider-neutral, bounded chat-completions adapter. No deployment, resource creation, secret read/write, live inference, user content transfer or paid operation was performed by this task.

Later owner steering selected Abacus GPT-6 Luna as the default. This Cloudflare example remains an inactive alternative; see `abacus-default-readiness-20261013.md`.

## Verified documentation

Context7 tools were absent from the available tool inventory. Official primary documentation was read instead:

- [Cloudflare GPT-OSS 20B](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/): Cloudflare-hosted model ID `@cf/openai/gpt-oss-20b`, chat-completions compatibility, `max_tokens`, and listed input/output pricing.
- [OpenAI compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/): account-scoped `/ai/v1/chat/completions` endpoint and bearer authentication. This routes to Cloudflare, even though the model name includes `openai`.
- [REST token setup](https://developers.cloudflare.com/workers-ai/get-started/rest-api/): Workers AI token template; custom tokens require Workers AI Read and Edit permissions. Scope to the intended account only. Never reuse a broad Wrangler deployment token for inference.
- [JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/): supported-model list does not explicitly include GPT-OSS. The model page declares `response_format`, but exact GPT-OSS support is unresolved. The preparation template therefore uses `jsonSchema=false` and `jsonObject=false`. The existing prompt requests JSON; application validation remains required.
- [Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/): operator must review current processor terms, model license, and truthful retention disclosure. The template deliberately contains no approved policy assertions.

No SDK, dependency, binding or vendor-specific port was added. Model IDs alone gain strict namespaced syntax; provider, destination and notice IDs retain the existing restrictions. Existing selection, consent fingerprints, encrypted BYOK, timeout/body bounds, usage and budget reservation remain in place.

Pinned local `@cloudflare/workers-types` 5.20261006.1 declares GPT-OSS 20B with chat-completions input/output and prompt/completion/total token usage. It states reasoning is always enabled, default medium. The template's output cap still needs a live synthetic check for adequate final JSON and correct accounting; no reasoning-parameter extension was added.

## Operator configuration

`config/ai.cloudflare.example.json` is intentionally inactive and fails runtime pricing approval until reviewed. It is a public preparation template, not a file consumed by the application.

1. Replace `ACCOUNT_ID` in the exact registry endpoint with the selected Cloudflare account ID. Set `AI_REGISTRY_JSON` to the serialized `registry` array, retaining any other approved BYOK destinations. Do not serialize the wrapper object.
2. Review the current pricing snapshot and processor/license/retention disclosures. Replace the placeholder notice summaries. Set pricing `approved=true` only after actual review. The listed 2026-10-13 prices are estimates for configuration preparation, not an operator approval or guaranteed future tariff. `other` uses output pricing conservatively; validate how reasoning usage is reported before live operation.
3. Set server-only `AI_HOSTED_KEY` to a dedicated account-scoped Workers AI token using the platform secret mechanism. Do not paste it into this file, frontend variables, evidence or logs. Retain existing server-only `CREDENTIAL_KEYRING` for encrypted BYOK credentials.
4. Configure and approve `AI_BUDGET_JSON` with the required daily/monthly document/unit and global USD-micro limits. Example limits are proposals, not authorization to spend.
5. Select `AI_HOSTED_DESTINATION=cloudflare-workers-ai` and `AI_HOSTED_MODEL=@cf/openai/gpt-oss-20b`. Keep `AI_ENABLED=false` until the live gates below pass. Existing required job bindings and dispatch must also be configured; inference alone does not make import operational.
6. After authorized isolated synthetic smoke and review, enable using `AI_ENABLED=true`. Users review and start processing through existing consent; changing destinations/configuration does not authorize reprocessing automatically.

Hosted operator funding and encrypted BYOK use the same approved registry/port. A BYOK token must authorize the account configured in its selected destination endpoint. Supporting a different account requires its own operator-reviewed registry entry; user-entered arbitrary endpoints remain disallowed. No selection silently falls back to another destination.

Runtime effects: inference sends bounded inert text parts to the reviewed Cloudflare endpoint. It does not add mailbox queries, raw storage, AI tools, direct model database access, another vendor call, or an AI binding. Usage is reserved/reconciled through existing budgets. Unknown usage/timeouts may still be billed and must not be described as free or exactly-once.

## Verification record

Focused synthetic workerd tests: `apps/worker/test/ai-cloudflare.test.ts`. They cover model IDs in registry/settings request/settings response, unchanged provider restrictions, malformed IDs, hosted/BYOK configuration, exact tool-free request fields, reported usage and refusal to call before sufficient reservation. Synthetic prices/keys/policies in tests are fixtures only.

RED: root-brokered `pnpm --filter @invoxim/worker exec vitest run test/ai-cloudflare.test.ts`, exit 1, 5 failed / 6 passed / 11 total, duration 1.47 s. The five failures prove existing schema rejection of the actual namespaced model in registry, settings, environment and transport setup. Evidence: `/tmp/invoxim-ai-cloudflare-red-v1.txt`.

Static checks executed after implementation: `pnpm exec biome check packages/contracts/src/ai.ts packages/adapters/src/ai/configuration.ts apps/worker/test/ai-cloudflare.test.ts config/ai.cloudflare.example.json --error-on-warnings`, exit 0, 4 files; `pnpm exec eslint packages/contracts/src/ai.ts packages/adapters/src/ai/configuration.ts apps/worker/test/ai-cloudflare.test.ts`, exit 0. A first Biome pass identified import ordering, which was corrected without suppressions.

GREEN, regression, full repository typecheck/build/E2E and independent review remain root-brokered pending actual recorded results.

Subsequent root-brokered GREEN: focused Cloudflare tests plus existing AI regressions passed, exit 0, 89 tests / 6 files, 13.64 s. Evidence: `/tmp/invoxim-ai-cloudflare-green-v1.txt`. Full repository checks and independent review remain separately recorded by the root agent.

Live gates not executed: token authorization, exact GPT-OSS chat response/usage shape, reasoning/output limits, JSON extraction quality, processor disclosure approval, deployment and real mailbox processing. A successful mock proves application compatibility, not live model quality or production readiness.
