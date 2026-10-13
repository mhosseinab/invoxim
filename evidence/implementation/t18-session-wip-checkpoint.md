# T18 encrypted resumable session recovery checkpoint

Status: WIP preserved before an authorization-SQL refactor. No approval, completed archiving feature or live upload is claimed. The initial baseline remains unchanged.

The new forward migration and native session store retain only encrypted upload references, versions, expiry and acknowledged byte counts. The new cipher purpose binds the upload reference to tenant, object and purpose; ordinary credential-vault purposes exclude this payload. Cipher behavior passed native tests after genuine unsupported-purpose RED, and a separate reviewer found no cipher source blocker. Session migration/store runtime approval remains pending.

Native session acceptance tests currently fail with stable `UNAVAILABLE`. A synthetic-only diagnostic exposed the underlying D1 error: `Expression tree is too large (maximum depth 100): SQLITE_ERROR`. The simple parent authorization succeeds, while the nested session query exceeds the native expression-depth bound. Raw diagnostic: `m1-runtime-checkpoints/session-native-depth-diagnostic-v1.txt`. The diagnostic run intentionally selected one test and filtered two acceptance tests.

The next repair must group the existing boolean predicates without deleting or changing any tenant, selected-source, consent, generation, lease, immutable-plan or credential fence. Re-run the real session and existing archive authorization regressions. The temporary diagnostic is not a feature acceptance test and will be removed after the cause is repaired.

Whole resumable orchestration, backfill, queue/UI integration and live provider verification remain incomplete. Original bytes and plaintext session URLs remain prohibited from D1 and queue payloads. No database reset or deployment was performed.
