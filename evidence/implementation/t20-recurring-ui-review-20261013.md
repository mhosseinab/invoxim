# Independent recurring UI review

Task: bounded T20 user-selected recurring UI increment. Reviewer: separate standalone QA agent. Decision after repair re-review: **approve the bounded UI increment**. The two initial findings below are retained as historical evidence and are resolved in the re-reviewed source and seven-test regression result. Public recurring capability remains false; no full T20 or deployed approval.

## Reviewed scope

Inspected the frozen four files under `apps/web/src/private/recurring/` (`page.tsx`, `workspace.tsx`, `picker.tsx`, `styles.css`), route addition in `apps/web/src/app.tsx`, and `apps/web/tests/recurring.spec.ts`. Cross-checked the previously reviewed recurring API contract. Viewed all five `docs/design/ChatGPT Image Oct 11, 2026, 09_11_07 PM-1.png` through `09_11_11 PM-5.png` design references, and relevant presentation/onboarding rules.

No production edits or heavy/native/browser processes were performed. Only this report was written.

## Findings

### P1 — Next recurring page uses an unsupported API parameter

Status: resolved in the source repair described below.

Location: `apps/web/src/private/recurring/page.tsx:67`; next-page link at `workspace.tsx:147`.

Reproduction: return a first-page list with a non-null `nextCursor`, click **Next recurring page**. The UI URL uses `cursor` and the loader sends `/api/recurring?cursor=...`. The reviewed API `listInput` accepts `after`, not `cursor`, and rejects unknown query keys with 400. The user therefore sees the recurring load error rather than the next records.

Expected: translate the UI cursor into the canonical API `after` parameter, or consistently use `after` across the UI. Do not widen the API merely to mask the mismatch.

Required regression: serve first and second pages, assert the next request uses `after`, reject unsupported `cursor` in the mock boundary, click the link and verify second-page records and correct final cursor. Existing five UI tests never exercise this path.

### P2 — Stale evidence prevents explicit cancellation

Status: resolved in the source repair described below.

Location: `apps/web/src/private/recurring/workspace.tsx`, Series decision-button disabled condition.

Reproduction: load a stale confirmed series with its actual version (the existing stale mobile fixture has version 4). **Mark canceled**, **Pause**, **Dismiss**, and **Confirm** are all disabled because every action is gated by `record.status === 'stale'`.

Expected: keep evidence-dependent confirmation disabled while allowing supported manual decisions using the validated current series version. The reviewed API deliberately permits stale cancellation and its native regression verifies stale confirmation returns 409 while cancellation succeeds. The current UI prevents that recovery and presents a row of unavailable actions without a way to perform the supported decision.

Required regression: stale series allows explicit **Mark canceled** (and any other intentionally supported manual decisions), submits the actual expected version and scoped token once, remains forecast-free, and keeps **Confirm** disabled. Retain conflict locking/no automatic replay.

## Positive source assessment

Ready state depends on validated profile, coverage and recurring DTO reads. Login readiness defaults off and is populated only from validated public configuration after 401/403. Copy does not assert an expired prior session. A fixed onboarding link provides recovery when login is available; disabled/unavailable responses expose no editor.

Picker selection uses actual ledger-entry versions from validated purchase detail, rejects refunds/ineligible events and limits selection to 20. Service identity/cadence/anchor are explicit user choices and require confirmation. Changing a selection or identifying field resets confirmation. Series decisions use actual server series versions; no invented version constants are submitted.

Mutation flow checks actor identity before and after the request, uses the recurring scoped token, aborts on unmount, and prevents concurrent writes. Account/revision changes remount the workspace and discard draft selection and tokens. Conflict/unknown outcomes lock controls and require explicit refresh/review rather than resubmitting. Forecast labels remain estimates; unknown pricing, absent automatic suggestions and unavailable comparable charge basis are disclosed. No claim of new charges, unused service or external cancellation appears.

Source uses semantic headings, links, labels, checkbox confirmation, fieldsets, alerts/status regions and established BrandMark/sidebar/panel styling. Layout rules wrap long content and controls. Viewed design references provide branding/navigation/card guidance, but include illustrative unsupported claims/features that must not be copied as capability promises.

## Actual evidence inspected and limits

`/tmp/invoxim-recurring-ui-green-v1.txt` lists 5 Playwright tests passing, 3.3 seconds: selection/version payload and token; stale mobile forecast suppression/keyboard Refresh/Axe; unavailable state; conflict locking/no replay; account-change draft clearing. These use synthetic mocked responses. The stale test runs at 360 × 800, asserts no horizontal overflow and no Axe violations. Keyboard coverage uses programmatic focus plus Enter on Refresh; it does not prove the full Tab sequence. No screenshot or visual current/picker rendering was available at initial report creation; requested broker screenshots for independent visual assessment.

Previously reviewed native API/mount output reports 26 passing tests across 3 files, but the UI tests do not call that API and therefore missed the pagination mismatch. This reviewer did not execute either suite and did not observe test process exit codes directly. Source/diff/artifact reads and reference-image viewing were actually executed. Root reports an earlier RED with three missing-route failures; raw RED output was not inspected by this reviewer in this turn.

Some UI test names use canonical acceptance IDs for narrower checks. The observed assertions establish the described local behaviors, not full canonical RECUR-05 resync-decision persistence or the T21-tag requirements associated with RECUR-UX-02. Report them as bounded UI evidence.

## Remaining coverage and release effects

Required pagination and stale-decision regressions are now added and re-reviewed. Remaining untested by current UI evidence: anonymous login-recovery/default-off capability states, full keyboard flow, long-data/zoom reflow, unknown/timeout outcomes and same-account session change. Actual current/stale/picker screenshots were reviewed below. Limit additional work to applicable acceptance risk rather than treating all concerns as new features.

No production activation, deployment, real-user data, mailbox/Drive grants, inference or paid operation was reviewed. Public feature capability stays false. Automatic evidence-backed identity/terms/pricing, comparable source pairs and full T20 acceptance remain pending; the API/UI increment is not a full MVP completion certificate.

## Repair re-review and visual evidence

Re-read the repaired source and added regression assertions. Pagination now consistently uses `after` in the UI route and API request. The regression mock rejects an unsupported query, verifies `?after=next-series`, displays the actual second-page heading and removes the final Next link. Stale records now disable only evidence-dependent confirmation (and the already-selected state); cancellation, pause and dismissal remain explicit supported decisions. The new stale regression asserts disabled Confirm, enabled Mark canceled, exact expected version 8, scoped token, one cancellation payload, updated canceled version 9 and absence of forecast amounts.

Viewed actual synthetic screenshots supplied by the orchestrator broker:

- `/tmp/invoxim-recurring-current-desktop.png`
- `/tmp/invoxim-recurring-stale-mobile.png`
- `/tmp/invoxim-recurring-picker-draft-desktop.png`

The current desktop record has clear estimate labels, supporting-history link, series state and explicit manual decisions. The 360px stale layout wraps controls and text within the viewport, keeps supported cancellation visible, and shows no estimates. It no longer presents all four actions disabled. The completed picker draft has labeled fields, one selected actual payment, explicit confirmation and a single emphasized Save action. Branding/sidebar/cards/blue accent follow the viewed design direction. These screenshots are synthetic broker captures, not this reviewer's independent browser execution; full-page sticky sidebar positioning in the picker capture is an artifact limitation, not evidence of normal viewport layout.

No additional blocking source or visual findings. Inspected `/tmp/invoxim-recurring-ui-review-green-v3.txt`: all seven tests listed as passed, 4.3 seconds, including the pagination and stale-cancellation regressions. The orchestrator reported terminal exit 0; this reviewer did not execute the suite or independently capture that exit status. Re-read the corrected precise recurring route matcher, payload polling and actual canceled-state assertion; version 8, scoped token and expected canceled version 9 remain enforced. Root reported earlier repair attempts exposed a timing issue and an incorrect glob matcher; those attempts are not passing evidence and are not counted as behavioral RED. Full Tab-order testing, live identity/provider flow, automatic recurring terms/pricing, comparable-source-pair acceptance and full T20 remain outside approval.

## Final formatting/revision delta

Independently re-read the final recurring page revision-ref change and type-only/import ordering in all three TSX files. No new blocking findings. Refresh and revalidation synchronously advance `latestRevision.current`; each load captures its request revision and only publishes ready/error state when still current and not aborted. This closes the interval between a refresh event and effect cleanup in which an older response could otherwise publish. Existing abort cleanup and account/revision-keyed workspace remount remain intact. No destinations, API input semantics, forecast claims or mutation replay behavior changed.

Inspected `/tmp/invoxim-recurring-ui-final-green-v1.txt`, which lists all seven recurring UI tests passing in 4.3 seconds after the final delta. This is executor artifact inspection, not reviewer test execution; terminal exit status is supplied separately by the orchestrator. Bounded UI approval stands. This reviewer has not performed or claimed an independent FX revision review.
