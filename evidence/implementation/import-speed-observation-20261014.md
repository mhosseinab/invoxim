# Import speed observation — 14 October 2026

Owner requested monitoring while the UI subagent worked. Read-only D1 aggregate samples of the existing workspace/import; no queue changes, model requests, new imports or counter resets initiated. Six observations span 8.38 minutes. This is one live workload, not a controlled before/after performance benchmark.

| Elapsed minutes | Discovered messages | Processed | Review | Purchases | Leased jobs | Exhausted jobs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.00 | 18 | 1 | 10 | 0 | 2 | 0 |
| 1.20 | 30 | 1 | 22 | 0 | 0 | 1 |
| 2.43 | 43 | 1 | 33 | 0 | 1 | 4 |
| 3.98 | 54 | 4 | 42 | 2 | 1 | 5 |
| 5.85 | 74 | 6 | 54 | 2 | 2 | 7 |
| 8.38 | 96 | 7 | 76 | 2 | 2 | 9 |

Observed throughput: 9.30 newly discovered messages/minute and 8.59 messages/minute reaching processed/review/failed status (mostly review). These are not successful-purchase rates. Two purchase records became available and discovery advanced from recent to older history. Two simultaneous leased jobs were observed. The latest sample still had two leased jobs, three retry-wait and nine terminal jobs; message `failed` count remained zero, so that count alone understates exhausted durable work.

Recorded last-ten-minute reservation-to-settlement averages at the last sample: Abacus roughly 6.6 seconds (maximum 9.7), Clef roughly 1.1 seconds (maximum 1.6). These include application/metering overhead and are not pure model-server latency. Missing usage appears as `uncertain` accounting and does not itself prove inference failure.

Earlier aggregate outcome checks showed repeated `text_limit`, `byte_limit`, unsupported-conversion document reviews, missing currency/total/date fields and exhausted source-extraction jobs. Those observations explain poor useful-result yield, but no trace-based root-cause diagnosis or backend fix is claimed. No source bodies, subjects, receipt values, model output or credentials were read. Private identifiers remain only in local command selectors/captures, not this report. Caps and production configuration unchanged. This observation ends with the UI task; no recurring monitor or future notification was scheduled.
