# Gmail parse-job repair — 14 October 2026

Scope: investigate the owner's 58 exhausted jobs without deleting messages, purchases, queues, consent, budgets or inference results. Existing UI work remains separately scoped and committed.

## Diagnosis and bounded recovery

Production aggregates showed all 58 exhausted jobs at parse/document index 0, with no staged documents. Six separate jobs were paused in inference by budget admission; these were not transport failures. A single failed parse job was fenced and retried with one remaining attempt. No raw Gmail responses, subjects, bodies, tokens, URLs with source IDs or model transcripts were retained.

Redacted production diagnostic sequence:

```json
{"event":"gmail_attachment_batch_invalid","reason":"opening-boundary"}
{"event":"pipeline_retry","reason":"CONTENT_UNAVAILABLE"}
{"event":"gmail_attachment_batch_invalid","reason":"headers"}
{"event":"pipeline_retry","reason":"CONTENT_UNAVAILABLE"}
```

The multipart parser assumed byte-zero opening delimiter and rejected all duplicate headers, including unrelated list-valued HTTP metadata. The repair accepts a complete delimiter line following at most 8192 characters of preamble and ignores uninterpreted headers, while rejecting duplicate interpreted identity/content/encoding/retry fields. Existing aggregate byte, deadline, chunk, attachment count, correlation, encoding and authorization checks remain. This supports Gmail framing without creating a second provider path or weakening source identity.

Primary references checked: Gmail batch API guide (API-specific batch endpoint, response correlation); RFC 2046 section 5.1.1 (preamble); RFC 9110 section 5.3 (field lines). Context7 was unavailable in the session; current primary documents and installed types/CLI were used.

## Verification

- Diagnostic regression initially failed because no bounded warning was emitted; then passed. Private sentinel strings never appear in warning calls.
- Preamble regressions: 2 intended RED failures, then GREEN including oversized/non-line prefix rejection.
- Repeated unrelated header regression: intended RED, then GREEN. Four content/pipeline files: 61 passed.
- Additional interpreted-header ambiguity tests: 48 attachment tests passed, including duplicate identity, content-type, encoding and retry policy rejection.
- Scoped strict Biome, ESLint and Worker typecheck passed before release.

Release source: 42b690b; Worker version 408ed9c3-ae6c-41fe-aedb-a1b8ec47039a. Deployment uses a clean committed archive, --keep-vars and no source-map upload. No Pages deployment, credential change, new migration, budget reset or cap increase.

## Production recovery observed

All 58 previously exhausted parse jobs completed after repair: 18 `documents_staged`, 17 `byte_limit`, 21 `text_limit`, 2 `invalid_mime`. None was relabeled successful extraction; review outcomes remain distinct from purchases. Zero terminal parse jobs and zero foreign-key violations were observed after recovery. New inference continuations remain subject to the existing allowance.

At the allowance check, the tenant daily bucket held 835653 reserved + 143947 spent units = 979600 against 1000000. The operator daily bucket held 410533 reserved + 34574 spent USD micros = 445107 against 1000000. Reserved amounts are conservative admission accounting, not an assertion of billed cost. No allowance/counters were changed. This is separate from the repaired multipart transport failure.

Operational mutation: one job was retried in each diagnostic step; then only the remaining57 terminal parse jobs lacking staged documents were made ready, with an incremented fence, cleared lease/dispatch reservation and one controlled remaining attempt. Existing inference pauses and paid caches were preserved. Queue contents were not purged and consent was not restarted.

Repository verification follows below.

## Follow-up hourly sync

The final sweep found a newly exhausted incremental sync job (separate from the58parse failures). Safe staged diagnostics localized it to listing; response-bound diagnostics then showed `gmail_discovery_transport_failure` with `operation:list`, `reason:response-body`, without an HTTP error. The request projected only messages/page-token, which may both be absent on an empty page.

Commit3239457 includes the documented `resultSizeEstimate` metadata in Gmail's list field mask. It does not accept arbitrary empty bodies or change range, query terms, pagination, page size, timeouts or stream limits. The new projection regression was RED then GREEN;6discovery/stream files64tests passed. Independent explorer review found no issue and reran4diagnostic regressions successfully. Primaryreference: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list

Worker version30d1046e-fdbf-4e9d-a2b8-bfb02c1a88a0 deployed the projection repair. The previously exhausted sync then completed and continuation sync jobs progressed. Final aggregate check showed no terminal jobs; inference allowance pauses remain separate. No queue purge or spending reset was performed.

Verification before the later review/discard feature: clean-archive `pnpm verify` exited0, with1548Worker integration tests and96browser tests; secret/dependency/boundary/style/type/build/productionpublication guards passed. Later diagnostics/discovery changes passed targeted51and64native groups and refreshed rootstyle/type/build/security gates. The integrated review/discard verification supersedes these partial later checks.

Final combined release verification at121b14e: pnpm verify exit0,1567Worker integration/99browser tests passed (plus48contract/431core). ReleaseWorker cbb11d63-2405-4394-af84-0c1ccb74d057 retains the repairs; latestpostreleaseaggregate has24budgetpausedjobs andzeroothernoncompletedjobs/FKviolations. Fullverificationlog remains /tmp/invoxim-source-review-final-verify.log; only sanitized synthetic evidence is retained inrepository.
