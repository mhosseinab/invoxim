---
name: security-and-privacy
description: "Review identity, data access, credentials, processors and adversarial input boundaries."
---

# security and privacy

## When to use

Security review, consent/data retention, provider configuration or public-release readiness.

## Inputs

Read root `AGENTS.md`, the assigned task and these files: `docs/06-security-and-privacy.md`, `docs/10-decisions-and-release-gates.md`.

## Procedure

1. Map trust boundaries and enumerate assets before review. Include provider tokens, derived purchase data, Drive links and the operator access surface.

2. Inspect tenant scoping, CSRF/state replay, credential encryption/AAD, endpoint allowlists, inert MIME/AI and logging/redaction. Request reproducible tests rather than assurances.

3. Check deletion races, backup restoration, processor terms and raw-data retention. Hosted processing is not zero knowledge just because originals go to Drive.

4. Return severity-ranked findings with affected locations, repro and required tests. Do not fix your own review findings or authorize external verification/public launch.

## Deliverable

Read-only security report with blockers, evidence and narrowly scoped remediation tasks.

## Quality gate

No fabricated security assessment, compliance certificate or claim that encryption makes operator access impossible.

Respect the assigned writable paths. A review assignment is read-only. Record what was actually run and distinguish blocked checks from successful checks.
