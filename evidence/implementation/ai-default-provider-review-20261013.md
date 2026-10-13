# Independent AI default preparation review

Task: bounded model namespace validation and owner-selected default provider preparation. Reviewer: separate read-only QA agent. Decision: approve this source/configuration preparation increment; no blocking source findings. This does not approve live inference, provider policy/pricing, model quality or deployment activation.

## Reviewed scope

Inspected diffs in `packages/contracts/src/ai.ts` and `packages/adapters/src/ai/configuration.ts`, inactive `config/ai.abacus.example.json`, synthetic `apps/worker/test/ai-abacus.test.ts` and `ai-cloudflare.test.ts`, and relevant server configuration invariants. Observed Wrangler AI default destination/model values while AI/extraction/discovery/jobs remain disabled; unrelated authentication configuration was not reviewed or copied into this report. No provider API, credential, real receipt, runtime inference, deployment or heavy test/build process was used by this reviewer. Only this report was written.

## Findings and assessment

No blocking findings in the bounded scope. `aiModelIdentifierSchema` preserves prior simple model IDs and adds a bounded three-segment `@namespace/provider/model` form. Only model fields use the new schema; provider IDs retain their stricter existing identifier. Length bounds, ASCII structure and control-character rejection remain. URLs, extra slash/traversal segments, query strings, backslashes and newline forms are rejected. The runtime still selects a model only from validated registry destinations; a namespaced model ID does not choose an endpoint or grant permission.

The Abacus preparation file uses a fixed RouteLLM Chat Completions endpoint and fixed `gpt-6-luna` model, with the existing server-only `AI_HOSTED_KEY` and credential keyring contract. It explicitly keeps `AI_ENABLED=false`, requires operator-reviewed notices/pricing/budgets and synthetic live smoke gates, and includes invalid/unapproved pricing placeholders rather than fabricated approved prices. The unmodified configuration validator fails closed until those values validate and funding is explicitly available. No secret value is present in the public template, and no automatic provider/router selection or silent fallback is added.

Synthetic hosted/BYOK tests verify the same existing bounded tool-free transport: fixed endpoint/model, configured output limit, no redirects, no tools/router parameters, bounded reservation rejection before fetch, and exact usage mapping. These tests use mocked fetch and synthetic approvals. They establish local request behavior, not provider acceptance or approved data terms. Template notices correctly flag Abacus/upstream processing and provider-managed failover for operator review; they do not justify enabling an undisclosed fallback destination.

Production extraction logic, quotas, consent and financial validation are unchanged by the reviewed model-identifier delta. Choosing this preparation template cannot itself authorize mailbox reads, create an import, contact a model or write ledger charges.

## Actual evidence inspected

- `/tmp/invoxim-ai-cloudflare-green-v1.txt`: 89 tests passing across 6 files, 13.64 seconds.
- `/tmp/invoxim-abacus-drive-green-v1.txt`: 22 tests passing across 4 files, 11.45 seconds. The reviewed AI subset comprises 4 Abacus cases and 11 namespaced-model/transport cases; unrelated Drive cases contribute to the aggregate, not this AI approval.

This reviewer inspected raw runner output and test assertions; it did not execute suites or independently capture their process exit codes. Read-only diff/source/artifact reads were executed. No live connection, real model call, cost/latency benchmark, independent provider documentation/capability verification or real extraction quality is claimed. The reviewed provider values are preparation inputs, not a recommendation or independently verified statement of current availability.

## Remaining gates

Root owns final static/build/release and any explicitly authorized deployment work. Before activation, independently verify selected model availability/capabilities, Abacus and upstream processing/failover terms, exact approved pricing, parser disclosure, server secret/budget configuration and synthetic bounded live smoke/evaluations. Free availability or synthetic protocol success is not production quality evidence. Preserve explicit user processing consent and chosen destinations; no fallback or new scope is authorized by this review.
