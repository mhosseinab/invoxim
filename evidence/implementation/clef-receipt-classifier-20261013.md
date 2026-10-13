# CLEF-01 implementation evidence

Status: integration and verification pending. Isolated worktree `/home/geek/.codex/worktrees/release-runtime/invoxim`; implementation starts from deployed repair commit `8f7d6d2`. Parent orchestrator owns commits, full verification and release decisions.

The implementation adds a provider-agnostic typed email-classification port and a Cloudflare Clef adapter. One typed Workers AI request asks both whether the email contains purchase evidence and its category. Receipts, unpaid invoices, orders, refunds, credit notes and cancellations remain eligible evidence; classifier output never establishes payment, refunds or monetary facts. Only a strong negative (configured maximum threshold 0.1) permits skipping financial extraction. Uncertain receipt decisions proceed to the existing financial extractor, and uncertain categories stay uncategorized without overwriting a usable financial-extractor category.

Classification uses combined bounded parsed text and a source-wide document identity. The first document anchors existing durable usage storage; the configuration fingerprint includes all source document identities. Every sibling document/hash/parser is checked before reuse. Unsupported attachments prevent a negative body decision from discarding an email. Durable `infer` continuation reuses the classification cache rather than making another paid call. The existing selected Abacus/BYOK extractor, strict evidence/money validation and ledger write path remain in place.

The existing atomic usage meter separately reserves/settles Clef calls and records the actual Cloudflare destination/model. Hosted classification consumes the existing operator cost cap even if financial inference uses BYOK. Classification consumes token/cost quota without charging a second document allowance. Unknown usage keeps the conservative reservation and produces only a static redacted warning. Lease, generation, tenant, current financial selection and accepted processing digest are checked before calls and writes. No schema migration or retained raw email/model transcript is introduced.

## Actual execution evidence

- Parent ran `pnpm --filter @invoxim/worker exec vitest run test/clef-classifier.test.ts` against the initial outage-returning behavioral scaffold: 3/3 intended failures, exit 1, 820 ms. Log `/tmp/invoxim-clef-red.txt`.
- Parent ran the initial adapter/configuration GREEN: 6 tests across 2 files, exit 0, 2.46 s.
- Parent ran initial adapter/native pipeline tests: 8 tests across 2 files, exit 0, 2.65 s. Log `/tmp/invoxim-clef-native-first.txt`.
- Expanded native cases and final type/lint/build/regression/independent review are pending at this handoff; the previous GREEN predates the added cases and must not certify them.

## Acceptance scope and independent review

CLEF-01 links relevant T11 cases AI-01, AI-03, AI-04, AI-05, AI-06 and ONBOARD-10. New tests exercise combined typed questions, wrong-model/distribution rejection, missing usage, source cache replay, source-wide integrity, unreadable attachments, separate billing, budget denial, consent/fence changes, BYOK destination preservation and actual Worker composition with a physical forty-statement counter. These are deterministic synthetic tests, not model-quality evaluations.

Read-only reviewer `/root/clef_refactor_review` reported model identity and probability-distribution validation gaps. Adapter changes reject unknown model identities and contradictory distributions, with regressions. Re-review remains pending. Parent also requested all-sibling document integrity checks, now implemented.

No live model evaluation, private email upload, new spend authorization, production deployment or remote migration was performed by this implementer. The operator must explicitly review the newly disclosed Cloudflare processing destination before an old import can resume under the changed configuration. The parent owns disclosure/binding/default configuration and UI work.

Root-brokered final integration evidence: 173 focused tests/14 files passed, followed by full `pnpm verify` exit 0 with 1404 native Worker tests, 379 core tests, 48 contract tests and 84 browser tests. Logs `/tmp/invoxim-clef-recovery-final-green.txt` and `/tmp/invoxim-clef-final-complete-verify.txt`. Independent principal review approved the final recovery patch. No deployment or live-model accuracy claim.
