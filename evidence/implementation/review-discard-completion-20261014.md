# Source-first review delivery

Task UX-REVIEW-DISCARD-01; backend da5ce64, frontend fe4fedc. Status: verification complete; release identities below.

## Implemented

Review email opens one source dialog (mobile sheet), showing transient subject/sender and attachment filename/type/known size plus the original-email link. Only the selected email is inspected; unopened rows do not trigger metadata or correction-capability requests. Questions group by actual server sourceMessageId, with per-review fallback when absent. No inferred grouping from timestamps or inbox address.

Not a purchase is a server-advertised, versioned source decision for eligible unlinked reviews. It atomically audits/dismisses actual-source sibling questions, cancels/fences pending jobs and marks the source processed as a manual non-purchase decision. Existing purchase/manual/ledger evidence prevents discard; stale/concurrent writes and future pipeline commits are guarded. No financial parse result is fabricated and no allowance is refunded. Original emails and retained evidence are not deleted.

Manual purchase entry is explicit and remains inside the mounted dialog; closing preserves drafts and uncertain-outcome retry identity. Default review has no form fields. Guidance refers to available actions, including when a linked financial sibling means discard is withheld.

The attachment reader requests MIME/header metadata through a fields-masked Gmail request, omitting body data and attachment IDs. Bounds:64KiB,4096chunks,32emptychunks,10-second elapsed checks,64parts/depth8. Unused headers are not returned or persisted. Provider/JSON/stream failures are normalized and canceled safely. PDF byte preview is deferred; attachment metadata and original-email access are implemented.

## Evidence

- New action acceptance was RED before implementation; core12tests and native27tests passed initially.
- Metadata resource review found an existing unbounded-chunk/time path. Four focused RED failures preceded the bounded repair; final native metadata/corrections32passed, including >20 unrelated-header compatibility and stream error redaction.
- Pipeline audit guard regression was RED (checkpoint incorrectly allowed); all30native pipeline database tests then passed, including cross-tenant isolation and stale financial commit rejection.
- Frontend missing-dismissal RED reproduced. Full98browser tests passed before the final copy delta.
- Mixed-source withheld-capability copy regression was RED then final4focused tests passed. Strict Biome including CSS, ESLint, Prettier and typechecks passed on owned paths.
- Independent principal review approved backend and frontend after resource/copy findings were fixed. Review was read-only, examining actual test evidence; no production mutation was used as a UI test.

## Runtime and rollout

No schema migration, new provider, credential, AI destination, model training or storage subsystem. Source inspection makes a bounded metadata call on explicit user action; manual decisions make no inference request. Existing unit/dollar caps are retained.

Deploy the compatible frontend first, then the Worker. Optional metadata/source identity permits the new client to use the prior backend while rolling out. Already-open tabs running the old strict schema client may require refresh after the backend adds fields/actions; no version-negotiation subsystem is introduced.

## Final integrated verification

Clean committed source121b14e: `pnpm verify` exited0. Contract48/core431tests, Worker1567tests across129files, and99browser tests in49.5s passed. Boundary, secret/dependency, Prettier, strict Biome, ESLint, types, builds and production test/debug publication checks passed.

The first integrated run correctly caught3exact review-response assertions missing the newly added sourceMessageId. Only the3expected fields were added; equality/tenant/privacy checks were retained. Affected21native tests passed, then the entire verify script was rerun successfully. Independent reviewer approved this test correction; runtime code was unchanged.

Synthetic screenshots: review-discard-list-desktop-20261014.png, review-discard-dialog-desktop-20261014.png, review-discard-dialog-mobile-20261014.png. Screenshots were refreshed by the final browser run; no real email data is stored in these artifacts.

## Released

Pages production/main:31d3fe2b-7769-4b2a-a1ff-f9cabc2401ed (https://31d3fe2b.invoxim-web.pages.dev), source121b14e. Wrangler deployment list confirmed Production/main. Worker:cbb11d63-2405-4394-af84-0c1ccb74d057, deployed afterward with --keep-vars and no source-map upload. Queue producer/consumer and minute schedule retained. Public URL:https://invoxim-web.pages.dev/.

Post-release aggregate:24inference jobs paused_budget/budget, no terminal/ready/leased jobs; zero foreign-key violations. Budgets and existing records were not reset. The earlier58parse failures and the separate exhausted sync were recovered; this allowance pause remains intentional.

No live correction command was submitted against private records. Command and UI evidence is native localD1 plus synthetic browser coverage; deployment identity and earlier Gmail listing recovery are separate live evidence. Refresh already-open tabs after deployment. PDF preview remains a separate queued follow-up.
