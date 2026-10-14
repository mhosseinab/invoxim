# Independent QA: bounded demo action and retrieval refinement

Status: scoped verification passed. Reviewer: `/root/runtime_qa`, separate from the frontend implementer and root test writer. No implementation, tests, contracts, dependencies, configuration or backlog were changed by QA. The independent principal source review remains a separate decision.

## Identity and execution

Parent-authorized clean synthetic snapshot: `/tmp/invoxim-demo-ux-qa-hhdazrw3/source`. This is a copied checkout, not a Git worktree or commit snapshot, and does not certify process sandbox isolation. Dependencies and generated outputs were excluded from copying. The 70-file ordered SHA-256 manifest identity is `5e0f5711bd6a57aa0a9e022ed7f6a10f56996c90ec4b8419b8502c79c6644f9a`; per-file hashes are in [demo-ux-qa-snapshot.txt](demo-ux-qa-snapshot.txt). Comparison after verification found zero source differences from the writer checkout: [demo-ux-qa-source-match.txt](demo-ux-qa-source-match.txt).

Actual commands, run from that snapshot:

```sh
pnpm install --frozen-lockfile
CI=true WRANGLER_LOG_PATH=/tmp/invoxim-demo-ux-qa-hhdazrw3/wrangler.log PLAYWRIGHT_BROWSERS_PATH=/tmp/invoxim-playwright-browsers TURBO_TELEMETRY_DISABLED=1 WRANGLER_SEND_METRICS=false pnpm verify
```

Both exited 0. [Install output](demo-ux-qa-install.txt) records 271 supply-chain policy entries and the committed `ignoreScripts` installation policy. [Full verification output](demo-ux-qa-verify.txt) records boundary, formatting, ESLint, four-package typechecking, unit tests, actual workerd integration, frontend/Pages compilation, Worker deployment dry-run and browser checks.

Fresh execution passed 7 tooling tests, 39 core tests, 39 contract tests, 5 workerd tests and 7 Playwright tests: **97 tests**. The three core property tests additionally execute 1,500 generated cases (500 each; seeds 20261011, 20261012, 20261013), included within the 39 core tests rather than counted as 1,500 separate tests. Core/contracts builds were freshly executed as unit prerequisites and replayed from cache later in the same command; their tests and all four typechecks were cache misses. Remote caching was disabled. The absent Git metadata warning is expected for this copy. No remote CI execution is claimed.

## Requirements observed

- UX-01: native local refund and unpaid links produce the intended single purchase, open its history, preserve EUR 120.00 global net, set refund pressed state, and focus the results anchor. The unpaid invoice remains excluded from spending. Demo disabled-button count is zero; unavailable Edit/Export/Sync/Archive controls are absent.
- UX-02: whitespace/case-normalized multi-token receipt text and evidence-ID searches find the correct record. Merchant search combines with Paid filtering to produce the expected empty state. Clear search and reset filters restore input focus and clear text; reset restores All pressed state and all four records. Paid filtering yields three records. No hidden reset remains after recovery.
- PRESENT-02 and DEMO-01/03/04: the static example is available from landing, exact canonical purchase fixture parity remains valid, paid EUR 150.00 / refund EUR 30.00 / net EUR 120.00 are unchanged, Audio net EUR 90.00 is unchanged, two equal-value Supplies purchases remain distinct, and source evidence opens locally.
- Requests captured during local retrieval and guided actions were restricted to the local test origin; no `/api/` or external-host request occurred. DEMO-02 static sentinels stayed unchanged and did not influence the example.
- At 360 CSS px: keyboard clears search with Enter and returns focus, activates refund filtering, and opens history. Reduced-motion configuration is exercised. Automated WCAG axe assertions report zero violations. Horizontal-overflow checks pass at normal rendering and `html` CSS zoom 2. Final mobile and CSS-zoom screenshots were visually inspected: [mobile](demo-ux-qa-mobile.png), [zoom](demo-ux-qa-zoom.png). Wrapping retains money and evidence instead of clipping them.

The snapshot uses the exact frozen root-owned browser assertions. Intentional authorized changes replaced earlier disabled-demo-control checks with absence checks and the select control with pressed buttons; exact financial, request isolation, accessibility and reflow assertions remain active. Source inspection also confirms all four chip counts derive from the unchanged synthetic records, search includes merchant/date/evidence text/ID, and future navigation has been removed in favor of available destinations.

## RED evidence and findings

Inspected parent-generated [demo-ux-red.txt](demo-ux-red.txt): both new flows failed before implementation, one because the refund link was absent, the other because receipt/evidence search returned no Audio record. This prior RED was performed by the parent, not QA. Independent QA performed the final clean GREEN above. No reproducible defect was found in the assigned checks; no own fixes or assertion weakening were performed.

## Limits and effects

This certifies the bounded static demo refinement. Storage sentinels are not real signed-in loader/query-cache/logout isolation proof. CSS zoom 2 is not native browser zoom. Axe is an automated accessibility check, not a complete screen-reader or human usability review. The read-only landing still truthfully identifies unavailable live login. No live OAuth, mailbox, model, Drive, deployment or real-data interaction was executed; no migrations or provider permissions changed. The Worker build was a dry-run and the Pages Function was locally compiled. No cloud charges or production release are claimed. Earlier unchanged runtime-spike checks were not rerun. Full MVP release gates remain outside this assignment.

QA artifacts only: this report, install/verification outputs, source manifest/comparison and mobile/zoom PNGs under `evidence/implementation/demo-ux-qa*`. Port 4175 was released after the seven browser tests finished.
