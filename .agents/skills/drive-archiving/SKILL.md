---
name: drive-archiving
description: "Archive exact originals to explicitly authorized user-owned Drive storage."
---

# drive archiving

## When to use

Storage consent, file upload/retry, archive backfill or original links.

## Inputs

Read root `AGENTS.md`, the assigned task and these files: `docs/04-email-and-storage.md`, `docs/06-security-and-privacy.md`.

## Procedure

1. Keep Drive optional and separate from login/mailbox consent. Request drive.file and create/use an app-controlled folder in the authorized user account.

2. Preserve exact attachment bytes or original .eml for body receipts. Persist a pre-generated file ID before upload and reuse it for ambiguous retries.

3. Treat archive work as independent from financial acceptance. Handle quota, revoked access, deleted folder and missing source without duplicating or discarding payments.

4. Backfill only on explicit request and while originals remain available. Construct safe authorized links; leave user-owned files on service account deletion by default.

## Deliverable

Archive adapter and lost-response/quota/revocation/backfill tests.

## Quality gate

No R2, no whole-drive permission, no duplicate upload after success-with-lost-response, no recovery guarantee for deleted email.

Respect the assigned writable paths. A review assignment is read-only. Record what was actually run and distinguish blocked checks from successful checks.
