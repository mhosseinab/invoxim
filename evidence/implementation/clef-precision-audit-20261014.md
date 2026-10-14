# AI-CLEF-PRECISION-01: invoice-focused classification

Status: implementation and focused native verification complete; independent review and root release checks pending. No deployment or live model evaluation performed by this agent.

## Observed causes

1. The old Clef question explicitly accepted order confirmations, pending refunds and cancellations. That instruction was broader than the owner's current invoice/receipt focus.
2. The old mapping used `receipt.noul > 0.1` for `isReceipt=true`: 0.1001 and 0.45 were routed to financial extraction. This was deliberate in an existing test, not string/boolean coercion or an undocumented Clef threshold. Clef's official `noul` output is the probability of yes, not a boolean.
3. Read-only production aggregates showed 18 negative and 32 positive classifications, plus one outage result. The application was not marking every successfully classified source positive. Historical raw receipt scores were not retained, so exact previous responses cannot be reconstructed.
4. Of 65 open review rows, 30 were `converter_unavailable`, 30 `extraction-review`, three `unknown-payment`, one `classification-input-limit`, and one `classification-outage`. Unsupported binary attachments are reviewable before Clef/financial extraction; they cannot be honestly called successful invoice detections.
5. A cross-aggregate at **2026-10-14T08:29:31Z** found three extraction-review rows on three sources with negative Clef outcomes, alongside ten operational document-review rows on negative sources. The pipeline previously allowed financial extraction of a negative readable body when an unreadable sibling prevented whole-source skipping. The separate backend agent owns that repair, preserving the unreadable attachment warning.

Counts are review rows/classification records rather than a labeled accuracy dataset. Source overlap means counts must not be added as unique email counts. Aggregate JSON contains no user, mailbox, message, subject, sender or document identifiers.

## Policy change

Keep the existing provider-agnostic classifier interface and a single Clef request with receipt `noul` and category `choice`. Ask for actual invoices (paid or unpaid), payment receipts, credit notes or completed refund confirmations. Explicit true/false criteria exclude order acknowledgements, shipping/delivery/tracking notifications, cancellations, pending refunds, payment reminders and marketing when no actual financial document is included. Mixed document-plus-notification email remains eligible; missing extraction fields alone do not disqualify an invoice. Attachment contents are never invented.

| Receipt score | Routing under defaults |
| --- | --- |
| `0 <= score <= 0.1` | Classified non-document; existing completeness guards still apply |
| `0.1 < score < 0.9` | Explicit `uncertain` review; no financial extraction |
| `0.9 <= score <= 1` | Candidate for separately validated financial extraction |
| Invalid/non-number/out-of-range | Schema review, no coercion |

The 0.9 positive boundary is an **uncalibrated conservative starting policy**, not a measured precision/recall guarantee. Classification does not establish financial truth or prove payment. Mocked cases do not prove the real model distinguishes invoices from delivery messages.

Optional `positiveThreshold` defaults to 0.9 for existing/custom configurations and accepts only 0.5–1; the negative threshold remains bounded to 0–0.1, preventing overlap. Production configuration sets it explicitly and increments its version. Code-owned `invoice-document-classification-v2` enters the classifier configuration fingerprint, including custom configurations. The versioned processor notice invalidates old consent digests. A fresh processing review/start is required for changed configuration; the patch does not silently authorize it, reprocess paid attempts, delete historical reviews, change saved financial facts or reset allowances.

A bounded `ai_classification_decision` diagnostic contains policy version, part count, encoded state byte count, receipt probability, thresholds and outcome only. No input content, identifiers, subject, sender, category, financial value or raw provider transcript is logged. This supports future redacted live tracing; no such new production log was observed in this task.

## What Clef sees and returns

The pipeline gathers ready decoded text/HTML parts from the source's parsed documents into `[{id,text}]`; the adapter sends this as `state`. It sends no runtime tools or arbitrary destinations, and no invented binary text. The configured Workers AI binding runs `@cf/cloudflare/clef` with `model: "clef"` and both typed questions. The full request prompt and a scripted valid response are in `clef-precision-synthetic-wire-20261014.json`. This is a **representative synthetic scripted transport**, not a captured production request or a real-model inference.

The adapter validates response model, numeric receipt probability, allowed category, category distribution sum/highest-choice consistency and optional typed usage. Missing usage preserves a warning and conservative metering. Ambiguous valid decisions retain reported usage and are durably typed as `uncertain`.

Current primary contracts checked: [Clef model](https://developers.cloudflare.com/workers-ai/models/clef/), [input JSON schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json), [output JSON schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-output.json). The input schema explicitly supports `noul.criteria.true/false`; the output defines `noul` as yes probability. Context7 was unavailable in enabled tools, so official schemas and project-local CLI/types were used.

## Read-only production evidence

Wrangler 4.149.0 `d1 execute --help` verified flags. Executed `pnpm --filter @invoxim/worker exec wrangler d1 execute invoxim-db --remote --json --command <SELECT-only aggregate SQL>` with `WRANGLER_LOG_PATH` under `/tmp`; exit 0, `changed_db=false`, zero rows written. Queries joined `ai_extractions -> documents -> source_messages`, scoped to the requested connection, grouping only normalized classification status/decision/reason. Review queries joined `review_items -> documents -> source_messages`, filtered `status='open'`, and grouped review reason/parse state/parse code. A CTE grouped classifications by actual source before joining open review rows. No raw result JSON or personal metadata was selected. Sanitized results: `clef-precision-aggregate-20261014.json`.

## Tests actually executed

- RED: `pnpm --filter @invoxim/worker exec vitest run test/clef-classifier.test.ts`, exit 1; three expected failures: ambiguous score accepted, missing document-focused criteria, cached `uncertain` rejected. Log `/tmp/invoxim-clef-precision-red.log`.
- GREEN focused initial classifier/config: same runner with `test/clef-classifier.test.ts test/clef-configuration.test.ts`, exit 0, 11 tests. Log `/tmp/invoxim-clef-precision-green.log`.
- Final native regression: `WRANGLER_LOG_PATH=/tmp/invoxim-clef-precision-test-wrangler.log pnpm --filter @invoxim/worker exec vitest run test/clef-classifier.test.ts test/clef-configuration.test.ts test/clef-pipeline.test.ts test/direct-model-pipeline.test.ts test/direct-model-native-headroom.test.ts`, exit 0, **51 tests in five files**, 19.39 s. Log `/tmp/invoxim-clef-precision-native-green.log`.
- Native cases cover exact 0.1/0.9 boundaries, intermediate 0.1001/0.45/0.8999, custom/default thresholds, invalid/overlapping config, strict score types, redacted diagnostics, missing usage, category validation, uncertainty metering with zero financial calls/zero purchases, custom cache policy identity and custom consent invalidation. Eleven contrasting synthetic notification/document examples inspect request criteria and scripted answer routing; **not a model-quality benchmark**.
- Existing runtime integration initially hit its unchanged 5 s limit while dynamically importing the runtime/barrel/SDK dependency graph, before any provider call. Unchanged source in `/tmp/invoxim-mail-perf-clean` reproduced the same timeout: `/tmp/invoxim-clef-precision-baseline-runtime.log`. Diagnostic-only `--testTimeout 20000` passed but was not used as acceptance. Hoisting that import to module collection retains the original behavior timeout and every assertion, including the forty-statement bound; the final ordinary regression run passed. Temporary synthetic import markers were removed.
- Scoped Biome `--error-on-warnings`, ESLint, Prettier check, `git diff --check`, and `pnpm --filter @invoxim/{core,adapters,worker} typecheck` all exited 0. No dependency or migration changes.
- Root `pnpm verify`, production build and browser suite: orchestrator-owned, not executed by this agent for this patch. Independent review: pending at report time.

## Remaining boundaries

The unsupported PDF/binary path is a capability limitation. Do not skip unknown attachment content based on filename or an unrelated body. The separate partial-skip fix avoids unnecessary body extraction while keeping incomplete coverage visible. A follow-up PDF capability probe/conversion decision needs explicit scope and the selected destination's tested capability; this patch adds no converter/storage subsystem.

No real email was exported to a coding-agent prompt or saved to artifacts. No paid synthetic evaluation, live model call, secret change, queue mutation, reset or deployment occurred. Actual precision/recall and missed-invoice rates remain unmeasured until an explicitly approved, cost-capped labeled live evaluation. Existing noisy review rows are not automatically erased.


## Parent integration certificate

Source022e97a plus frontend7ae8b87 independently code-reviewed by /root/langchain_review; queue race finding resolved, no outstanding blockers. Parent clean-source `pnpm verify` exited0:1588Worker integration tests/130files,104browser tests, unit/style/types/build/production publication checks all passed. Details in meaningful-lists-completion-20261014.md. No production deployment or live quality evaluation was performed for this patch.
