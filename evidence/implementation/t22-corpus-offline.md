# T22 synthetic corpus and offline application conformance

Status: local corpus/harness ready for independent review. T22 live model selection, privacy/capability approval and real model evaluation remain pending. This report does not close T16, Gate B, M1, deployment or model-quality gates.

## Authored artifacts and frozen identity

`packages/testkit/src/extraction-corpus/` contains original synthetic text and preset candidate JSON, deterministic inert HTML/structured-MIME representations, literal independent expected financial events, generators, corpus contract/catalog, metrics, binary assets and immutable hashes. `packages/core/test/extraction-eval.test.ts` is the executable pure-unit harness. No production prompt, template, adapter, extraction contract or settings were changed. Root added a minimal private `@invoxim/testkit` ESM package manifest with no dependencies because the boundary collector requires a manifest for every package directory; this implementer inspected the manifest and the allowed testkit-to-core/contracts graph. Lockfile synchronization and final repository-wide boundary verification remain root integration work.

The fixed version is **t22-synthetic-v1**, 120 unique case IDs across 40 documented families: **80 development / 40 holdout**. Monetary expected minor units/directions are explicit literal labels, never calculated by production money/extraction code. The harness invokes the actual core MIME/text/HTML parser, deterministic extraction validator and ledger planner, and checks replays for zero additional events. Preset refusal/truncation states are controlled fixture responses, not observed model behavior. No real provider is invoked.

The partition and every case hash were frozen before first holdout evaluation; tests verify compact UTF-8 JSON content hashes. The authoring/freezing scripts refuse to replace a changed frozen version. Manifest:

- Development SHA-256: `ce0090f848c3e8522d9ce1a27a0739b6fedcf905c7a11dfe0a093c55a9b93824`.
- Holdout SHA-256: `73bf120345e79a4f72e39152c0b71777e6e1de905c554a6274a54f1bd3f5808b`.
- All case and asset hashes: `packages/testkit/src/extraction-corpus/manifest.json`.

No held-out outcome was used to alter production prompts/templates or expected cash. The holdout consists of near-template representation/evidence variants across the same 40 semantic families; it is not a broadly independent real-world accuracy sample. Three variants vary actual plain/HTML/MIME representation, source-line semantics, language/date/currency precision, malicious response shape or binary capability. They are not merchant/amount-only copies. Original blank image assets prove unsupported format handling, not receipt OCR.

## Actual results and denominators

| Partition   | Preset supported-clean accepted | Challenge review | Parser-blocked challenges | Incorrect financial outcomes | False cash cases |
| ----------- | ------------------------------: | ---------------: | ------------------------: | ---------------------------: | ---------------: |
| Development |                         44 / 44 |          32 / 36 |                    4 / 36 |                       0 / 80 |           0 / 80 |
| Holdout     |                         22 / 22 |          16 / 18 |                    2 / 18 |                       0 / 40 |           0 / 40 |

All 120 exact literal event projections and replay assertions matched. There were zero missing expected cash cases. One preset truncation belongs to development and one preset refusal to holdout; these are included in reviewed challenge counts. Fetch is replaced by a throwing guard during corpus cases and is never called. Actual provider requests/cost: **0 / 0**.

These denominators describe **preset-candidate application conformance**, not inference accuracy, autoaccept coverage from a real model, candidate recall, category macro F1, calibrated confidence, billing efficiency or latency. A prepared ideal candidate passing validators is not evidence that a model can produce it.

Families include EN/DE and decimal commas; JPY zero/EUR two/KWD three-decimal precision; unpaid/unknown invoices/orders; installments/mixed credit; pending/matched/unmatched refunds; credit notes/cancellations/statements/non-purchase; references/content replays; subtotal/tax/currency/date/sign/negation conflicts; missing candidate facts; injected content/schema authority; malformed/fenced/truncated/refused output; inert tracking resources; structured MIME; and image/PDF capability boundaries. Additional pure tests exercise malformed duplicate MIME identities and text-limit truncation with no partial evidence. This uses the existing structured-MIME input contract, not a new raw RFC mail parser.

## Executed evidence

- Harness RED: `pnpm --filter @invoxim/core exec vitest run test/extraction-eval.test.ts`, exit 1, intended clean receipt/parser/ledger behavior missing in initial stub. `t22-harness-red.txt`.
- Harness GREEN: same command, exit 0. `t22-harness-green.txt`.
- Metrics RED/GREEN: distinguish missing expected cash from fabricated cash, genuine failure then pass. `t22-metrics-red.txt`, `t22-metrics-green.txt`.
- Development materialization diagnostic: 4 preset-reference authoring failures (quotes omitted their reference label) among 81 checks; corrected candidate evidence before freezing/evaluating holdout, no production/oracle change. `t22-development-first-check.txt`, `t22-development-final.txt`.
- Final offline command: `pnpm --filter @invoxim/core exec vitest run test/extraction-eval.test.ts --silent=false`, exit 0, **126 tests = 120 unique corpus cases + 6 harness/hash/metrics/parser checks**. `t22-final-offline.txt` contains exact aggregate results.
- Root public-command verification: `pnpm run test:eval:offline` now invokes the real focused Vitest file with visible aggregate results; root executed it successfully, **126 tests passed**, raw evidence `t22-root-offline-command-20261013.txt` inspected by this implementer. This is actual application conformance, not a fixture-count stub.
- Independent QA native parser execution: assigned worker corpus test, **5 tests passed**, exit 0 reported by QA and raw `t22-qa-corpus-native-first.txt` inspected. It hashes the exact binary assets, checks both actual PDF pages and literal 10000/2000/12000 numeric units, concrete compressed/textless review codes, valid PNG/JPEG unsupported results, and no fetch calls. No native tests were executed by this implementer.
- Scoped Biome, ESLint, Prettier, core typecheck and core build: each observed exit 0. `t22-{biome,eslint,format,typecheck,build}.txt`. No Biome diagnostics.
- Independent reviewer P2 multiset repair: membership-only metrics missed duplicate cash surplus/deficit. Actual `t22-metrics-multiset-red.txt` recorded two intended failures; `t22-metrics-multiset-green.txt` records **129 passing tests = 120 frozen corpus cases + 9 harness/metrics/parser checks**. Counts now compare exact `(kind, currency, amountMinor)` event multiplicities. A reordered projection still has no surplus/deficit while retaining the existing order-sensitive exact-projection check. Corpus data, IDs, partition/case/asset hashes and production code are unchanged. Scoped Biome/ESLint/Prettier/typecheck/build all observed exit 0 in `t22-metrics-multiset-*.txt`.
- Dataset freeze record: `t22-dataset-freeze.txt`.

## Binary evidence and remaining gates

Original valid clean two-page uncompressed PDF: `assets/clean-two-page.pdf`, with a literal sidecar specifying page-1 subtotal EUR 100/tax EUR 20 and final-page total/payment EUR 120 (minor units 10000/2000/12000). Original valid image-only PDF, actual deflate-compressed PDF, and valid tiny PNG/JPEG assets are included. QA separately generated/decoded the assigned `probe.png`/`probe.jpg`; those two files were not edited by this implementer. Their exact hashes are frozen in the manifest.

Core corpus PDF cases have no PDF port enabled and correctly stop at review; they do not certify the native PDF converter. The QA broker executed concrete workerd PDF fidelity/preflight tests in `apps/worker/test/extraction-corpus.test.ts`: **5/5 passed**, with exact-asset SHA validation, actual final-page numeric preservation, compressed/textless review states and image unsupported states. Evidence is separate in `t22-qa-corpus-native-first.txt`. This local parser result does not certify live inference or real OCR. The encrypted fixture is an explicit feature-marker challenge, not a cryptographically encrypted corpus or encryption smoke. Actual encrypted/scanned receipt coverage and real OCR remain limited/pending; no native image caption was substituted for numeric evidence.

Required manual/live work remains: approve actual parser/inference destination/privacy terms, configured endpoint/model/capabilities and credentials; record explicit live evaluation authorization plus cost cap; run a separately labelled model evaluation with immutable data/version/parameters and financial correctness/coverage/category failures; inspect errors independently; then assess release thresholds. No live customer data, network services, provider costs, deployment, new dependencies or durable application data were introduced here.
