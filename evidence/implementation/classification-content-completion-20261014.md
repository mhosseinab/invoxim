# AI-CLASSIFICATION-IMPROVEMENTS-03: content/PDF subtask

Status: review-ready; parent integration/commit/full gate remain parent-owned. Base cd6a990; working directory /home/geek/.codex/worktrees/invoice-classification-improvements/invoxim. No commit created by this implementer.

## Behavior and root causes

The direct-model document path counted original HTML markup and every body alternative against one 24,000-character message allowance. Crossing it returned no documents, discarding valid invoice attachments. Bodies and attachment text now have independent fixed 24,000-character allowances; PDF attachments still share a 20-page/24,000-character budget. Per-document PDF limits preserve previously complete independent documents.

Oversized bodies alone use documents-direct-selected-v2. Inert HTML tokenization exposes exact visible source ranges; hidden script/style/head/template/etc content and markup are omitted without rendering, network access, entity normalization, or joining separate source slices. If all visible content fits the allowance and 64 model parts, the document remains complete and usable. True omissions set ready-document truncated:true plus message needs_review/code:text_limit. The pipeline owner separately implements truncated-body review and cache/parser interpretation. Ordinary short body inputs retain documents-direct-v1 and byte-faithful alternatives.

Selection retains deterministic source-exact head/tail and an invoice-keyword-adjacent window; this is selection only, not local financial interpretation. Plain quoted lines are omitted only in the oversized path and count as truncation. UTF-16 excerpt boundaries preserve paired surrogates. Each selected span has its original provider part plus source offsets in its transient part identifier. Original whole-source bytes, length-framed grouped hashes and source identity remain unchanged.

PDF preflight previously rejected legal bare CR stream delimiters and passive nested catalog/page-tree dictionaries. They are now supported under unpdf-1.8.1/bounded-flate-v3. Stream dictionaries remain single-level and strict. Catalog authority is read only at depth one, and nested values retain a nonmatching placeholder to prevent malformed array/dictionary values from manufacturing scalar keys. Complete source still undergoes active-name, encryption, stream, object, compression, time and depth checks.

## Changed files

- packages/core/src/documents/body-selection.ts (new)
- packages/core/src/documents/extractor.ts
- packages/core/src/documents/html.ts
- packages/core/src/documents/types.ts
- packages/core/test/document-direct-model.test.ts (explicit parent ownership extension)
- packages/adapters/src/documents/pdf-preflight.ts
- apps/worker/test/pdf-processing.test.ts
- apps/worker/test/fixtures/synthetic-compatible-pdf.ts (new, synthetic only)

## Acceptance and evidence

Covers assigned CLEF-DOCUMENT-ROUTING / PDF-PROCESSING portions through CONTENT-BOUNDS-01..05, PDF-COMPAT-01..03, and updated PDF-PROCESSING-08/14 behavior. AI schema/cache-authority integration belongs to the other implementer.

RED command: pnpm --filter @invoxim/worker exec vitest run test/pdf-processing.test.ts
- /tmp/classification-content-red.log: exit 1, 3 intended failures/27 passed (oversized inert HTML, oversized body plus independent PDF, legal bare CR).
- /tmp/classification-content-nested-red.log: exit 1, nested passive catalog unsupported, with 3 earlier expectation changes also pending.
- /tmp/classification-content-review-red.log: exit 1, 2 failures/34 passed; independent review nested-only Pages/Count authority spoof reproduced.
- /tmp/classification-content-review-array-red.log: exit 1, 2 failures/36 passed; independent review wrong-array-value plus trailing scalar/ref spoof reproduced.

GREEN final commands/results:
- pnpm --filter @invoxim/worker exec vitest run test/pdf-processing.test.ts: exit 0, 38 passed; /tmp/classification-content-native-final2.log.
- pnpm --filter @invoxim/core exec vitest run test/document-direct-model.test.ts test/document-alternatives.test.ts: exit 0, 16 passed; /tmp/classification-content-core-final.log.
- pnpm --filter @invoxim/core typecheck: exit 0; /tmp/classification-content-types-core.log.
- pnpm --filter @invoxim/adapters typecheck: exit 0; /tmp/classification-content-types-adapters-final2.log.
- pnpm --filter @invoxim/worker typecheck: exit 0; /tmp/classification-content-types-worker-final2.log.
- pnpm exec biome check [scoped changed source/test paths] --error-on-warnings: exit 0; /tmp/classification-content-biome-final2.log.
- pnpm exec eslint [scoped changed source/test paths]: exit 0; /tmp/classification-content-eslint-final2.log.
- pnpm exec prettier --check [scoped changed source/test paths]: exit 0; /tmp/classification-content-format-final2.log.
- git diff --check -- [owned paths]: exit 0.

The scoped path list for those three tools was: packages/core/src/documents packages/adapters/src/documents/pdf-preflight.ts apps/worker/test/pdf-processing.test.ts apps/worker/test/fixtures/synthetic-compatible-pdf.ts packages/core/test/document-direct-model.test.ts.

Independent review: /root/classification_review performed read-only diff/evidence inspection; both catalog authority findings were reproduced with RED tests, fixed, and re-reviewed. Reviewer confirmed no remaining scoped blocker, while parent retains full integration verification. Reviewer did not execute tests. No tests or external calls are claimed on the reviewer's behalf.

## Bounds, effects and limitations

Unchanged source bounds: aggregate 4 MiB, 64 MIME parts, depth 8. Unchanged PDF bounds: 128 streams, 4096 objects, 8 MiB aggregate inflated bytes, 100:1 expansion or 64 KiB per-stream floor, 1 KiB compressed input chunks, 10-second conversion limits, 20 pages. Source-selection metadata is limited to 4096 ranges; overflow preserves the final source range and marks truncation. At most 64 supplied spans and 24,000 selected body characters. Body plus all attachment text can total at most 48,000 characters, with each individual model document at most 24,000.

No database migration, storage, dependency, credential, permission, destination or paid service change. Source bytes/text remain transient; repository fixtures are synthetic. No arbitrary receipt links or HTML assets are fetched.

The eight observed byte_limit jobs are NOT repaired: the Gmail normalizer and global source validator reject before per-document identity exists. Fixed byte guards remain deliberate. The patch does NOT claim to recover all 48 text_limit or all 11 PDF failures; no private sample was inspected. Truly truncated bodies remain review-only, including omitted quoted history and sources requiring more than 64 independent spans. Image-only/scanned PDFs still lack OCR. DCT/JPEG, object/xref streams, decode predictors and other unsupported codecs stay explicitly reviewable. Merely allowing DCT for declared Image subtype is unsafe because an attacker can reference the same stream as page/font content; no new reachability parser was added.

No live OAuth/provider/model calls, real quality benchmark, deployment, production write or rollout occurred. Context7 tooling was unavailable; existing installed unpdf 1.8.1 source was inspected when evaluating JPEG text-only behavior; no third-party API was added or changed. Full repo verify/build/E2E and native durable pipeline oversized-body/PDF purchase case are parent/other-implementer owned and not claimed here.
