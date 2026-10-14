# Independent PDF and classification review

Tasks PDF-PROCESSING-01 / CLEF-ACCURACY-02. Source implementation e224833 and test-only follow-up ab00dbd. Reviewer /root/langchain_review, separate read-only agent. No edits, test execution, model calls or deployment by reviewer.

Reviewed core document extraction; adapter PDF conversion/preflight; pipeline service/repository per-document routing/cache/lease/source completion; classifier protocol/factory and configuration/notice; evaluator/corpus/freeze safeguards and tests. Execution evidence inspected:55PDF tests/3files,128combinednative tests/10files,14evaluator tests, later parent431core tests. Counts overlap.

Concrete findings resolved by implementer with RED/GREEN regressions:

- Secondary /Prev and /XRefStm pointers, malformed/unchecked classicxref grammar and oversized object counts could undermine bounds. Canonical bounded tables/IDs/generations/offsets/sizes replace permissive recovery assumptions.
- Raw regex Length could select comment/literal/opaque lookalikes or nested dictionaries. Canonical stream dictionaries and actualxref-bound scalar lengths now reject ambiguous layouts.
- Invalid Root/Pages references could invoke PDF.js object recovery. Canonicalxref-bound Catalog/Pages/Count checks and refusal of raw opaque object markers close the concrete unchecked-discovery path.
- Bare-CR or unclaimed stream syntax could escape the recognized Flate pass. Unclaimed stream keywords are rejected.
- Cancellation while awaiting document loading lacked the loading-task handle; early stream cancel could race PDF.js teardown. The public loading task is retained before await and owns destruction.

Final code decision:approve conditional on the parent's clean full verification; no remaining blocking findings in the scoped conventional subset. Do not claim complete PDF-format coverage or hard CPU preemption. Raw original bytes remain transient; hashes/versioned provenance and financial write fences remain.

Limited follow-up review approved ab00dbd: replacing the obsolete no-PDF-conversion test is consistent with the new authorized behavior, while exact converted pages, original SHA/source identity, input bytes/limits and legacy PDF/plaintext assertions remain. No runtime or timeout/assertion weakening.

Offline evaluator approval:explicit live partition, development-first matching freeze and per-partition metrics are appropriate. Keep Clef score uncalibrated and unsupported deterministic reviews separate from model decisions. Paid live evaluation remains unauthorized/pending; actual accuracy milestone is incomplete. Parent must record final integrated gate separately.

Further limited follow-up: reviewer approved fc74c97, the compressed corpus test correction. It keeps the existing fixed original hash and asserts exact readable text, document identity, parser version, page count and integer monetary values; scanned/image rejection remains. No runtime changes or reviewer test execution. Final integrated verification must still be recorded by the parent.

Parent final gate: clean committed source fc74c97 passed the complete pnpm verify command, exit 0, including 1,626 Worker tests and 104 browser tests. The conditional integrated verification requirement is satisfied. Live model accuracy remains pending owner cost authorization.
