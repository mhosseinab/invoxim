# Direct model extraction and mandatory Clef — 2026-10-14

Owner decision: keep Clef as a required purchase/category gate and let the selected extraction model interpret original email content instead of locally parsing receipt fields.

## Implementation

New sources use `documents-direct-v1`: MIME decoding preserves bounded original plain text and HTML alternatives as one document with labeled input parts and a combined exact-byte hash. HTML stays inert; no assets, arbitrary invoice URLs or tools are fetched. Raw content and model responses remain transient.

The selected hosted/BYOK model returns the existing structured extraction schema under `invoice-extraction-v5`. Direct input validation checks schema, calendar validity, currency precision, exact money, supplied source-part citations, required facts and typed cash-event consistency. It does not interpret receipt language or require normalized values to appear literally in raw HTML. Its citations are model assertions, not independent textual proof.

Clef cannot be disabled while AI processing is enabled: absent/disabled/invalid classifier configuration or an unusable AI binding rejects configuration; production runtime independently blocks before mailbox access or inference. There is no extraction-only production fallback.

Already staged legacy jobs retain their source identity and validator. Previous paid calls are reused only with compatible policy; unfinished/incompatible paid attempts stay held rather than being billed again. Arbitrary prompt changes cannot borrow the current release's compatibility exception. Existing budget and tenant/consent/lease fences remain intact.

No migration, provider, credential, spending cap or queue resource was added. Binary PDF/image input remains unavailable for Luna until model-specific support is verified. Abacus documents generic [PDF](https://api.abacus.ai/help/route-llm/chat-completions#pdf-support) and [image](https://api.abacus.ai/help/route-llm/chat-completions/image-analysis) wire formats, which alone do not prove selected-model support. Context7 was unavailable; official provider documentation and local types were used.

## Executed focused evidence

- Direct transport RED: four intended failures; GREEN: 16 core cases and 28 native legacy cases. `/tmp/invoxim-direct-model-{red,green,native-green}.txt`.
- Direct validator RED: seven intended failures; GREEN: 105 core cases across five files. `/tmp/invoxim-model-validation-final-green.txt`.
- HTTP wire: six cases including unchanged raw HTML serialization. `/tmp/invoxim-model-wire-final-green.txt`.
- Independent native direct pipeline: five cases, one exact paid purchase, unpaid invoice without cash, invalid provenance, ambiguous total and grouped-source continuation. `/tmp/invoxim-direct-model-pipeline-verified.txt`.
- Mandatory classification: ten native cases proving no mailbox/model call on unavailable classification. `/tmp/invoxim-mandatory-classification-green.txt`.
- Remaining onboarding route fixtures: 28 native cases across three files, unchanged security assertions. `/tmp/invoxim-mandatory-onboarding-fixtures-green.txt`.
- Required fixture migration: 118 native cases across nine files. `/tmp/invoxim-mandatory-classification-fixtures-green.txt`.
- Final targeted regression: 49 cases across five files including crash recovery, prior-paid cache and arbitrary changed-prompt refusal; assertions unchanged. `/tmp/invoxim-direct-final-regressions.txt`.
- Scoped type/style checks passed; full required verification is separately recorded below.

Independent read-only review: `/root/clef_refactor_review` approved direct text/HTML, mandatory classification and narrowed cache compatibility. Reviewer inspected source and executed evidence; did not claim to have run tests.

## Release status

`pnpm verify` passed, exit 0, in the managed release checkout at `bea0937`: boundaries, secrets/dependency policy, Prettier, Biome, ESLint, types, unit/native integration, builds, production dependency/artifact gates and browser checks. Exact totals: 48 contracts, 431 core, 1,449 native Worker cases across 120 files, and 87 browser cases (39.2s). Log: `/tmp/invoxim-direct-model-verify-release.txt`. Earlier full runs found cache-policy and missing-classifier fixture regressions; those were fixed and the entire gate rerun without weakening assertions.

Deployed Worker `ece04245-e5d0-4b09-b930-71a34ba4fc03`. `/tmp/invoxim-direct-worker-deploy.txt`, exit 0. No frontend changes required a Pages release. Public health smoke returned 200; anonymous AI settings returned 401. `/tmp/invoxim-direct-health.json` and `/tmp/invoxim-direct-anonymous-ai.json`.

The owner then explicitly requested clearing queues and all imported messages to start over. With delivery paused and purchase/ledger/archive counts all zero, a workspace-scoped reset removed old 71 message sources, 57 document rows, 210 durable jobs, import/sync/idempotency state and prior processing consents. Cascades removed source reviews and extraction caches. Mailbox scheduling returned to awaiting-import. Login, mailbox credentials and AI settings were retained. All four usage buckets, recorded operator spend, reservations and approved caps were retained. No Gmail originals were deleted. Foreign-key validation succeeded. Evidence: `/tmp/invoxim-direct-fresh-reset-{before,result,after}.json` and operator SQL in `/tmp/invoxim-direct-fresh-reset.sql`.

Both `invoxim-jobs` and `invoxim-jobs-dlq` were purged successfully. `/tmp/invoxim-direct-{jobs,dlq}-purge.txt`. A new authorized import appeared after the reset (one new job, three sync states, one processing consent; old sources/documents/reviews/caches remained zero). It was preserved rather than erased by another cleanup. Queue delivery was resumed successfully after verified deployment: `/tmp/invoxim-direct-queue-resume.txt`.

Production aggregate before rollout showed zero purchases; no real message contents or financial values were inspected. Synthetic success is not a live-model accuracy claim. Fresh-import live progression is recorded separately; the owner controls Start.

Owner work-in-progress safety: release changes were disjoint from 25 tracked owner paths. Saved hashes proved those contents unchanged after integration; release source files matched the managed verified checkout. Backlog task AI-DIRECT-01 was subsequently added separately while preserving existing owner entries.

Rollback: pause queue delivery and restore previous Worker version `277adb4b-c2de-43d9-ba74-678298f09172`. Newly staged direct-version jobs may need to remain held until compatible code is restored; do not erase costs or rebill them automatically. The authorized data reset is not claimed to be reversible.
