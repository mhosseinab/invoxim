# Bounded session and recurring leaf cleanup

New encrypted archive upload sessions drain before archive object parents. Recurring memberships drain before account series removal. One leaf per unit is limited to 100 rows; current tenant/request/stage/profile/journal guards apply to selection and are rechecked on mutation. Connection scope joins the owned mailbox/storage archive object; recurring source references wait for stage6, preserving manual references and series metadata. Original selected-member counts suppress forecasts after authorized member deletion.

Initial test run failed a fixture CHECK and is not behavioral RED. Repaired-fixture RED `/tmp/invoxim-m1-leaf-red-v2.txt` exit1: five intended behavioral failures/one pass. GREEN `/tmp/invoxim-outlook-cleanup-green-v1.txt` exit0: 51 tests/five files, 7.10s, covering six new cleanup cases plus existing M1 lifecycle, recurring and Outlook regressions. Focused writer typecheck/Biome/ESLint/Prettier/diff checks passed. Read-only independent reviewer `/root/deployed_login_browser_qa` inspected source and these logs; no blocking finding, executed no tests.

The selection guard occurs once, rather than repeated for eleven possible tables; source-derived maximum selection34/mutation12 binds stay below100. Native cases exercise populated >100-row collections, stale/current guards and foreign/manual survivors. This narrow increment does not complete the full recurring or archive feature, deployed deletion target, journal durability or isolated restore.

Reviewed hashes: helper61f57316ddd1ed71a324b088ae93e46405dc3535d1736a2daccb58c4bd7cd1fa; test2a4283c84a9f602905c0dea51c2fa1678d51ea65b42663a6990643e33e1c2052.
