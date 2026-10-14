# Standalone classification/content improvement plan

Owner requested implementation in a standalone worktree, minimal evaluation, and current-message-informed threshold tuning. Parallel content/PDF and AI/pipeline implementers plus independent read-only reviewer explicitly approved. Worktree: /home/geek/.codex/worktrees/invoice-classification-improvements/invoxim, base cd6a990. Main checkout and production are not implementation targets.

Plan:
1. Preserve bounded readable attachments when a covering body exceeds content limits. Reduce oversized HTML to inert visible source text before treating it as oversized, preserve evidence provenance and exact whole-source identity; genuinely lossy selection remains explicitly reviewable. Narrow safe common PDF compatibility fixes within existing unpdf runtime; retain resource/active-content checks.
2. Ask Clef financial-document type in the same request as receipt/category, validate the typed distributions and exclude known nonfinancial documents. Keep mandatory classification and versioned policy/cache identity.
3. Add explicit uncertainAction routing: valid plausible uncertainty may use the already-selected financial provider through the existing metered/fenced path; failures/schema/outages/known negatives never bypass classification. Require actual financial document type before accepting escalated model output.
4. Repair reproducible response-contract compatibility and improve schema prompt clarity without coercing financial values or accepting unsupported facts. The real persisted Abacus schema failure lacks a detailed trace; do not invent its exact cause.
5. Tune conservatively from existing scores/outcomes, focused deterministic regressions and current operational aggregates; no new evaluation framework or paid model benchmark. Full repository verification remains required.

Current-message evidence: 275 imported sources, 56 negative/one positive/10 uncertain/six outage Clef caches, zero manual correction labels and zero purchases. Earlier redacted live probabilities: negatives .0186/.0722, uncertain .181/.2195, candidate .9603. This does not justify a lower automatic-positive cutoff or establish accuracy. Retain .1 negative/.9 positive and make bounded verification of plausible uncertainty the initial routing adjustment. No new private email/model output is loaded into coding-agent context or persisted.

Acceptance: long HTML invoice normalization, oversized body plus intact invoice PDF, malformed/active/bomb PDF rejection, explicit invoice-vs-delivery routing, score/type contradiction, valid uncertain escalation to selected provider only, nonfinancial verifier rejection, null optional response envelopes, missing usage accepted conservatively, no extra billed repair loop, stale/consent/cache/shared40SQL guards. Tests prove behavior, not model quality.

Baseline before implementation: pnpm test:unit exit0 (known pre-existing expected-failure tracked); focused native six files98tests exit0, logs /tmp/invoxim-classify-baseline-{unit,native}.log. Install pnpm --frozen-lockfile exit0. No credentials copied into worktree.

Parent owns config, consent notice, integration/docs/backlog and scoped commits. Content agent owns documents/PDF/core direct-model tests. AI agent owns classifier/HTTP/coreAI/pipeline plus necessary synthetic wire fixtures. Reviewer edits/executes nothing. No merge, deployment, migration, reset, new processor/storage/OCR service or live replay is authorized by this worktree task. Vision/OCR remains a later runtime change.
