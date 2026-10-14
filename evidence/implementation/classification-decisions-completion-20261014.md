# Classification decisions completion report

Task: assigned classification_decisions slice; CLEF-ACCURACY-02 follow-up in isolated worktree /home/geek/.codex/worktrees/invoice-classification-improvements/invoxim, base cd6a990. Status: ready for independent review and parent integration. No commit/index/backlog operations performed by this agent.

## Implemented behavior
- Mandatory single Clef request now asks receipt decision, explicit document type, and category. Financial choices invoice/receipt/credit-note/completed-refund; nonfinancial order/delivery/marketing; unknown stays explicit. Both choice distributions validate known keys, finite bounded values, normalized sum and highest-probability chosen value. Code policy version document-type-classification-v4.
- Candidate requires receipt and chosen financial type probabilities at the existing configured positive threshold (default .9). Low receipt plus financial type and high receipt plus nonfinancial type are uncertainty. Clear nonfinancial type at the positive threshold can skip intermediate receipt scores. Existing low negative scores still skip absent contradictory financial type. These are routing policies, not measured accuracy.
- Optional uncertainAction review|extract defaults review. Only valid Clef needs-review/uncertain can use extract, then existing durable continuation, selected hosted/BYOK extractor, atomic metering, one-attempt budget, caches and fences. No fallback, retry infrastructure or additional provider.
- Final financial document validation applies after extraction, to accepted caches and before durable reconcile. Orders/unknown/cancellations/statements cannot create purchases. Empty non-purchase is allowed; refund documents require completed refund evidence. Existing amount/date/payment validation remains in force; invoice classification itself provides no financial facts.
- Original selected-text parser identity recognized; truly truncated bodies stop in text_limit review, independent readable attachments continue. Byte metadata removes only generated selected-v2 span suffix and deduplicates original parts; opaque original IDs preserved.
- HTTP accepts inert null tool_calls/function_call while continuing to reject actual tool content. Explicit root-shape/nonpurchase prompt guidance added; parent versions prompt v6. No JSON salvage or money coercion. Zod schema already required nullable inference references, so the suspected optional-field pitfall was not reproduced or changed.
- Redacted extraction diagnostics distinguish invalid-json/invalid-shape/invalid-schema with bounded schema issue codes only. No values/paths/transcripts enter diagnostics.
- Existing offline evaluator reuses document-aware routing for live-stub results, threshold analysis and freeze validation; saved synthetic document-type answer retained. No new framework/corpus or real calls.

## Changed files
packages/adapters/src/ai/{clef-protocol,clef,http,classifier-factory}.ts
packages/adapters/src/pipeline/{service,types}.ts
packages/core/src/ai/{engine,validation}.ts
packages/core/src/index.ts
packages/core/test/ai-model-validation.test.ts
apps/worker/test/{clef-pipeline,clef-classifier,ai-schema-prompt,per-document-classification,direct-model-pipeline,direct-model-native-headroom,outlook-runtime,negative-classification-attachment}.test.ts
apps/worker/test/classification-fixture.ts
tools/implementation/clef-eval{,.test}.mjs

## Evidence actually executed
RED: pnpm --filter @invoxim/worker exec vitest run test/clef-classifier.test.ts => exit1, 2 intended failures/11 pass: missing explicit type and contradictory distributions accepted. /tmp/invoxim-classification-types-red.log
RED: same native command with test/clef-classifier.test.ts test/clef-pipeline.test.ts => exit1; valid uncertainty lacked continuation. One independent test setup failure was corrected later. /tmp/invoxim-classification-routing-red.log
RED: native test/ai-schema-prompt.test.ts => exit1, 2 failures/6 pass: inert null tool fields rejected and explicit root contract absent. /tmp/invoxim-classification-envelope-red.log
GREEN: pnpm --filter @invoxim/worker exec vitest run test/clef-pipeline.test.ts test/clef-classifier.test.ts test/ai-schema-prompt.test.ts test/per-document-classification.test.ts test/direct-model-pipeline.test.ts test/direct-model-native-headroom.test.ts test/outlook-runtime.test.ts test/negative-classification-attachment.test.ts => exit0, 8 files/115 tests. /tmp/invoxim-classification-native-final.log
GREEN: pnpm --filter @invoxim/core exec vitest run test/ai-engine.test.ts test/ai-model-validation.test.ts test/ai-validation.test.ts test/ai-adversarial.test.ts => exit0, 4 files/85 tests. /tmp/invoxim-classification-core-final.log
GREEN: node --test tools/implementation/clef-eval.test.mjs => exit0, 15 tests, all transport synthetic. /tmp/invoxim-classification-eval-final.log
Types: pnpm --filter @invoxim/worker typecheck => exit0. /tmp/invoxim-classification-worker-types-final.log
Scoped ESLint => exit0. /tmp/invoxim-classification-lint-final.log
Prettier check all 21 owned files => exit0. /tmp/invoxim-classification-format-final.log
Git diff --check => exit0.

Acceptance coverage: CLEF-TYPE, CLEF-UNCERTAIN, CLEF-VERIFY, AI-ENVELOPE, AI-PROMPT, AI-SCHEMA plus established CLEF-01/AI-CLEF-PRECISION-01, per-document and native shared-forty-SQL cases. Native tests cover selected BYOK/hosted, settings/consent/stale lease, exhausted budget, missing usage, paid caches/replay, seeded accepted order at .45/.99, queued reconcile cache, truly truncated body with separately processed PDF and actual purchase.

## Effects and limitations
No schema/migration, dependency, credentials, permission, processor or deployment changes by this agent. No production writes or live models/evaluations. Classification adds a question in its existing call; opted-in uncertainty can consume one existing selected-provider extraction call and normal budget. Existing conservative missing-usage reservation retained.
Context7 tools unavailable; current official Clef input/output schema URLs were read and confirm typed choice/highest-option/sum-one semantics. Existing endpoint capability declarations retained; no PDF/image inference capability claimed.
Raw production schema-failure response unavailable; exact production cause remains unknown. Synthetic tests establish behavior, not real-model accuracy. Truly lossy oversized bodies remain review-only; complete visible HTML reductions may proceed. Existing already-committed financial facts are not deleted or re-billed.
Parent owns config/notice/prompt version/backlog/docs, full pnpm verify, commit and delivery. Independent reviewer classification_review has re-reviewed source and awaits final evidence; independent final verdict not claimed here.
