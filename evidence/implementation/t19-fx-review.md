# Independent T19 FX domain review

Task: T19, M1 pure historical FX domain increment. Reviewer: /root/database, separate agent from the implementation writer. Assignment read-only; only this evidence report was written.

## Scope and identity

Inspected packages/contracts/src/fx.ts, packages/core/src/fx/types.ts, packages/core/src/fx/conversion.ts, packages/core/src/money-conversion.ts, the core index helper import/re-export, packages/core/test/fx.test.ts, docs/03-data-model.md FX rules, T19 backlog scope and acceptance FX-01 through FX-05. Inspected t19-fx-domain.md, behavioral RED, final GREEN, final check logs and source manifest.

Current source hashes match the supplied domain manifest:

- contracts/fx.ts: 97ebcfb6b9ca9becfc9a6790d699acc73eb7708eee7dc50d77f4e14af88477a4
- core/fx/types.ts: 09a6397a9432b8bb3c27af069bc6695d5c568e5290b4d2df4ad42594827fae4f
- core/fx/conversion.ts: f1e2f90b3c494dfa58046e02aa2bbedc01c11b780cdbae789535433285716abc
- core/test/fx.test.ts: 88b081cb7adde6bebb3ac53f7c6107c0f9e36cd9454ae81290891eb189633f06
- extracted money-conversion.ts inspected separately: df19a047c2a250338341284fb0a9b767e1b1e1e485fe8eed698ae19661745671

Reviewer execution consisted of file reads, targeted rg searches, read-only git diff and sha256sum. No tests, typecheck, build, database, provider, browser, migration or network command was executed by this reviewer. Implementer evidence is not represented as independently executed testing.

## Findings

No required correctness finding in the assigned pure domain scope.

Reviewed financial behavior: canonical nonnegative original minor magnitudes are bounded at9e12; refund direction is applied once. Supported currency scale is validated before identity/reference conversion. The extracted arithmetic computes an exact integer ratio and half-away-from-zero signed rounding with a strictly positive denominator produced by validated rate/scales. Conversion rounds once per ledger entry; aggregation adds already-rounded BigInt values. Individual outputs are symmetrically bounded below SQLite Int64 overflow, while sums remain decimal text rather than JavaScript numbers. Zero refund remains canonical0. Identity conversion neither needs nor invents a quote.

Reviewed date/policy behavior: date-only Gregorian validation rejects year0000 and impossible leap/calendar dates; UTC ISO parsing retains early years0001..0099 rather than Date.UTC's1900 remapping. Quote pair and requested date must match the entry/target. Explicit configured source must match; future effective dates and excessive prior age produce unconverted reasons. Policy age0..31 is explicit, with no default selection. Missing/unsupported/stale inputs retain original facts and never become rate1. A supplied quote's actual latest-eligible selection is intentionally outside this pure conversion function.

Reviewed forged result handling: aggregation rejects duplicate IDs, mixed targets, malformed magnitudes/signs, invalid identity provenance, missing/mismatched/future reference provenance and a numerically forged reference result by recomputing exact conversion. Input count is bounded1000. Original entries and quote snapshots pass through validation without mutation. Conversion-result schema and aggregate input are not an authority to admit a quote under a source/age policy: sumFxConversions intentionally consumes previously admitted valuations and has no policy argument. The handoff explicitly discloses this boundary; future persistence/read APIs must bind trusted owned event versions and policy-validated snapshots rather than accept client-supplied conversion results.

Reviewed evidence: the preserved behavioral RED log shows15 failed and2 passed with reference conversion missing, distinct from acknowledged setup/import failures. The final FX log shows35/35 passed; final regression log shows45/45 across FX and existing money tests. Final scoped core/contracts types, ESLint, Biome and Prettier logs report exit0. Hand-oracle and property tests cover 0/2/3 currency scales, signed ties, per-entry rounding, historical refund date, explicit0/31-day ages, early/leap-century dates, overflow, exact large totals, source/date mismatches and forged arithmetic. These are implementer-executed synthetic unit evidence; no independent runtime/provider proof is inferred.

## Decision

Approve the bounded pure domain/contracts increment for integration. Do not mark full T19 complete.

FX-02/03/04 pure arithmetic and missing/unsupported handling are supported by the inspected tests. FX-01 still needs concrete latest-preceding eligible rate selection and immutable source/date/exact-rate persistence. FX-05 still needs tenant preference/version races, fenced valuation jobs, pending coverage and original-preserving revaluation. List/summary/export inclusion equality is not implemented or proved here. Frankfurter v2 adapter, server source selection, bounded public cache, D1 ownership constraints, migrations and real provider availability remain unimplemented. T16/live-release prerequisites are neither executed nor waived by this review.

This increment introduces no persistence, credentials, destination choice, network request, original content retention or model/service charge. The public-reference port remains provider-neutral. Current reviewed currency support is explicitly the six existing currencyMinorDigits entries, not comprehensive ISO currency support. No broader financial overview or release-readiness claim is approved.
