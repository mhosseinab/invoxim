# Classification/content improvement completion

Task AI-CLASSIFICATION-IMPROVEMENTS-03, M1. Status: review (implementation complete, full verification unresolved). Standalone worktree `/home/geek/.codex/worktrees/invoice-classification-improvements/invoxim`; base cd6a990; runtime source checkpoint934d651. Documentation corrections and completion bookkeeping follow that checkpoint. Owner explicitly approved two implementers and independent review. Implementation is isolated; no merge, deployment or production mutation.

## Behavior and scope

- Clef remains mandatory and asks receipt probability, financial-document type and category in one request. Strong nonfinancial types are excluded; contradictions remain uncertain. Production valid uncertainty uses the same selected hosted/BYOK financial provider through existing reservations, metering and fencing. Outage/schema/input failures cannot bypass classification.
- Financial verification rejects order acknowledgements and other nonfinancial output across fresh inference, accepted caches and durable reconciliation. Invoice totals do not imply payments. Historical paid attempts are not automatically rebilled.
- Oversized HTML can supply complete inert visible text. Body and attachment budgets are independent, preserving readable invoice PDFs even when a covering body remains review-only. Actual truncation is not automatically accepted. Byte/part/depth/page limits and shared40SQL budget remain enforced.
- Narrow text-PDF compatibility fixes include legal CR stream endings/passive nested dictionaries, retaining depth-one control authority and malformed-value barriers. No OCR, new converter/provider/storage, broad codec bypass or dependency change.
- OpenAI-compatible responses accept inert null tool envelopes but reject actual calls. Promptv6 improves JSON clarity; bounded schema diagnostics contain codes only. Missing usage remains conservatively accounted. The exact historical Abacus schema failure is not proved to be a null-envelope problem.
- Current operational observations (275 sources; classifier caches56negative/1candidate/10uncertain/6outage; zero manual labels) informed routing. Keep .1negative/.9positive thresholds. These are not a precision/recall calibration dataset. No paid benchmark or private-message replay was performed.

## Evidence

RED/GREEN commands and exact logs are in `classification-content-completion-20261014.md` and `classification-decisions-completion-20261014.md`. Focused counts overlap and must not be summed into a unique test total. They cover document type contradictions, selected-provider uncertainty, cached/durable nonfinancial rejection without rebilling, null envelopes, source/PDF boundaries, and a real native job engine creating a purchase from a readable invoice PDF within40SQL while its oversized body remains reviewable.

Baseline unit and native sixfiles98tests passed. Initial full `pnpm verify` failed: Worker integration143files/1790tests passed; one unchanged six-MiB Drive resumable workflow rejected UNAVAILABLE. Log `/tmp/invoxim-classification-full-verify.log`. Drive test and execution path unchanged from base; read-only review found no call into the modified classifier/document pipeline. Focused unchanged rerun `pnpm --filter @invoxim/worker exec vitest run test/drive-resumable-workflow.test.ts` passed4tests, exit0, duration10.51s, `/tmp/invoxim-classification-drive-rerun.log`. No assertion, timeout or production limit was relaxed. The focused result does not erase the initial full-run failure.

Full `pnpm verify` rerun exit1, `/tmp/invoxim-classification-full-verify-rerun.log`: static boundaries/secrets/dependency/format/Biome/ESLint/types and units passed (contracts50; core446pass+1existing expectedfail). Native144files/1791tests:141files1784tests passed,7failed across threefiles: longbodyPDF headroom PDF remained reviewable, Drive archive timeout, Outlook outage/rate-limit/hourly timeout cases and subsequent refusal call-count failure. Initial full run passed PDF/Outlook cases; full rerun did not. No third full-suite run, timeout increase or test waiver. The initiating stall is unproven; observed Outlook async work continues after test timeout, potentially disrupting restored mocks. This is evidence of incomplete verification, not a proved fix or proof of environmental causation.

After browser checks ended, one controlled `pnpm --filter @invoxim/worker exec vitest run test/direct-model-native-headroom.test.ts test/outlook-runtime.test.ts` passed2files29tests, exit0, duration23.04s, `/tmp/invoxim-classification-postgate-focused.log`. No code changed between full and focused runs. These scoped passes do not make the full gate green.

`pnpm build` exit0, `/tmp/invoxim-classification-build.log`: all5tasks passed; production artifact/input guard passed (test/debug dependencies excluded). `pnpm test:e2e` exit1, `/tmp/invoxim-classification-e2e.log`:113passed/1failed. Unchanged `corrections-ui.spec.ts:445` CAD merchant-correction test timed out waiting for Edit purchase details; synthetic browser snapshot shows Workspace unavailable. No frontend changes or assertion waiver. Its pre-existence has not been proved by a separate base browser run.

Task status: review. Scoped implementation and independent review completed; full repository integration/browser gates remain unresolved. No claim that all required checks pass.

Independent principal review `/root/classification_review` resolved cached-result bypass, nestedPDF authority/value-barrier and evaluator-routing findings. Final README/docs05 consistency pass approved. Reviewer ran no tests or live replay; report `classification-improvements-review-20261014.md`.

## Operational effects and limits

Files changed: bounded document selection/extraction/PDF preflight; AI Clef protocol/HTTP/engine/validation; pipeline guards/contracts; versioned classification config/notice; focused synthetic regressions and existing evaluator routing; README/docs05/docs15 and task evidence. Inherited style-only gate repairs are isolated in bf03bda.

No database schema, migration, secret, mailbox scope or deployment changes. Raw email/PDF/model text stays transient. Existing provider/BYOK choice is retained. Valid uncertain decisions may add metered financial calls under the existing allowance/cost caps; no repair-loop billing. Changed classification/parser/prompt identities and notice enter consent/cache digests; a future approved rollout requires refreshed Review/Start and does not silently reprocess old paid evidence.

Global source byte-limit rejection still occurs before per-document identity; this patch does not solve those sources. Unsupported DCT/object/xref-stream/predictor formats and scanned/image-only documents remain reviewable. Live recall/precision, whole-import throughput and deployed CPU compatibility were not established. No live OAuth/provider smoke, migration application or deployment was performed for this task.
