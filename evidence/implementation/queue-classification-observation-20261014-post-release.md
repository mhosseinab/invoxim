# Post-release queue/classification observation — 14 October 2026

Read-only observation requested by the owner after release fe4548b. Four aggregate D1 samples from 14:06:12.254Z to 14:08:54.539Z (16:06–16:09 Europe/Vienna), 2.70475 minutes. Bounded Wrangler live tail filtered in memory to queue outcome and allowlisted classification counters; raw request envelopes, headers, subjects, bodies and model transcripts were not saved. No import, retry, model request, reset, configuration or deployment was initiated by this check.

| UTC | Discovered sources | Processed status | Review status | Failed status | Purchases |
| --- | ---: | ---: | ---: | ---: | ---: |
| 14:06:12 | 58 | 9 | 45 | 0 | 0 |
| 14:07:09 | 71 | 10 | 56 | 0 | 0 |
| 14:07:47 | 73 | 11 | 59 | 0 | 0 |
| 14:08:54 | 86 | 12 | 73 | 0 | 0 |

Discovery: **10.35 sources/minute**; messages entering processed/review/failed statuses: **11.46/minute**, predominantly review. Previous `import-speed-observation-20261014.md`: 9.30 discovered/minute and 8.59 terminal-status/minute over 8.38 minutes. Different samples/stages/documents; this is not a controlled benchmark and does not establish a causal speed gain. The first 58-second interval was faster (13.52 discovery/minute), but reporting only that interval would overstate sustained throughput.

The live tail captured **70 queue invocations**, all platform outcome `ok`, no unhandled exceptions. D1 had one leased and two ready jobs at the final sample; no terminal/retry-wait jobs. This is better operationally than the earlier run's exhausted jobs, but platform success does not imply useful extraction: operational review outcomes also acknowledge queue delivery.

## Classification is demonstrably using the deployed policy

Final completed Clef caches: **20 negative**, **one candidate**, **five uncertain**, **one outage** (27 document classifications, not 27 distinct emails). Representative live `ai_classification_decision` logs:

| Policy | Receipt probability | Negative / positive threshold | Outcome |
| --- | ---: | --- | --- |
| document-invoice-classification-v3 | 0.0722 | 0.1 / 0.9 | non-document |
| document-invoice-classification-v3 | 0.0186 | 0.1 / 0.9 | non-document |
| document-invoice-classification-v3 | 0.9603 | 0.1 / 0.9 | candidate |
| document-invoice-classification-v3 | 0.181 | 0.1 / 0.9 | uncertain |
| document-invoice-classification-v3 | 0.2195 | 0.1 / 0.9 | uncertain |

The new gate rejects/abstains rather than forwarding every borderline answer. This proves routing behavior, not precision or recall. Ground-truth labels were not inspected; false positives/missed invoices remain unmeasured. Do not lower thresholds based only on this sample.

Clef reservation-to-settlement latency: known-usage attempts average **1,309 ms**, maximum **1,852 ms** (26 attempts); one uncertain-accounting attempt 857 ms. These durations include application overhead. Missing usage alone is not an inference failure.

## Useful-result blockers remain

Final completed source-extract job outcomes include **48 text_limit**, **eight byte_limit**, **one part_limit**, **18 document_review**, **20 non-purchase**, and one ledger_committed continuation. Job stages and sources/documents overlap; do not sum these as unique messages. The core document extractor's existing whole-extraction text guard is **24,000 characters**. Limit failures can prevent readable documents from reaching Clef or the selected financial model; no email content was inspected to determine exactly what caused each oversized case.

PDF document state: five compressed_pdf and six malformed_pdf outcomes; one unsupported text/calendar document. These are converter/parser codes, not proof the original PDFs are invalid. Several uncertain classifications and one classification input-limit also remain reviewable.

The one approved candidate reached Abacus. Its single attempt settled in **9,442 ms**, with uncertain usage accounting; the cached financial outcome is **needs-review / schema**. No merchant/date/amount/model response was read; the exact validation error cannot be reconstructed from this coarse persisted reason. The ledger_committed job label does not mean a purchase or cash event was created: final purchase count remains **zero**.

Conclusion: the queue is progressing without exhausted jobs and the stricter Clef policy is active, but useful purchase yield has not improved in this observed window. Next diagnosis should target bounded content/PDF handling and financial response schema validation, with synthetic reproduction/redacted validation reasons rather than blindly widening limits or changing classification thresholds.

Evidence: `/tmp/invoxim-queue-observe-{1,2,3,4}.json`, `/tmp/invoxim-queue-safe.ndjson`; CLI commands exited 0 for successful aggregate samples. One initial second-sample query referenced a nonexistent sub_reason field and was corrected/re-executed; no data mutation occurred. Tail ended at its fixed 125-second deadline; no recurring monitor remains running. No implementation tests were needed for this read-only operational check.
