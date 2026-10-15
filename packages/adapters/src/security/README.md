# Credential, OAuth-state and token primitives (T06, SEC-1, SEC-2)

## Credential cipher

Worker callers construct `createCredentialCipher` from a versioned platform-secret keyring. Production keys belong in Cloudflare secrets; tests use explicitly synthetic disposable values. Each base64url key decodes to exactly 32 bytes. The active key alone encrypts; retained older versions decrypt during controlled rotation. AES-256-GCM uses a fresh native Web Crypto 12-byte random nonce, 128-bit tag and deterministic JSON-tuple AAD containing schema version, trusted tenant ID, entity ID, purpose and encryption-key version. This protects storage, not operator access or end-to-end confidentiality.

Purpose-bound payloads (`types.ts`) are mailbox or storage token fields, a BYOK key, a PKCE verifier, or an archive upload session (HTTPS URL without credentials or fragment, Drive file ID and SHA-256). Unknown fields, oversized values and invalid versions are rejected. Plaintext is bounded by UTF-8 bytes before encryption, consistently with the decryption limit. Envelopes contain only schema version, key version, nonce and authenticated ciphertext; malformed envelopes, swaps and tampering fail with redacted codes (`errors.ts`).

## Credential vault

`createCredentialVault(db, cipher)` accepts opaque core TenantContext and a target connection ID/current generation or the single BYOK settings ID `primary` (stored on the user's `ai_settings` row). `save`, `refresh`, `rotate` and `clear` take an expected credential version. These writes check the active profile, generation and record version atomically; older configured key versions cannot downgrade newer stored ciphertext. Connection refresh and reconnect save preserve an omitted refresh token. Explicit clear removes ciphertext/key-version fields, increments credential version and generation, and disables the connection schedule or marks the BYOK row deleted. The vault never recreates a deleted BYOK row; reactivation is a separate settings write owned by `ai/settings.ts`. `read` is for trusted internal processing only, never settings/export/browser responses, and checks the row again after asynchronous decryption. `metadata` returns only configured/version/key-version/generation fields. Unexpected driver errors are mapped to fresh safe CredentialError values without retaining original message, stack, cause, SQL or payload.

## Connection OAuth state

`createOAuthStateStore(db, cipher, {callbacks, clock})` is for independent mailbox/storage authorization. The callback registry is server configured, purpose/provider keyed and exact HTTPS; requests cannot override destinations. Creating state requires a verified session-authority TenantContext and a live session belonging to that user. State and nonce are independently random 32-byte base64url values. D1 retains only the SHA-256 state hash (`stateHash`), initiating user/session/purpose/provider/fixed callback, encrypted PKCE, nonce and a ten-minute lifetime. Callback consumption checks every binding, current profile/session/expiry, decrypts PKCE, then atomically compares the original ciphertext/key-version/nonce and all current bindings before clearing PKCE/nonce and marking consumed. Only one caller receives the verifier and nonce. Wrong bindings leave a legitimate state unconsumed. Tenant-scoped expiry purge is bounded to 100 rows. PKCE supplied to this port must come from trusted connector code, not a public request field. Code exchange in `mailbox/google-oauth.ts`, `mailbox/outlook.ts` and `drive/authorization.ts` requires the returned nonce. App-login state is Better Auth's separate responsibility (see `src/auth`).

## Signed tokens (`token.ts`, SEC-1)

`signToken(domain, payload, secret)` and `verifyToken(domain, token, secret)` are the one HMAC-SHA-256 format for three domains, each keeping its historical wire format byte-identical: a token is `body.signature`, both unpadded base64url, where the body is the UTF-8 payload and the signature covers `prefix` plus either the encoded body or the decoded payload.

| Domain             | Module                           | Prefix                          | Signs   |
| ------------------ | -------------------------------- | ------------------------------- | ------- |
| Onboarding review  | `onboarding/token.ts`            | `invoxim.onboarding.review.v1:` | payload |
| FX period          | `fx/period-signing.ts`           | `invoxim.fx.period.v1:`         | body    |
| Workspace mutation | `corrections/workspace-token.ts` | none                            | body    |

Verification requires exactly two non-empty parts, canonical base64url decoding for both, a 32-byte signature and fatal UTF-8 decoding that keeps any BOM, so a re-encoded payload-signed token cannot re-verify. Any failure returns `null`.

## Shared helpers (`helpers.ts`, SEC-2)

Single definitions of `encodeBase64url`, the strict canonical `decodeBase64url` (no padding, round-trip required, at most 40000 characters), `stateHash`, `pkceVerifier` (64 random bytes), the HMAC `signingKey` import, bounded `noticeText`, `safe` (rethrow owned errors, wrap the rest), `abortable` (race against an `AbortSignal`) and base64url JSON cursor encode/decode; `sha256Hex` is re-exported from `src/hash.ts`. `isAllowedEmail` lives in `auth/configuration.ts`. Drive modules use these helpers; some call sites still keep local copies, for example the PKCE verifier in `mailbox/service.ts` and `noticeText` in `ai/configuration.ts`.

## Caller obligations

Callers derive context/session ID from verified authority and enforce origin/recent-authentication rules for sensitive mutations. Provider token refresh is serialized by `refreshSealedCredential` (see the package README) and generation is rechecked before external effects; persistence CAS alone cannot make two simultaneous provider refresh requests safe. A request already submitted before clear may finish; these helpers do not claim remote cancellation. Login, mailbox permission, processing authorization and archive permission remain separate. No network request, custom provider endpoint, cost, secret creation, live OAuth, provider revocation or deployment is performed by these helpers.
