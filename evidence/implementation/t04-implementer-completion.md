# T04 implementer evidence

Task: T04, M0, Implement D1 schema and tenant repositories. Status: implemented / pending final independent certification. Source identity: `t04-implementer-source-sha256.txt`. Root owns shared package manifests, dependency lockfile, opaque core TenantContext, Worker test bindings/declarations, and integration scripts; this implementer did not edit those shared paths.

## Implemented scope

Versioned local D1 migrations include the pinned generated Better Auth 1.7.7 user/session/account/verification schema, profiles, independent mailbox/storage connections, explicit consent, consent-bound import parents, recent/older and independent live slices, source messages, source-part documents, bounded versioned observations, purchases/evidence, exact ledger entries, and durable job-compatible generation/lease/fence columns. Application migrations use composite tenant/parent keys, natural source/evidence/business-event uniqueness, globally unique queue job IDs, and scoped/due indexes. Connection scheduling defaults to awaiting_import. Unknown purchase total and currency remain null. The direct conditional SQL decision is recorded separately by root in `t04-persistence-decision.md`.

Narrow repositories accept opaque trusted TenantContext on every operation. Purchase reads/list joins, optimistic merchant edits, versioned deletes and exact currency totals remain scoped to that context. beforeDate is an exclusive filter, not a continuation cursor. Atomic accepted-source persistence checks exact lease, generation, active profile/connection/schedule and the job's exact current background-processing consent on every statement. Accepted sources/documents become processed/extracted. Stale writes do nothing; any immutable part/observation/canonical financial purchase tuple/event/association conflict aborts the whole D1 batch with typed CommitConflictError. Existing needs_review observations retain their review barrier. Exact replay preserves canonical natural identities, merchant edits and record version.

Amount bindings pass the core per-entry bound and explicit Number.isSafeInteger validation; aggregate reads cast individual amounts to decimal text and reduce bounded chunks with BigInt. No SQLite SUM-to-number path exists. Metadata has explicit bounds/allowlists and observation JSON is generated from five whitelisted fields with a required integer schemaVersion; extra retained payload keys are rejected.

Files authored: packages/adapters/src/{auth-schema,index,purchases,raw.d,sources}.ts; packages/adapters/migrations/{0001_auth,0002_records,0003_indexes_and_schedule}.sql; packages/adapters/README.md; apps/worker/test/database.test.ts; t04-implementer evidence. QA independently owns database-adversarial.test.ts.

## Actual execution evidence

Environment: local Cloudflare Vitest plugin 1.4.0 / workerd, local Miniflare D1 only; pinned monorepo toolchain. No deployed or remote database was used.

- RED: `WRANGLER_LOG_PATH=/tmp/invoxim-t04-wrangler.log WRANGLER_SEND_METRICS=false pnpm --filter @invoxim/worker exec vitest run test/database.test.ts`, exit 1, one assertion-level failure: actual A purchase / B observation association incorrectly resolved successfully before the missing observation composite FK was added. Artifact: `t04-implementer-red.txt`. An earlier nullable-total CHECK setup error was corrected before recording this behavioral RED; it was not counted as RED.
- Final GREEN: same command selecting both `test/database.test.ts test/database-adversarial.test.ts`, exit 0; 20 tests, 2 files (6 implementer + 14 independent QA). Artifact: `t04-implementer-green.txt`.
- `pnpm exec prettier --check packages/adapters apps/worker/test/database.test.ts`, exit 0: `t04-implementer-format.txt`.
- `pnpm exec eslint packages/adapters/src apps/worker/test/database.test.ts`, exit 0: `t04-implementer-lint.txt`.
- `pnpm --filter @invoxim/adapters typecheck`, exit 0: `t04-implementer-types.txt`.
- `pnpm --filter @invoxim/adapters build`, exit 0 (TypeScript build check): `t04-implementer-build.txt`.
- `pnpm --filter @invoxim/worker typecheck`, exit 0: `t04-implementer-worker-types.txt`. Earlier missing SQL raw-module declarations caused exit 2; root corrected the shared test declaration before the final run.
- Independent QA recorded additional genuine RED failures before the conflict, lifecycle, purchase-tuple and review-barrier corrections. Those commands/results belong to its t04-qa evidence, not an invented self-review. Final clean full verification and root db:check are pending at this report's initial write.

Acceptance exercised: DB-01 composite cross-tenant document/evidence/ledger rejection and strict retained observation payload; DB-02 concurrent source/part replay, event idempotency, tenant-independent reuse and conflict rollback; DB-03 clean D1 installation in QA and populated 0002-to-0003 forward upgrade preserving data/defaults/constraints with actual EXPLAIN QUERY PLAN index assertions; DB-04 hostile list/detail joins/update/delete, forged other-tenant job, null unknown values and exact tenant totals. Supplemental tests exercise late batch failure, lease/fence/expiry/generation/consent staleness, canonical purchase financial conflicts, preserved manual merchant/version and the observation review barrier.

Exact aggregate evidence: 1,002 bounded entries of 9,000,000,000,000 minor units produce the independently written expectation 9,018,000,000,000,000, beyond 2^53. A refund-only USD total remains -1200 net. No staging latency/p95 measurement or production capacity claim is made.

## Effects and remaining work

No raw message bodies, originals, model responses, arbitrary job payloads or provider credentials are stored by these repositories. Credential columns reserve encrypted ciphertext/key-version storage; no credential-encryption or auth-provider token-write implementation is claimed. Auth columns remain generated library schema. No external provider call, secret, new hosted resource, deployment, production migration or billable inference was performed.

Explicit exclusions: verified sessions/Google login (T05), credential lifecycle (T06), job claiming/dispatch/scheduling (T07), extraction/reconciliation/AI revision readiness (T11/T12), review resolution and full account deletion/disconnect/cancellation (T14/T15), M1 Drive/FX/recurrence/pilot tables. Future auth/job adapters must construct trusted context only from verified authority. Future reconciliation must supply grounded validated accepted facts and handle typed conflicts through review/versioned resolution. Ledger observation references deliberately block deleting retained evidence, so T15 must test complete deletion order and cancellation; this task does not certify deletion/disconnection behavior.

Independent certification: runtime_qa and discovery_review are assigned by root. Final independent full verification and read-only approval must be recorded by those roles/root before T04 is marked done. No open task completion or live capability is claimed by this implementer report.
