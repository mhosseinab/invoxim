---
name: oauth-and-mail-sync
description: "Connect independent mailbox identities and synchronize reliably through provider APIs."
---

# oauth and mail sync

## When to use

Google/Microsoft OAuth, refresh, backfill, incremental sync or reconnect.

## Inputs

Read root `AGENTS.md`, the assigned task and these files: `docs/04-email-and-storage.md`, `docs/06-security-and-privacy.md`.

## Procedure

1. Bind one-use state to the initiating session, purpose, provider and expected redirect. Verify provider account identity separately from app login.

2. Use read-only least-privilege scopes, PKCE where supported and encrypted refresh state. Test missing tokens, revocation and concurrent refresh.

3. Persist fixed-cutoff backfill and incremental state separately. For Gmail capture/replay history and recover expiry; for Graph discover folders and preserve opaque delta URLs/immutable IDs.

4. Respect quotas and continue safely after crashes. Report coverage gaps and unsupported account policies instead of silently claiming complete mailbox scans.

## Deliverable

Provider adapters, synthetic contract fixtures and an opt-in live smoke checklist.

## Quality gate

Login A/mailbox B stays one user; no cursor loss, fabricated OAuth support, broad scopes or plaintext credentials.

Respect the assigned writable paths. A review assignment is read-only. Record what was actually run and distinguish blocked checks from successful checks.

## Version 1.1 presentation responsibilities

For related changes load `.agents/skills/product-presentation-and-onboarding/SKILL.md`. Check explicit review/start before scanning, recent-first full-range import, synthetic/private isolation, truthful capabilities, and optional setup/measurement boundaries. Do not substitute feature-list completeness for a tested path to usable purchase evidence.
