# @invoxim/testkit

Test-only synthetic helpers and fixtures shared by the core, contracts and Worker test suites (QA-5). Nothing here is production code: every value is synthetic, and no test helper calls a real provider.

## What it exports

`package.json` declares these entry points, all TypeScript source (there is no build step; the package only has a `typecheck` script):

| Entry point                    | Source                              | Contents                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`                            | `src/index.ts`                      | Re-exports the fetch, fixture, Google token and PDF helpers below                                                                                                                                                                                                                                                                           |
| `./fixture-value`              | `src/fixture-value.ts`              | `requireFixture(value)`: returns the value or throws when a required synthetic fixture is `null`/`undefined`                                                                                                                                                                                                                                |
| `./fetch-spy`                  | `src/fetch-spy.ts`                  | Pure fetch plumbing: `createRoutedFetch(routes, { calls, onUnexpected })` routes by exact URL and optional method and throws on any unexpected destination; `urlRoute`, `requestUrl`, `requestMethod`; `bytesFromInlineAsset` decodes a Vite `?inline` data URL. Callers install the handler with their own `vi.spyOn(globalThis, "fetch")` |
| `./google-token`               | `src/google-token.ts`               | Google endpoint constants, `googleTokenResponse`, `googleTokenRoute`, `encodeJwtPart`, `generateSigningKeys` (a correct and a wrong RSA pair), `signIdToken` (RS256, optionally returning a JWKS), `googleIdTokenClaims`, `SYNTHETIC_RSA_PARAMS`                                                                                            |
| `./pdf`                        | `src/pdf/index.ts`                  | Generated synthetic PDFs: text, image-only, compressed-text, linked-invoice, secondary-xref, object-heavy, length-decoy and gate-regression generators, plus `nestedCatalogPdf` and `embeddedInvoicePdf` (a checked-in Ghostscript-generated asset)                                                                                         |
| `./extraction-corpus/evaluate` | `src/extraction-corpus/evaluate.ts` | `evaluateOfflineCase`, which runs one corpus case through `@invoxim/core` document extraction, validation and ledger planning                                                                                                                                                                                                               |
| `./extraction-corpus/metrics`  | `src/extraction-corpus/metrics.ts`  | `summarizeOffline`                                                                                                                                                                                                                                                                                                                          |
| `./extraction-corpus/types`    | `src/extraction-corpus/types.ts`    | `CorpusCase`, `OfflineOutcome`, `OfflineSummary`                                                                                                                                                                                                                                                                                            |

`src/extraction-corpus/` also holds the offline extraction corpus: `development.json` (80 cases), `holdout.json` (40 cases), `manifest.json` (frozen partition, case and asset hashes), `CATALOG.md` (case families) and fixture `assets/`. `build-corpus.py` and `freeze-manifest.py` are the corpus authoring and freezing scripts; no `pnpm` script runs them. The corpus checks application conformance; it is not model output or model accuracy.

## How tests consume it

No workspace package declares `@invoxim/testkit` as a dependency. Tests import its source files by relative path from their own test directory, for example `../../../packages/testkit/src/google-token` from `apps/worker/test/` or `../../testkit/src/fixture-value` from `packages/core/test/`. Assets are imported with Vite's `?inline` suffix and decoded with `bytesFromInlineAsset`.

Main consumers:

- `apps/worker/test/`: auth, OAuth nonce, mailbox, Outlook, Drive, PDF processing and extraction-corpus suites.
- `packages/core/test/`: `extraction-eval.test.ts` (run by `pnpm test:eval:offline`), money, financial-fixture and presentation-oracle suites, and `testkit-helpers.test.ts`, which tests the shared helpers themselves.
- `packages/contracts/test/contracts.test.ts`.

## Production guards

- `pnpm check:boundaries` allows testkit to depend only on core and contracts, and no other layer may depend on testkit. Declared `devDependencies` count, which is why tests use relative imports; test directories are not boundary-scanned.
- `pnpm check:production` rejects `@invoxim/testkit` and any `packages/testkit/` module input in the web, Pages Function and Worker bundle inventories.
- `pnpm check:secrets` scans testkit but allows assignment values prefixed `synthetic-`, `qa-` or `fake-` under `testkit/`; real credential signatures are still reported.
