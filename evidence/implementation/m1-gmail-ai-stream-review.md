# Independent second-wave Gmail/AI stream review

Reviewer: separate read-only security agent `/root/m0_security`. No source/test edits, native test execution or live calls by reviewer. Decision: approve the frozen Gmail chunk/elapsed-clock repair. AI source inspection supports its bounded repair; final approval awaits the executor/source freeze and static closeout below. This review does not approve full transport resource handling or milestone completion.

Final closeout: AI author supplied frozen two-file manifest `ai-stream-bounds-source-20261013.txt` and `ai-stream-bounds-report-20261013.md`, confirming scoped statics exit 0 and no source changes after the QA run. Reviewer independently checked that manifest (exit 0, both OK), matching the inspected hashes below. AI bounded repair is now approved too. The earlier pending decision above records chronology; it is superseded only for this exact AI source/test snapshot.

## Inspected identity

Read current affected readers and surrounding auth/byte/part/usage flow, complete new finite-stream suites, raw GREEN logs and Gmail implementer report `t17-gmail-stream-bounds.md`. SHA-256 independently observed:

| File | SHA-256 |
| --- | --- |
| discovery/gmail.ts | `ca2ed6e95e56945f181f1118490fc3a8aefbf61dc56c88597e3e5aaa303b022e` |
| pipeline/gmail-content.ts | `10d180213c9bb50e6cdb973dba6b03c3a1c1d7dc8984ebd5781374b6ba2abe1c` |
| gmail-stream-bounds.test.ts | `1da373256b055646b8db77f8eeae29706fa3891b666df267364eb68fba1b6570` |
| ai/http.ts | `8e5784d8dbd3e3f3ab383442f894a78933ae426843611ce112ca31fad418cc05` |
| ai-stream-bounds.test.ts | `645e3bb1c52e5b8b0e6619a4aaf7e0025ce5ed9cc6539b90a98432a2006dc52d` |

Gmail writer confirms its three files frozen at these hashes, scoped Worker/adapters types and lint/warning-fatal Biome/format exit 0. No invented static execution by this reviewer.

## Source assessment

No required finding in the bounded chunk-memory/iteration/elapsed-clock patch. Gmail discovery uses one 64 KiB buffer; content allocates only the remaining established aggregate encoded allowance `ceil(DOCUMENT_LIMITS.bytes * 4 / 3) + 65536 - responseBytes`. Every admitted content chunk increments shared aggregate accounting before copy; exceeding the budget refuses with CONTENT_BYTE_LIMIT. No new smaller framing limit rejects previously accepted inline bodies. Prior message/source IDs, per-request checkpoint, selected-part identity, attachment deduplication, max nine requests and MIME byte/part/depth admission remain. Buffers do not retain a producer chunk list. Previously parsed full-message/attachment objects and transport-owned chunks can coexist; this is not a claim that global heap equals the accumulator bound.

Both Gmail readers cap cumulative nonempty chunks at 4096 and empties at 32; count excess refuses with existing typed errors, cancels the reader and releases locks. Absolute existing ten-second deadlines are checked before/after each read including EOF and before JSON parsing. Caller abort preserves CONTENT_AUTH_CHANGED classification in content. These finite work checks prevent immediate-read timer starvation.

AI uses one configured-output-cap buffer, the same cumulative 4096/32 limits and checks its selected destination's absolute deadline before/after reads including EOF and before parsing. Refused incompletely consumed bodies cancel and release the lock; complete successful bodies retain exact parsed output/usage. Destination/model/config validation, reservation admission, no tools, explicit selected host, manual redirects and no retry/fallback remain. Count refusal returns failed/outage with null usage; elapsed failures return timeout. No partial JSON or usage publication occurs on those failures. These changes introduce no provider-specific inference coupling or destination override.

## Actual execution evidence

Gmail writer/executor supplied exact command:

```text
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/invoxim-gmail-stream-green-20261013.log pnpm --filter @invoxim/worker exec vitest run test/gmail-stream-bounds.test.ts test/discovery-adversarial.test.ts test/discovery.test.ts test/pipeline-runtime.test.ts test/pipeline-adversarial.test.ts
exit 0
```

Inspected preserved `t17-gmail-stream-green-20261013-044045.txt`/broker `/tmp/t17-gmail-stream-green.txt`: 85/85 across five files, no skips, 04:40:45, 15.65s. Eight new finite cases follow genuine six intended RED failures/two ordinary positives (`t17-gmail-stream-red-20261013-043854.txt`). Actual cancellation and bounded pull count are asserted for empty/tiny/elapsed refusals; ordinary fragments retain parsed content. Nearby runtime/adversarial cases preserve authorization/budget/part regressions without proving real Gmail.

Read raw `ai-stream-bounds-green-20261013-qa.txt`: 53/53 across three files, 04:41:19, 10.38s, no reported skips. Root reports session 99759 completed exit 0 after six-case genuine five-failure/one-positive RED (`ai-stream-bounds-red-20261013-qa.txt`). New tests reject cumulative interspersed empty reads and excessive nonempty chunks with actual cancellation, preserve normal output and exact reported usage 5/7, and enforce elapsed limits before read, after data and after EOF. Each actual mock inference uses one selected endpoint call; no fallback or additional request is inferred. Exact command/final freeze/static provenance requested from QA/root before AI final approval.

QA subsequently supplied the exact executed command, session 99759 completed exit 0 (no reviewer execution):

```text
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/invoxim-ai-stream-green-20261013.log pnpm --filter @invoxim/worker exec vitest run test/ai-stream-bounds.test.ts test/ai.test.ts test/ai-adversarial.test.ts > evidence/implementation/ai-stream-bounds-green-20261013-qa.txt 2>&1
```

Writer's final scoped type/build/lint/Biome/format logs are listed in `ai-stream-bounds-report-20261013.md`; the reviewer inspected that report and manifest, not a fabricated self-executed gate. Writer did not execute native tests; QA remains the sole native executor.

## Limits retained explicitly

Gmail discovery still directly awaits fetch/read without an independent race for a transport ignoring its signal; early response errors and late responses lack complete unread-body cleanup in this patch. Content has an abort-triggered reader cancellation hook, but its outer fetch wait and early-response cleanup are not independently established here. AI still directly awaits fetch, relies on signal-driven reader cancellation and leaves early-status response-body/late-fetch cleanup outside this chunk repair. The author/root treat these as separate pending-I/O boundaries. These are not certified as fixed by finite-stream GREEN, and broader resource closure must account for them.

No full Gmail/Outlook processing, live OAuth/provider/model quality, actual consent/destination storage authority, deployed runtime behavior, raw-retention sweep, money mutation, whole-source verification or regulatory/MVP approval is claimed. Synthetic fixtures and mocked HTTP remain distinct from real provider access.
