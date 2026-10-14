# Task completion report

Task: bounded T28 demo UX refinement, M0. Status: implementation complete, source frozen; root owns approval and task status.

Implemented two focused improvements: useful local exploration actions replace the demo's dead controls, and search/filter controls help users retrieve actual synthetic evidence. “See a refund” and “Find an unpaid invoice” clear search, select the corresponding status, open matching purchase history and use the native focusable results anchor. Sidebar retains functional Purchases, Summary and Privacy links. No disabled demo buttons remain; landing release disclosure is unchanged.

Search matches every whitespace-separated, case-insensitive token against merchant, purchase date, evidence IDs and synthetic evidence text. Search has an icon, readable field and Clear search control that restores input focus. All/Paid/Unpaid/With refund buttons expose pressed state and visually derived full-example counts. Conditional Reset filters restores all records and input focus. Empty results offer contextual recovery. Result count remains a screen-reader status; spending explicitly covers all example records rather than filtered results.

Files changed: `apps/web/src/app.tsx`, `styles.css`, `copy.ts`, `icons.tsx`. Labels are centralized in copy.ts. No tests, shared configuration, contracts, money kernel, fixture or backend edits. Blue design, semantic purchase/evidence names and exact core-derived values preserved: EUR150 paid, EUR30 refunded, EUR120 period net, EUR90 headphones lifecycle net, unpaid EUR80 excluded, distinct EUR15 receipts.

Acceptance coverage: DEMO-01/03/04 and static sentinel portion of DEMO-02; additional root-owned UX-01/02 checks. Real authenticated cache/logout/switch-user behavior remains unimplemented and unclaimed.

## Evidence

Root RED: browser tests exit1, `demo-ux-red.txt`: missing See a refund link and multi-token evidence query yielding zero instead of one purchase. Root GREEN: seven Playwright tests passed, exit0, `demo-ux-green.txt`.

Writer commands observed: `pnpm exec prettier --write apps/web/src/app.tsx apps/web/src/styles.css apps/web/src/copy.ts apps/web/src/icons.tsx` exit0; `pnpm exec eslint apps/web/src` exit0; `pnpm --filter @invoxim/web typecheck` exit0; `pnpm --filter @invoxim/web build` exit0, local Vite/Pages Function compilation successful. The build emitted a sandbox read-only Wrangler log-path warning; it did not prevent compilation. Intermediate formatter/typecheck/lint runs detected a syntax error during editing; corrected before the successful runs above. No behavioral RED assertion was weakened.

Independent runtime_qa reported clean frozen install/full `pnpm verify` exit0, seven browser tests passed: native guided focus/history, token receipt search, clear/reset recovery, no disabled demo buttons, unchanged exact money, local-only network, mobile keyboard, axe and 200% CSS zoom reflow. Independent final visual review is root-owned; this report does not invent an approval. CSS zoom evidence is not native browser zoom evidence.

## Effects and remaining work

No API, private loaders, storage/session access, account processing, export, provider/model calls or mutations introduced. No data/migration, permission, retention, credential, dependency, cost or deployment changes. No live provider or real-auth tests performed. No blocker to this bounded refinement; live integrations and authenticated cache tests remain later tasks. Source stays frozen after root's instruction to retain the tested contextual empty-state recovery.
