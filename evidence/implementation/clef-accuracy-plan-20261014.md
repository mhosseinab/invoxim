# CLEF-ACCURACY-02 bounded evaluation plan

Status: offline implementation/validation under way. Live calls and saved-auth access await explicit operator cost approval. No live accuracy result is claimed.

## Required behavior

Classify one current document, not a whole source containing unrelated body/attachments. An invoice attached to a shipping email must not make the shipping body an invoice. A body saying “invoice attached” is not itself that invoice. Decoded local PDF text can be classified independently; unreadable/scanned documents remain reviewable without pretending their absent content was evaluated. One Clef request contains receipt yes/no probability and category; financial extraction and validation remain separate.

Keep the current invoice-focused question and 0.1/0.9 routing boundaries until actual synthetic-model results justify a candidate change. A high score does not prove financial correctness. No keyword-based rejection of invoices and no automatic payment inference.

## Evaluation corpus and protocol

- Fixed `test-design/fixtures/clef-development.json`: 80 cases, 40 English/40 German.
- Frozen `test-design/fixtures/clef-holdout.json`: 40 cases, 20 English/20 German. Labels were authored before model calls; do not tune from held-out outcomes.
- Manifest records partition hashes. No model responses or personal email content in the corpus.
- Positive: issued paid/unpaid invoices, sparse/partially missing invoices, paid receipts, credit notes, completed refund confirmation, mixed notification plus actual financial document, HTML and decoded text-PDF invoices.
- Negative: order acknowledgement, shipping/tracking, delivery proof, payment reminder/failure, pending refund, cancellation, quote/pro-forma offer, account summary, renewal/price notice, marketing and injected classification instructions.
- Six unsupported/scanned PDF cases are deterministic review preservation, not Clef inference/accuracy cases. 114 documents are readable: 76 development and 38 held-out.

The production adapter and opt-in Node tool share `clef-protocol.ts` request construction, strict answer validation and routing. Version `document-invoice-classification-v3` marks current-document semantics. The factory cache fingerprint includes only current document metadata, while pipeline source consistency/authorization checks remain intact. Parent/backend own service guards and parser/consent integration.

## Stages

1. Validate corpus hashes, metrics oracle, safe no-network default, exact production protocol, request/response bounds, one-attempt behavior and cost reservation offline.
2. Show the dry-run report and obtain explicit permission for a fixed total monetary/call cap before auth access or inference. Wrangler `auth token --json` is a documented existing auth path; capture in memory only. No credential-file access, new token, secret, endpoint, deployment or infrastructure.
3. Run development only first. Inspect false positives, false negatives, positive/negative abstentions and coverage. Treat numeric scores as uncalibrated.
4. If necessary, use development scores to propose a threshold candidate without another model call; change a prompt only for a demonstrated failure class. Additional prompt calls need to fit the already approved total cap.
5. Freeze candidate protocol hash, configured thresholds and dataset hashes before held-out inference. Evaluate the held-out set once, with separate denominators and an honest count of inspections. Do not call a reused held-out set unseen.
6. Adopt only a supported improvement with explicit tradeoffs; preserve unsupported review, metering, user-selected destinations and existing saved facts. If live auth/cost approval is unavailable, deliver the harness and report accuracy as unmeasured.

## Limits and reporting

Dry-run at initial plan preparation: 120 cases, **114 planned calls**, complete JSON request <=8 KiB, conservative total reservation **93,532 USD micros ($0.093532)** at the configured Cloudflare tariff. This is a reservation estimate, not a guarantee against a provider tariff/billing change.

Suggested approval: <=240 total requests and <=$0.30 total across all explicitly tracked phases. Use separate per-invocation caps (for example $0.10 development baseline, $0.10 development candidate if needed, $0.05 held-out) rather than reusing the full approved cap for every command. No concurrent eval processes.

Sequential calls; no retries; 30-second call deadline; 20-minute run deadline; 16 KiB response bound; fixed Clef endpoint; abort on interrupt, provider error or usage overrun. Missing/error usage retains its conservative reservation. Failed/uncertain responses never count as successful receipt decisions. Report precision, recall, false positives, silent false negatives, positive/negative abstentions, unsupported reviews, errors and decision coverage. Recall denominator includes positive abstentions so “review everything” is not good performance.

Evidence commands so far: `node --test tools/implementation/clef-eval.test.mjs` (offline); `node tools/implementation/clef-eval.mjs --out /tmp/invoxim-clef-eval-dry-run.json` (zero auth/network). Full results and executed counts belong in the completion report, not this plan.
