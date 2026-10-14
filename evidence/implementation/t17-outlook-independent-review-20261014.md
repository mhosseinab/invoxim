# Independent review — T17 Outlook connector

Reviewer: `/root/outlook_connector_review`, ledger-security specialist, separate read-only agent. Reviewed connected runtime changes through `24488b8`, with parent-owned final integration verification pending at review time. No files edited or tests executed by reviewer.

Reviewed requirements/files: Outlook Worker readiness/queue composition; provider-specific OAuth onboarding/redirect validation; recursive folder inventory and repeated delta discovery; bounded Outlook content/metadata transport; AI factory selection/checkpoint changes; local mailbox list/disconnect authority. Acceptance OUTLOOK-01–05 and existing tenant/consent/lease/credential barriers.

Evidence inspected: implementer focused run `/tmp/t17-final-focused.txt` (245 tests / 11 files); initial disconnect regression `/tmp/t17-disconnect-green2.log` (29 tests / three files); runtime-and-metadata implementation report. Parent subsequently executed final disconnect run (30 tests / three files) and Worker typecheck successfully; this is parent evidence, not reviewer execution.

## Finding and resolution

P1: existing folders were not polled in later hourly cycles. Inventory refresh changed the parent from idle to queued while children remained idle; delta selection skipped them, so new mail in existing folders was missed. Implementer added a guarded atomic requeue of live idle child states, preserving saved history/page cursors. Regression proves second/third hourly cycles consume exact saved opaque delta URLs and produce three distinct source/purchase records. A separate runtime fixture adds new and nested folders after the initial cycle and preserves their resulting cursors. Reviewer rechecked the fix and marked the finding resolved.

Metadata review covered fixed Graph host/selections, bounded response/time, immutable IDs, no pagination following, unsolicited content stripping, per-request and final tenant/source/consent/generation/scope/credential checks. Original URL remains null for Outlook. Foreign/disabled-provider route tests and four final-attachment-response mutation tests inspected.

Disconnect review found no new authority gap: recent/live session, active profile, owned connection/provider, exact version CAS, credential erasure, generation advance and idempotence retained. OAuth start/callback remain configured-provider operations. Actual foreign-owner and wrong-Origin witnesses added after reviewer requested stronger coverage.

## Decision and remaining gates

Reviewer approved the reviewed changes pending parent integration checks and final source freeze; no additional P0/P1/P2 finding identified. Cached-classification and BYOK decrypt races and late financial response races are covered; an already-cached financial extraction race is not separately added, but its existing full meter guard was inspected and adversarial regressions rerun. This was not identified as a blocker.

No live approval: Microsoft app registration and personal/work-account/provider-policy smoke, production activation, real model quality, remote migration and deployment remain unperformed. Parent owns full verification/build/browser evidence. Provider-neutral interfaces, mandatory Clef, selected AI destination and existing caps remain unchanged. One-item Graph pages bound the current physical SQL budget at a throughput cost.
