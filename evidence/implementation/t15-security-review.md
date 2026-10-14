# T15 provisional independent security/correctness review

Independent reviewer: `/root/discovery_review`; recorder: root, persisting the returned read-only report. Decision: request changes until repairs, independent regressions and final source-matched verification are complete.

P2 cleanup.ts: missing bounded purchase leaf meant final user cascade could erase an unbounded purchase set. Require >100-purchase regression and journal-before-erasure.

P1 graph.ts: alternative cash backing must be accepted and carry the same evidence code, in addition to exact source/segment/fields and purchase relationship. Pending-review and mismatched-proof negatives plus accepted positive retention required in preview/cleanup.

P1 purchase-views/index.ts and lifecycle-routes.ts: separate purchase/event/summary reads allowed internally inconsistent exports during concurrent changes. Derive all financial totals from the same exported event set; test mutation between reads with exact tenant/period/eligibility rules.

P2 Worker index.ts: cleanup pending or awaiting journal returned before other tenants’ ordinary dispatch. Require bounded shared 40-query progress with tenant A journal failure and tenant B authorized outbox delivery; A remains fenced and unerased.

Reviewed contracts, lifecycle core/export, adapters/migration0011, routes/scheduler, purchase export, auth boundaries, tests and available evidence. Reviewer performed reads/hash inspection only: no edits, tests, migrations or live calls. Earlier 12 writer and 14 QA native tests are historical, not a certificate for repaired source. Final approval requires frozen repairs, all four regression outcomes and fresh integration/source matching. Live journal durability, revocation, deployment and deletion target remain unproved.


## Independent source re-review

Returned by `/root/discovery_review`, recorded by root: repaired source approved conditionally on final independent verification, no further required finding. All four findings closed: bounded purchase leaf; accepted/matching-code cash backing; export values from the exported event set; three cleanup units followed by shared-budget ordinary dispatch. Reviewer inspected changed predicates, export reader/route, scheduler and budget interaction plus regression assertions; no edits/tests executed. Read-only inspection/SHA commands exited 0.

Inspected hashes: cleanup aced1f6949ba7e0f6ab2533c230d7ad19036be0ff2d4d38d183c0fce2a1a6d76; graph 1b2b3e27114ce7658d4e7a509b97a62be6a573dd2232c5dc37b870d78344211c; Worker index cfd92181a7fef25417d3bc86fb56b7df41b8d3651537172e83a486fc2e2c87bf; lifecycle routes 49e4a8333308f595f044939b9756d2de235e4f369c62f46347a0345315acef06; purchase views 5ba3710e8ae0664c16992ad9b667e54d32dc88933f277edfe127eec6bbe4ba18.

Current independent native regressions are separately recorded in t13-qa-native-final-green.txt (27 passes: purchase9/lifecycle18). Fresh installation/full verification/source matching remain pending. Live journal durability, remote revocation, deployment and deletion deadline remain excluded.


## Final independent approval

Returned by `/root/discovery_review`, recorded by root: final bounded local approval; all four source findings and execution contingencies closed. Repaired source hashes match prior review; actual independent native27, fresh641 distinct tests, db73 repeated checks and zero258-input source differences inspected. Baseline manifest b92849ab2b74f4459dcbe2bf0f445b82689c9e479d16800dc8e0fba6cda8bb02. Reviewer read-only, no test execution or edits. Production journal durability, remote revocation, deployment and deletion deadline excluded.
