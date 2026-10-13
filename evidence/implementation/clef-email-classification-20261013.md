# CLEF-01 email classification refactor

Owner requested a fresh subagent refactor: one Cloudflare Clef query decides whether an email contains purchase evidence and suggests a category. Implementation is isolated from primary owner and frozen provider changes. Financial inference remains the separately selected Abacus/BYOK destination; classification cannot create financial facts.

## Acceptance and scope

- CLEF-01: one bounded typed `noul` + `choice` provider request, validated model/probabilities, conservative negative decision and existing category taxonomy.
- CLEF-02: direct file configuration, AI binding, processor disclosure and consent digest changes; missing binding fails closed. No generated Wrangler AI registry or new credential.
- CLEF-03: real D1 accounting, cache/replay and per-source attachment behavior under the shared 40-statement invocation cap. Negative classification skips financial inference only when all source documents are readable and unchanged. Hosted classification is funded separately from BYOK financial extraction while sharing the existing USD/token caps and avoiding double document counting.

No migration or new queue/stage/resource is required beyond the Workers AI binding. Existing infer continuations carry the classifier cache key; result persistence contains only classification fields, never raw state or model transcripts.

## Evidence so far

- RED adapter stub: three intended behavior failures, exit 1, 820 ms; `/tmp/invoxim-clef-red.txt`.
- RED configuration/consent: two intended failures and one control passed, exit 1, 1.65 s; `/tmp/invoxim-clef-configuration-red.txt`.
- Initial classifier/configuration GREEN: six tests/two files, exit 0, 2.46 s.
- Initial native GREEN: eight tests/two files, exit 0, 2.65 s.
- Focused native/regression GREEN: 87 tests/eight files, exit 0, 18.05 s; `/tmp/invoxim-clef-focused-green.txt`.
- Typecheck: five tasks successful, exit 0, 7.661 s; `/tmp/invoxim-clef-types-final.txt`.
- Independent review has inspected the actual source. Wrong-model and changed/unreadable sibling guards were repaired. Final focused GREEN: 118 tests/nine files, exit 0, 19.62 s; `/tmp/invoxim-clef-final-focused.txt`. This includes persisted Clef category, cached replay preserving a manual override, hosted classifier costs with BYOK, lease/consent guards and malformed authority refusal. Full verification and final review remain pending.

## Rollout checklist

- [x] Final behavioral and repository verification.
- [x] Final independent review and recoverable commits.
- [ ] Deploy Worker and frontend together when authorized.
- [ ] New processing review/Start approval includes Cloudflare classification; prior consent cannot authorize the new processor.
- [ ] Separate live synthetic Clef quality/latency/cost smoke; deterministic mocks do not prove accuracy.

No deployment or live private-email Clef calls were performed for this refactor.

Rollout recovery review: existing `jobs/onboarding-recovery.ts` rebinds unpaid parse/infer/discovery jobs after renewed consent. Old paid infer/reconcile stages with a changed processing digest remain paused with cache-review-required; existing discovery dedupe does not recreate completed source jobs. This refactor does not automatically rebill/reclassify those historical sources.

Initial complete integration run passed 1396/1398 tests; two manually configured route fixtures lacked the new binding/explicit classification opt-out. Fixture correction GREEN: 24 tests/two files, exit 0, 10.27 seconds; `/tmp/invoxim-clef-route-fixtures-green.txt`. Final full verification remains pending.

Recovery P1 follow-up: two native unchanged-consent renewal cases initially failed with cache-review-required (exit 1, 1.93 s), then passed (exit 0, 1.98 s). Final focused suite: 173 tests/14 files passed, exit 0, 31.14 s; `/tmp/invoxim-clef-recovery-final-green.txt`. This includes all six renewal variants: completed classifier cache, complete financial cache, changed financial policy, unfinished classifier attempt, malformed completed cache and overrun. Recovery excludes only validated, completed, known/uncertain classification from the financial paid-work fence; current consent and authority remain checked. Classifier cache identity binds configuration and complete source/parser identity while remaining stable across unchanged consent renewal. Shared composition preserves the existing content-factory port.

## Final implementation verification

`pnpm verify` completed with exit 0 in the isolated source checkout. 1404 native Worker tests across 115 files, 379 core tests, 48 contract tests and 84 browser tests passed, together with boundary, secret/dependency policy, format/Biome/ESLint, types, builds and production publication guard. Log: `/tmp/invoxim-clef-final-complete-verify.txt`; root terminal 51113. Independent read-only review approved checkpoint 0377e87 and inspected the final focused recovery evidence.

The implementation gates are complete. Deployment, renewed processing consent and separately measured live-model quality remain operator rollout gates; no private-email Clef call or production deployment was performed.
