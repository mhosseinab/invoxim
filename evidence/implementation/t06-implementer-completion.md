# T06 implementer evidence

Task: T06, M0, credential vault and connection OAuth state. Dependency: T04 completed by root. Status: implemented / pending final independent certification. Frozen component identity: `t06-implementer-source-sha256.txt` (includes the final README truthfulness correction). Shared exports, manifests, binding/composition and T05 login code remain root/auth-agent owned.

## Implemented behavior

A dependency-free native Web Crypto AES-256-GCM cipher accepts a validated versioned server keyring, encrypts only with the active key, reads retained older keys, uses fresh 12-byte random nonces and 128-bit tags, and authenticates a deterministic tuple of trusted tenant/entity/purpose/key version. Purpose payloads permit only bounded provider token fields, a BYOK key or PKCE verifier. Unknown fields, malformed envelopes, tampering and tenant/entity/purpose/version swaps fail safely. UTF-8 encoded plaintext is bounded before encryption, matching the ciphertext/decryption bound.

The D1 vault stores authenticated ciphertext for independent connection credentials and one stable `primary` BYOK slot per user. Save/refresh/rotation use expected credential version, generation, active profile/state and atomic CAS. Missing refresh tokens remain preserved for both refresh and reconnect save. Decryption is followed by a second row/version/generation/cipher/profile check before a secret is returned internally. Rotation cannot downgrade newer key versions. Clear physically removes ciphertext/key-version, advances version/generation and disables connection scheduling or leaves a deleted BYOK barrier. Secret reads remain internal; metadata contains only configured/version/key-version/generation. Security-only boundary error mapping preserves allowlisted codes while discarding unexpected driver messages, stack, cause and payload.

The connection OAuth store issues random state/nonce, persists only SHA-256 state and encrypted PKCE, and binds user/session/purpose/provider/exact server-configured HTTPS callback. Session authority, active profile and current session expiry are checked at creation and winning consumption. Lifetime is at most ten minutes. Consume decrypts then conditionally compares every binding, expiry, unchanged ciphertext/key-version/nonce and current session/profile before clearing PKCE/nonce and marking consumed. Exactly one caller receives the verifier. Wrong binding does not consume legitimate state. Expiry purge is tenant scoped and limited to 100 rows.

Migration 0004 adds connection CAS version plus ciphertext/key-version paired integrity; a single encrypted BYOK settings row; composite session ownership; and bounded/indexed OAuth state. Valid populated legacy ciphertext survives upgrade with credential version zero; invalid old pairs fail closed without rewriting values. AI selection, external provider code and complete disconnect/account deletion are excluded.

Authored files: packages/adapters/src/security/{cipher,errors,types,vault,oauth-state}.ts and README.md; packages/adapters/migrations/0004_credentials_and_oauth.sql; apps/worker/test/vault.test.ts; t06-implementer evidence. Independent QA owns vault-adversarial.test.ts. No other writer's source files were edited.

## Actual execution evidence

Local real workerd/Miniflare D1 and Web Crypto, pinned existing monorepo toolchain. Primary Web Crypto references were verified by root; no new dependency was added.

- Initial RED: `WRANGLER_LOG_PATH=/tmp/invoxim-t06-wrangler.log WRANGLER_SEND_METRICS=false pnpm --filter @invoxim/worker exec vitest run test/vault.test.ts`, exit 1, one behavioral assertion failed: tenant B could open tenant A data with the temporary missing-AAD implementation. Artifact `t06-implementer-red.txt`. The temporary implementation was replaced with authenticated native encryption before GREEN and is absent from final source.
- Stale-version RED: same scoped command, exit 1, four pass/one fail. An old configured keyring incorrectly attempted decrypting the already-rotated newer row before checking stale expected version. Artifact `t06-implementer-red-stale-version.txt`; fixed with version guard before decrypt.
- Driver-error RED: exit 1, six pass/one fail; an injected synthetic driver message escaped the adapter. Artifact `t06-implementer-red-driver-error.txt`; safe-code/message/stack/serialization regression now passes.
- Reconnect RED: exit 1, seven pass/one fail; a reconnect save omitted refresh token and erased the existing value. Artifact `t06-implementer-red-reconnect.txt`; retention under CAS now passes.
- Pair-integrity RED: exit 1, seven pass/one fail; a connection key-version-null mutation wrongly succeeded. Artifact `t06-implementer-red-pair-check.txt`; additive CHECK and populated encrypted upgrade now pass.
- Final GREEN: same command selecting `test/vault.test.ts test/vault-adversarial.test.ts`, exit 0, 20 tests / 2 files (8 implementer + 12 independently authored QA). Artifact `t06-implementer-green.txt`.
- `pnpm exec prettier --check packages/adapters/src/security apps/worker/test/vault.test.ts`, exit 0: `t06-implementer-format.txt`. Final README-only correction additionally passed its direct format check.
- `pnpm exec eslint packages/adapters/src/security apps/worker/test/vault.test.ts`, exit 0: `t06-implementer-lint.txt`.
- `pnpm --filter @invoxim/adapters typecheck`, exit 0: `t06-implementer-types.txt`.
- `pnpm --filter @invoxim/adapters build`, exit 0 (TypeScript build check): `t06-implementer-build.txt`.
- `pnpm --filter @invoxim/worker typecheck`, exit 0: `t06-implementer-worker-types.txt`.

Independent QA separately recorded actual swaps/tampering/nonce sampling/version AAD/rotation and a Unicode byte-limit RED before the consistent encoded-byte fix. Its storage/state diagnostic covered real concurrent refresh, clear during asynchronous decrypt, late save, tenant/session/purpose/provider/callback bindings, one winning consumption, ciphertext clearing, expiry/purge scoping and session expiry during decrypt. Those results belong to QA's reports; this report does not impersonate independent certification. A mid-edit T05 full diagnostic hit the deliberately failing connection pair assertion before the constraint was applied; its start time was 12:04:41, while final component GREEN started 12:05:11. Root's fresh frozen full verification remains required.

Acceptance exercised: SECRETS-01 encrypted persistence, safe metadata/error projection and clear barriers; SECRETS-02 tenant/entity/purpose/version and ciphertext authentication failures; SECRETS-03 retained-old-key read / active-key re-encryption / stale CAS and no downgrade; SECRETS-04 concurrent persistence refresh and omitted-token preservation including reconnect. Supplemental actual D1 tests exercise clean installation in QA, populated encrypted upgrade, strict paired fields, foreign-key check and EXPLAIN QUERY PLAN use of oauth_states_tenant_expiry. A sample of distinct random nonces is observed, not an exhaustive mathematical uniqueness proof.

## Effects and remaining work

No actual provider token, key, customer message, original document, model transcript or live identity was used. All repository fixtures and driver-error markers are explicitly synthetic. No provider call, real OAuth grant, external credential validation, secret creation, deployment, production migration or billable inference occurred. At-rest encryption protects storage; the trusted runtime/operator holds decryption keys.

These are ports constructed and exercised in tests, not currently wired mailbox/AI settings routes. Worker callers must supply platform-secret keyrings and approved callback configuration. T05 app-login state is a separate auth-library responsibility and never uses a fabricated TenantContext. T08/T11 integrate the vault, recent-authentication and safe settings/export DTOs. Existing-key deletion cannot implicitly recreate a BYOK slot; explicit reactivation belongs to T11. Saving a key does not select an AI provider/mode or authorize processing.

T07/T08 must serialize external provider refresh before submitting requests and check generation immediately before external effects. CAS here protects persistence, not two concurrent network refresh requests. A request already submitted before clear may finish; no remote cancellation/revocation or full T15 disconnect/deletion/recovery completion is claimed. OAuth PKCE inputs must come from trusted connector code, not request-selected arbitrary verifier data.

Final full repository verification/db gate and independent read-only approval are pending root/QA certification at this report's write. The implementer has not run or claimed full pnpm verify, live provider tests, deployed resources, production security assessment, or completed M0.
