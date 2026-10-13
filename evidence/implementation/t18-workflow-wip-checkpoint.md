# T18 archive workflow recovery checkpoint

Status: work in progress, not approved or complete. This checkpoint preserves the current implementation before further repairs, under the owner's explicit frequent-commit rule. Native D1 and the consolidated baseline remain authoritative. No migration, provider upload or deployment occurred.

The bounded multipart coordinator currently combines existing archive object/folder stores, selected-source hash/MIME/size checks, preallocated durable upload identities, exact-byte original readers, per-request authorization and credential fences. Credential refresh can defer without reading bytes or generating IDs; lease release is guarded against replacing a newer lease. Runtime queue dispatch, larger-file resumable upload, backfill, exports/links and UI remain unimplemented in this increment. Public archiving remains disabled.

## Actual verification and unresolved findings

- Root's initial composition RED failed on the deliberate `UNAVAILABLE` adapter stub: one failed/two passed, `/tmp/invoxim-t18-workflow-composition-red-20261013.txt`.
- Source-refusal RED genuinely reproduced two typed-guard classification failures (`CONTENT_UNAVAILABLE` instead of `CONFLICT`); three cases were intentionally filtered, not executed. `m1-service-checkpoints/drive-source-refusal-red-v1.txt`.
- Latest unfiltered native check: six files, 99 passed/one failed, exit 1, 14.44 seconds; `m1-service-checkpoints/drive-workflow-check-v1.txt`. Failure compares complete D1 query responses, including nondeterministic `meta.duration`; repair must retain exact ledger-row comparison.
- Adapter and Worker typechecks passed: `m1-service-checkpoints/adapters-types-v4.txt` and `worker-types-v3.txt`. Repository-wide Biome (356 files, warnings fatal), ESLint and Prettier passed on that frozen run. Subsequent edits need fresh verification.
- Independent read-only reviewer `/root/discovery_review` found a required P2: the new composition checks Outlook's short `Mail.Read`, while the established authorization contract persists `https://graph.microsoft.com/Mail.Read`. A valid Outlook grant is incorrectly refused. A positive canonical-scope regression and smallest repair remain pending. No approval is claimed.

The shared query-budget assertions passed in the latest run, but printed exact aggregate counts were suppressed by the runner; no numerical count is inferred here. Full runtime, final integration, whole-repository tests/build/browser verification and live provider smoke tests remain required. Earlier restoration certificates are historical.
