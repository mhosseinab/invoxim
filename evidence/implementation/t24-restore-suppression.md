# T24 isolated restore suppression

Status: bounded internal helper locally verified with eight passing native cases, including the reproduced and repaired constructor-pinning regression. Independent review and deployed recovery readiness remain incomplete; T24 remains in progress. No cloud restore, deployment, independent production journal access or real customer data was used.

## Trusted procedure and boundaries

Owned source is `packages/adapters/src/lifecycle/restore.ts`; native tests are `apps/worker/test/restore-suppression.test.ts`. There is no HTTP recovery endpoint, new Worker binding, SDK, resource, migration or Time Travel automation. The caller supplies the existing native D1 invocation meter and a trusted operator procedure.

`RestoreOperator.assertIsolated()` must verify the actual destination is nonserving and consumers are stopped. It cannot be implemented by trusting a submitted JSON boolean. `readReviewedPage()` may return a page only from an independently authenticated, immutable journal export whose completeness was reviewed by the recovery operator. Synthetic tests substitute this procedure; they do not prove production independence, completeness or isolation. A journal acknowledgment from the application append port alone is insufficient.

The expected snapshot identity/time, recovery cutoff and export identity are operator inputs, validated, copied and frozen at construction. Later mutation of the caller's descriptor cannot change the reviewed recovery. Page metadata must match the expected snapshot/export and its watermark must cover the cutoff. Strict pages contain at most ten validated pseudonymous deletion markers, with independently retained deletion timestamps no later than that cutoff, a page number and an optional bounded cursor. Unknown fields such as `verified: true` are rejected. Memory does not retain the full journal. The page sequence is capped at 1,000 pages; larger exports require a separately reviewed procedure and cannot silently reconcile through this helper.

Operator-held checkpoints are private recovery progress, not request/session authority or a serving permission. They are tied to snapshot/export identities. Restore inputs/checkpoints must never become public app APIs or analytics. Checkpoint provenance, immutable export identity and complete page coverage are responsibilities of the trusted operator procedure; the helper does not authenticate arbitrary checkpoint JSON.

## Bounded sequence

1. Keep the restored database, frontend ingress, API and background consumers isolated. Retain the independent journal and original backup separately. Do not enable serving merely because one unit completed.
2. Repeatedly invoke one recovery unit with a fresh existing 40-statement meter. A keyset sweep selects one restored user and clears at most 100 directly selected rows per credential/session/consent/job table; it repeats that user until the dirty sets are empty. Existing deletion barriers are retained. Mail/storage/BYOK credentials and pending login/OAuth states are invalidated, processing consent revoked, jobs canceled/fenced and archive consent disabled. Surviving users retain their financial records and must explicitly reauthorize; an old snapshot cannot establish current external grants.
3. Replay one independently reviewed marker per unit into the existing deleting-profile/account-deletion barrier. A newer existing timestamp/request is never overwritten by an older marker. An identical accepted marker preserves cleanup progress. An accepted newer marker restarts leaf cleanup. Unknown/absent users are harmless. No remote revocation or user Drive deletion is performed.
4. Reuse `createLifecycleCleanup(...).runOne()` to drain existing leaf-first deletion in bounded units. Missing journal acknowledgment or orphan deleting profiles refuse reconciliation. Cancellation and existing tenant/lease guards remain in the established implementation.
5. Even after local reconciliation, every result reports `servingAllowed: false`. Independently verify the complete journal sequence, absence of erased tenants, invalidated sessions/credentials, restored job/consent state, current configuration and resources, provider/budget reconciliation and the approved recovery window before any separate owner-approved serving change.

Isolation is checked on every unit and again after awaited journal review before database effects. No private operator error, D1 error/cause, SQL or marker is placed in the stable `RESTORE_REFUSED` error. No telemetry or console logging was added.

## Actual evidence and remaining checks

Root broker ran RED in `/tmp/invoxim-resume-restore-red-v1.txt`: exit 1, all five initial restore cases failed for missing behavior, with valid auth/background positive controls. The combined run also contained three unrelated Drive protocol stub failures. This is behavioral RED, not an import failure.

Root then ran `/tmp/invoxim-delta-restore-operational-check-v1.txt`: all seven restore cases passed in one file. The combined command exited 1 for two separate Outlook/root-null-count RED cases, with 23 passing of 25 total tests and 12.61 seconds runner duration. The overall mixed command is not reported as passing. Worker typecheck `/tmp/invoxim-worker-next-types-v1.txt` exited 0 at that snapshot.

The tests use a restored pre-deletion synthetic account A and independently held later marker. A real signed Better Auth session and production JobStore checkpoint are valid before suppression; both old auth and background ownership are denied before physical financial erasure. They cover surviving account B's preserved financial rows plus explicit reauthorization, malformed/incomplete/wrong-snapshot exports, rejected JSON authority flags, more-than-ten marker refusal, isolation loss before/after journal review, newer barrier preservation, reviewed pagination and erasure of 105 audit leaves with at most 100 removed per unit. Each actual native unit asserts the shared invocation count does not exceed 40 statements.

The constructor-pinning regression reproduced in `/tmp/invoxim-resumable-restore-pin-check-v1.txt`: exit 1, its intended mutation case failed with `RESTORE_REFUSED` instead of retaining the original pinned descriptor; the other seven restore cases remained green. The combined eight-file run reported one failed and 122 passed tests in 15.47 seconds. Root executed the command; the implementer inspected the log. The fix captures a validated copied/frozen descriptor at construction.

Final native evidence: `/tmp/invoxim-restore-delta-runtime-green-v1.txt`, all eight restore tests passed in one file, including the pin regression. The combined nine-file run exited 1 solely for an unrelated Outlook delta `UNAVAILABLE` failure, with 50 passing of 51 total tests and 21.45 seconds total runner duration. Root executed this native run; the implementer inspected its output. The mixed suite's exit 1 is not represented as a complete passing repository gate. Final whole-source verification and independent review belong to root.

Actual scoped checks after the pin fix each exited 0:

- `pnpm exec prettier --check packages/adapters/src/lifecycle/restore.ts apps/worker/test/restore-suppression.test.ts`
- `pnpm exec biome check packages/adapters/src/lifecycle/restore.ts apps/worker/test/restore-suppression.test.ts` (two files, 6 ms)
- `pnpm exec eslint packages/adapters/src/lifecycle/restore.ts apps/worker/test/restore-suppression.test.ts`

Initial scoped Biome found import ordering/location issues; those were corrected before these passing checks. No independent review is claimed here.

Frozen SHA-256 after the fix:

- `packages/adapters/src/lifecycle/restore.ts`: `eb324c315cf512751f88619d21f4561973c41bad4ecd458bdf8dfcec031759a1`
- `apps/worker/test/restore-suppression.test.ts`: `e8cbc0b2803338cbd7eb7de785289433e77d9677c41b64a53dee41d83f0e22f0`

## Operational, privacy and cost limits

Only synthetic identities and synthetic credential placeholders were used. No credentials were decrypted, no provider called and no original bytes retained. No provider charge was incurred by this helper. Test runner wall duration is observed; actual Cloudflare CPU, resource cost, D1 scanned-row distributions, production journal durability, restored-provider revocation and cleanup cadence remain unmeasured. The 40-statement execution bound is enforced in the native tests, not a claim of Free-plan CPU viability.

Direct sweep selections are limited to 100 rows per table, while existing foreign-key cascades can remove dependent transient auth metadata. Full account financial erasure uses existing bounded leaf cleanup. This report does not infer a production deletion-time guarantee from a small synthetic fixture. Usage/provider outcomes restored from the past must be separately reconciled before enabling inference; local credential invalidation does not establish provider billing history or remote revocation.

Owner prerequisites M09/M12 remain pending: independently durable journal/export access and completeness review, actual isolated restore resources and recovery ownership, current grant/budget reconciliation, monitoring/incident ownership and a separately approved serving/deployment change.

## Final independent checkpoint review

Separate read-only reviewer `/root/discovery_review` approved the bounded helper after inspecting pinned descriptors, trusted export/isolation boundary, pre-cleanup invalidation, newer-barrier preservation and actual native evidence. No reviewer execution or edits. Root subsequently executed the unmixed four-file FX/restore check: exit 0, 31 tests (including all eight restore cases), 12.06 seconds; `m1-runtime-checkpoints/fx-restore-green-v1.txt`. Actual external isolation, journal authenticity/completeness and production restore release remain operator requirements.
