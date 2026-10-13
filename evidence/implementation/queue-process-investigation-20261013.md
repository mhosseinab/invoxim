# QUEUE-02 live import investigation

Read-only Wrangler/D1 metadata investigation by a fresh Cloudflare subagent. No receipt fields, raw content, tokens or transcripts were inspected; successful queries reported zero changes and zero rows written.

Observed discovery progressed from 35 to 40 messages and completed jobs reached 100, with one leased and nine ready. No ready job was overdue by more than five minutes; no terminal, retry-wait or paused jobs were observed. Recent discovery continuation exists and older history is waiting for the recent slice.

Zero purchases reflected extraction outcomes: six accepted non-purchase responses containing no records, twelve incomplete results and six schema-review results. These counts describe the observation interval, not a model-quality benchmark or final import coverage.

The screenshot correction-action 503 is caused by production `CORRECTIONS_ENABLED=false`, independently of queue dispatch. Eight `invalid_mime` and one `byte_limit` source failures were marked review without corresponding document/review cards. Actionable source-failure visibility and feature-disabled correction affordances are follow-ups; no dispatcher patch was indicated by this investigation.

Successful remote reads used explicit managed configuration and escalation after sandbox credential access failed. A restricted missing-field projection was omitted; the narrower enum/count investigation succeeded. No database write, model call, test execution or deployment was performed.

Final read-only snapshot: 125 messages discovered, 9 processed, import discovering_older; 323 completed jobs, three newly ready, eight paused_budget. Tenant daily/monthly documents reached 50; operator reserved cost USD 0.378685 remained below the USD 1 daily cap. Daily document allowance is the current inference pause reason. Paused jobs require renewed Review/Start after allowance reset; automatic midnight resume is not implemented. One incremental/live recovering sync exhausted three attempts; retained diagnostics cannot establish the original failure, so no replay was performed.

A separate confirmed Gmail wire-contract defect rejects valid non-container leaves with `parts: []`, dropping bytes/downloads. Five synthetic regressions were prepared; root RED observed three intended failures and two controls passing. A two-condition parser/content fix is under separate verification. This may explain some MIME failures, but the 59 live invalid_mime outcomes do not prove causality.
