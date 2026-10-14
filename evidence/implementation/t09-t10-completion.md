# T09/T10 and mandatory Biome verification completion

Status: **done for the bounded internal discovery/parser increment and verification repairs**. Full M0 and release readiness remain incomplete. Root integrates separate implementer, independent QA and read-only review work. No Git commit or deployment was created.

Frozen implementation identity: 161-file manifest SHA-256 `26a0ec4fb234a12d8f1ef75e3c073010c96daeb1ac6a5ea76a62fbecd5277340`; [zero source differences](t09-t10-qa-source-match.txt). Exact pins remain Node24.21.0, pnpm12.6.0, TypeScript6.0.3, Vitest5.0.3, Wrangler4.149.0; new adapters/checker pin unpdf1.8.1 and Biome2.5.15. Context7 was unavailable; primary documentation and exact installed source/types were used, with actual CLI/workerd evidence.

## Implemented

T09 discovers metadata/source references through accepted-consent/generation/readiness fences, a frozen full calendar range and recent-first slices, an independent live history cursor, bounded dense-history buffers, atomic D1 page/job commits, scoped idempotency and honest parent progress. Provider delays, expired history, unavailable messages and crash/replay are handled without counting pending extraction as completed processing. The Worker uses one background-invocation D1 budget for jobs, credential reads/refresh and discovery. Unsupported mode changes and active pagination/recovery range transitions reject before provider work and preserve durable state; idle synchronization follows the latest approved start.

T10 normalizes supplied structured MIME/Gmail bytes, preserves exact original hashes/part IDs and extracts bounded inert text. Actual local PDF parsing supports a conservative uncompressed text-layer subset. Unsupported images/compressed/encrypted/active/textless content require review. Strict base64/signature checks, raw array preflight, nested/quoted hidden HTML and aggregate incomplete-output rejection preserve its evidence boundaries.

Biome is mandatory in `pnpm verify` and CI, checking source and tests with warnings treated as failure. Guard-preserving repairs resolve the initial 192 errors/17 warnings/13 infos; explicit null checks and an exact ASCII control predicate retain behavior. Prettier and ESLint remain enabled. Actual negative test fixtures and script/config/path regression checks prevent accidental gate omission. Editor workspace settings align the root flat ESLint config and recommend the installed tooling. Accessible demo controls use native buttons/fieldset labels and preserve the tested local-only interactions.

Shared/root changes: package/lock/Biome/CI/editor configuration, implementation policy documentation and tests, adapter/core exports, production null/control guards, Worker shared counter/composition/default variables, configuration documentation and semantic demo controls. Writer/QA file inventories and precise ownership are in [handoff](t09-t10-handoff.md), [T09 implementer](t09-implementer-completion.md), [T10 implementer](t10-implementer-report.md) and [QA](t09-t10-qa.md).

## Actual verification

- `pnpm install --frozen-lockfile`: exit0 in a new copied source with lifecycle-script policy retained; [install](t09-t10-qa-frozen-install.txt).
- `pnpm verify`: exit0, boundaries/format/Biome/ESLint/types/unit/integration/build/E2E; [full log](t09-t10-qa-verify.txt). **306 fresh distinct tests, no skips**: 10 tooling,39 core,40 contracts,210 workerd,7 browser. Core includes1,500 seeded property samples, not1,500 additional test cases. All five typechecks ran freshly; dependency build results were reused only within that same run.
- `pnpm db:check`: exit0,20 real D1 migration/integrity cases already included in210 runtime cases; [log](t09-t10-qa-db-check.txt). All eight migration files were in the frozen source.
- Whole root workspace `pnpm lint:biome`: exit0,162 checked files/no diagnostics; [log](biome-all-final.txt). The copied implementation gate checked134 files; it does not replace the broader root scan.
- Root `pnpm format:check`: exit0; [log](biome-format-final.txt).
- After recording completed backlog status, `python3 tools/validate_blueprint.py --require-schema`: exit0; [specification validation](t09-t10-blueprint-validation.txt). This validates the specification/status graph and is not an application or live-provider test.
- Independent native queue/factory/discovery proof:34 total D1 statements under the unchanged40 limit, actual ACK, one staged reference and exact continuation. No claim of production CPU/cost viability.
- [Independent review](t09-t10-review.md): approved by separate read-only `/root/discovery_review`, no unresolved required source finding. QA-authored old test repairs received separate review; QA does not independently certify its own changes.

Genuine RED/GREEN evidence for all required findings is linked in the implementer/QA reports. Initial temporary-stdin, fixture-authoring and pre-mode301-case results remain explicitly diagnostic; the renewed frozen run controls completion. GMAIL-01–08, RECENT discovery cases and DOCUMENT-01–06 are exercised within the stated scope; full financial dedupe, public first-result latency and real provider behavior are not inferred from mocks.

## Effects and remaining work

Migration0008 adds scoped discovery/slice/source-reference state and indexes; clean D1 execution is verified locally. No production migration was applied. Discovery retains identifiers/cursor buffers/projected metadata only; originals, full extracted text and model transcripts are not newly persisted. No R2, hosted converter, OCR, provider fallback, new cloud resource, paid operation, broadened OAuth permission or third-party upload was added.

Default auth/Gmail/discovery/jobs flags remain false and processing readiness refuses import. Public Review/Start/progress and Home integration remain T29/T13; source content processing, validated AI extraction and financial acceptance/dedupe remain T11/T12. AI/external services must continue through provider-neutral ports selected by validated server environment/Wrangler variables/secrets, with explicit destination approval and no silent fallback. This increment does not choose a live model or fabricate inference quality.

Live Google/provider/model/deployment smoke tests, full PDF/OCR/rawRFC support, operational CPU/memory/Free-plan viability, security/eval/scanner/release gates and editor-extension startup remain unverified or later work. CLI/editor configuration checks do not prove an actual editor restart. The next dependency-ready implementation is bounded T11 extraction/validation/evaluations, followed by T12 financial projection/deduplication and the explicit Start/Home journey.
