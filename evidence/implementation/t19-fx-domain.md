# T19 pure historical FX domain handoff

Status: **review**, bounded local synthetic M1 domain increment. This does not complete T19 or waive the T16 live gate. The orchestrator's local dependency decision is recorded in `m1-local-dependency-decision.md`.

Owned files: `packages/contracts/src/fx.ts`, `packages/core/src/fx/types.ts`, `packages/core/src/fx/conversion.ts`, `packages/core/test/fx.test.ts`. Exact source hashes are in `t19-fx-domain-sha256.txt`. Root separately owns public barrels and the extraction of the existing, unchanged arithmetic into `packages/core/src/money-conversion.ts`.

## Interfaces and implemented rules

- `convertFxEntry(entry: FxEntry, reportingCurrency: string, quote: FxRateQuote | null, policy: FxConversionPolicy): FxConversionResult` validates canonical original magnitude (0..9000000000000), Gregorian dates 0001..9999, reviewed currency precision, and explicit source/maximum prior age policy (0..31 days). Unsupported currencies, including unsupported same-currency identity, remain unconverted. Supported identity requires no quote and retains exact signed integer magnitude.
- A reference quote includes from/to currency, requested event date, effective reference date, exact positive decimal, source, snapshot version, and safe integer UTC millisecond retrieval time. Pair/date/source mismatches, future/stale/missing/invalid quotes remain unconverted with original facts. No fallback, provider endpoint, SDK, environment selection, or inference is present in core.
- Exact conversion reuses the repository's `convertMinor`: integer/rational BigInt arithmetic with currency-specific scales and half-away-from-zero rounding once per entry. Refund direction is negative; rounded zero is canonical `0`. Converted magnitude is capped symmetrically at 9223372036854775807. Overflow remains unconverted, without altering the original entry.
- `sumFxConversions(reportingCurrency: string, results: readonly FxConversionResult[]): FxConversionSummary` sums already-rounded values using BigInt, preserves unconverted entries, and rejects duplicate entry IDs, mixed reporting targets, malformed provenance, forged reference arithmetic, or more than 1000 entries. Aggregate output is a canonical signed decimal string bounded below 48 digits. It consumes valuations already admitted by the configured conversion policy; its schema is not a substitute for policy admission, tenant authority, or repository snapshot validation.
- `PublicReferenceRateReader.lookup(request: FxRateRequest): Promise<FxRateQuote | null>` is the narrow public-reference port. Its concrete server-selected adapter and bounded cache are the next layer. The core does not choose a vendor or search alternative providers. All resulting valuations carry calculation version `fx-v1`.

Shared strict Zod schemas and inferred types are exported in `fx.ts`. Original entry values and quote snapshots are copied through validation and preserved; changing reporting currency produces a separate valuation, without financial mutations.

## Actual verification

The initial shell redirection targeted a nonexistent relative evidence directory and exited 1 before executing tests. The next unit attempt, preserved in `t19-fx-domain-red.txt`, exited 1 because the public contracts barrel had not yet exported the new schemas. These are setup failures, **not behavioral RED evidence**.

After root published the barrel, the exact command `pnpm --filter @invoxim/core exec vitest run test/fx.test.ts > evidence/implementation/t19-fx-domain-behavior-red.txt 2>&1` exited **1** with 15 failed and 2 passed. The intended Friday/Sunday half-minor payment returned `rate_missing` instead of converted `1`; scale and unsuitable-quote reasons also failed. Original assertions were preserved. Reference conversion/provenance validation then passed the initial 17 tests (`t19-fx-domain-initial-green.txt`). Expanded coverage passed 28 (`t19-fx-domain-expanded.txt`).

The final owned test command `pnpm --filter @invoxim/core exec vitest run test/fx.test.ts > evidence/implementation/t19-fx-domain-green.txt 2>&1` passed **35/35**, exit 0, 343ms. Final independent commands and actual exit codes are recorded in `t19-fx-domain-final-checks.txt`:

| Command                                                                                                                     | Observed result                 |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `pnpm --filter @invoxim/core exec vitest run test/fx.test.ts test/money.test.ts`                                            | 45/45, two files, exit 0, 422ms |
| `pnpm --filter @invoxim/core typecheck`                                                                                     | exit 0                          |
| `pnpm --filter @invoxim/contracts typecheck`                                                                                | exit 0                          |
| `pnpm exec eslint packages/contracts/src/fx.ts packages/core/src/fx packages/core/test/fx.test.ts`                          | exit 0                          |
| `pnpm exec biome check packages/contracts/src/fx.ts packages/core/src/fx packages/core/test/fx.test.ts --error-on-warnings` | exit 0, no fixes                |
| `pnpm exec prettier --check packages/contracts/src/fx.ts packages/core/src/fx packages/core/test/fx.test.ts`                | exit 0                          |

The earlier core typecheck (`t19-fx-domain-typecheck.txt`) exited 2 because root's helper extraction briefly left the existing `priceChange` reference to `roundRatio` unresolved; root repaired that shared file before the final successful checks. Contracts typecheck passed throughout. No native/browser/D1/model/provider/deployment test was run by this increment. Full workspace verify/build and independent review are orchestrator integration work, not claimed here.

Exact hand oracles cover JPY0/KWD3/EUR2 scales, positive/negative ties, separately rounded sums, original/refund event dates with different snapshots, valid identity for all six currently reviewed currencies, stale/future/mismatched/invalid rates, leap-century and early-year date ages, 0/31-day policies, original preservation, individual overflow, aggregate beyond both JavaScript safe integers and SQLite Int64, repeated IDs and mixed targets. A deterministic fast-check property (seed1903, 200 cases) compares half-rate integer hand oracles and sign reflection.

Acceptance proof scope: **FX-01** validates supplied prior snapshot dates/age/provenance; latest eligible snapshot selection/persistence remains adapter work. **FX-02/03/04** establish pure unsupported/missing handling, per-entry rounding, and refund-date arithmetic. **FX-05** establishes original preservation and separate versioned target valuations; jobs, pending coverage and preference race persistence remain unimplemented. List/summary/export equality is not proved by this pure module.

## Effects and next integration

No schema migration, persistent storage, network destination, credentials, tenant read/write, recurring inference, or paid service is introduced. Public reference data is the only intended external port content. Unconverted results retain truthful original facts; converted totals exclude those entries and expose their missing coverage rather than inventing rate 1. Typed input errors contain a safe generic code, without dumping entry or provider content.

The next adapter/repository layer must select the latest preceding eligible quote from the explicitly configured source, persist immutable public snapshots, derive tenant context from the verified session, and bind valuations to owned event inputs/version and reporting currency/calculation version. Corrections or preference changes must invalidate/recompute the appropriate valuation without modifying original money. Bounded pagination and coverage must share list/summary/export inclusion semantics. None of those boundaries, or real Frankfurter availability, is demonstrated by these tests.

Context7 was not available in the callable tool inventory. Existing repository Zod patterns and local pinned types were used; official Zod refinement documentation was checked as fallback at https://zod.dev/api?id=refinements. No dependency changes were made.

Independent review: pending orchestrator assignment. No live approval is inferred from synthetic domain tests.
