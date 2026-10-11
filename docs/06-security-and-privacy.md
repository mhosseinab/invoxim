# Security and privacy requirements

## Honest privacy boundary

The service sees authorized email content while processing it; selected parser/AI services may also see relevant text or bytes. Moving originals to a user’s Drive and accepting BYOK do not make server-side processing zero-knowledge. Do not advertise that the service “cannot read your email.”

Product commitments: no advertising profiles, sale of data, training on customer content, or unrelated cross-user learning; no analytics containing receipt contents; no external processing without disclosed consent. Verify that configured processors can honor these commitments. Google Limited Use requirements apply to derived as well as raw data. [S29]

Public launch requires accurate privacy/consent notices, processor list and terms, applicable data-protection review, account deletion/export, and the OAuth gate. A checked box in this document is not a legal compliance certificate. Do not assume global Cloudflare execution is EU-only residency. Any residency promise needs separately verified configuration and processor coverage.

## Threat model and controls

| Threat | Required control and proof |
|---|---|
| Cross-tenant access/IDOR | Session-derived tenant context, composite ownership constraints, negative tests for every entity/action/export/job. |
| OAuth login or connection swap | One-time state bound to user/session/purpose/provider; validated identity; fixed redirects; replay/mix-up tests. |
| Token/key leakage | Authenticated encryption, secret bindings, redacted errors/logs, no token responses to browser, no localStorage credentials. |
| Malicious email/attachment | Inert parsing, MIME/size bounds, no remote assets/links, no executable formats, processor isolation. |
| Prompt injection | No model tools; strict schemas; actual destination/authorization constraints; evidence verification. [S30] |
| BYOK endpoint SSRF/exfiltration | Operator-approved exact destinations; HTTPS; no arbitrary redirects, localhost, private ranges, userinfo URLs, or model-selected hosts. [S31] |
| Cost abuse | Login requirement, quotas, atomic budget reservation, rate limits, optional bot challenge, kill switch. |
| Duplicate/replayed jobs | Idempotency keys, fencing, durable state, unique ledger event IDs, crash tests. |
| Delete/disconnect race | Generation barrier; session invalidation; consumer checks before side effects/commit; no resurrection. |
| Supply-chain/agent compromise | Reviewed dependencies/skills, pinned versions, no blind remote install scripts, untrusted external instructions cannot override rules. |
| XSS/unsafe previews | Escaped React text, sanitized inert email representation, no `dangerouslySetInnerHTML` for raw content, CSP and no remote images. |
| CSV formula injection | Escape RFC-compatible CSV; neutralize spreadsheet formula-leading text fields; test whitespace/control prefixes. |

## Credentials

Store OAuth refresh/access tokens that must persist and BYOK keys encrypted with AES-GCM using Web Crypto, fresh nonces, and a versioned server keyring in Cloudflare secrets. Bind ciphertext with authenticated additional data including tenant ID, connection/settings ID, purpose, and key version. Never reuse a nonce with the same key.

No homemade cryptographic primitive or “encryption” via base64. Test encrypt/decrypt, wrong tenant/purpose, tampered ciphertext, nonce uniqueness, and rotation. The server holds decryption keys, so this is protection at rest, not end-to-end encryption.

Keep login scopes separate from mailbox/storage credentials. Avoid retaining login provider access/refresh tokens beyond the auth library’s requirements; encrypt retained ones too. Confirm library defaults rather than assuming its account-token storage is encrypted.

Keys are write-only from the user’s perspective after saving. Test connection with a synthetic non-financial prompt. Never validate a key by sending a real invoice automatically. On key deletion, stop new use immediately and clear its ciphertext. A running request may already be submitted; record that limitation.

## Web/session protections

Secure, HttpOnly, host-scoped cookies; SameSite suitable for the verified OAuth flow; explicit origin checks and CSRF protections for mutations. Do not disable CSRF checks to make a development callback work. Session rotation on login and recent reauthentication for account deletion/credential-sensitive changes.

Use allowlisted callback destinations, CSP, MIME sniffing protection, framing restrictions, and an appropriate referrer policy. Finances/auth endpoints are never cached by a CDN, service worker, or public query cache. Do not put amounts, email addresses, OAuth codes, or provider tokens in analytics URLs.

Expected auth failures return generic user-safe errors while recording redacted correlation IDs. API keys and OAuth codes must be scrubbed from proxy/runtime access logs as well as application logs. Do not enable request/response-body logging or AI Gateway prompt logging without a new explicit privacy decision.

## BYOK network policy

Provider-agnostic means adapters/configuration can be changed; it does not mean a public open proxy. Public users select an approved provider ID and model. Their API key can only be sent to that provider’s configured exact origin/path. Disallow custom headers that can override authorization or routing.

For an operator-added custom provider: review its hostname, DNS/private-address risks, redirect behavior, certificate requirements, request/response limits, and privacy terms. Follow zero redirects by default. Reject IP literals, metadata endpoints, private/local names, credentials in URLs, non-HTTPS schemes, and fragment/query-secret tricks. A hostname suffix match such as `endsWith("vendor.com")` is insufficient.

Cloudflare’s outbound environment is not a guarantee against every SSRF pattern. Prefer an explicit vetted destination registry over a fragile DNS-rebinding defense invented in application code. Document any remaining trusted-operator network assumptions. [S31]

## Data retained and not retained

| Data | Proposed retention |
|---|---|
| Raw messages/attachments/full parsed text/model transcripts | Application memory only; never D1/Queues/logs/cache; external processor behavior separately disclosed. |
| Extracted purchases, ledger, user corrections, minimal source metadata | Until user deletes records/account; no automatic expiry in MVP. |
| User-owned Drive originals | User controls retention; the app does not delete them on ordinary disconnect/account deletion. |
| Connection/BYOK credentials | Until disconnect/key deletion/account deletion; remove local ciphertext promptly. |
| OAuth state | Ten minutes, one use; purge expired states. |
| Completed job details | Seven days of minimal diagnostic metadata; retain only identity/provenance needed to prevent duplicates elsewhere. |
| Failed job metadata | Thirty days or until resolved/deleted; no document text. |
| Redacted operational logs | Minimum practical provider retention; verify actual configured retention before public launch. |
| Usage metadata without prompts | Ninety days while account active; remove on deletion unless a later separately approved billing requirement exists. |

Do not persist full subjects/sender addresses for non-candidates just to support discovery. For skipped messages, retain only a bounded ID/status marker where necessary, or rely on provider cursor state. A database can become an email archive even without attachments if excessive metadata is retained.

## Disconnect and deletion

Disconnect: mark connection inactive and increment generation in one fenced mutation; stop scheduled jobs and clear credentials; retain financial records by default. Offer a separate explicit “delete imported data” action with a preview. When deleting one source, purchases supported by other sources should survive; recompute evidence/eligibility rather than cascading away unrelated records.

Account deletion: require recent authentication; mark deleting, invalidate sessions, cancel/fence jobs, disable further external calls, delete tenant-owned application rows and credentials in bounded batches. Proposed active-data completion target: within 24 hours, with account access disabled immediately. Never display completed deletion while queues can recreate data.

User-owned Drive files remain by default. Provider-side revocation is attempted where supported and safe; failure to revoke remotely is reported distinctly from deleting local credentials. The user can revoke provider access independently.

D1 point-in-time recovery can retain older states for the plan’s recovery window. [S07] Do not promise instant physical erasure from every provider backup. Before any restore, apply an independently preserved minimal deletion journal and test that erased tenants remain erased. Keep only pseudonymous app-user IDs and deletion timestamps in that journal; no email/documents. If a trustworthy post-backup deletion journal is unavailable, do not restore a snapshot into a serving environment. Select the minimal operational storage for this journal during the release runbook, not an app-owned receipt archive.

## Public-release gate

No open signup until Gmail access requirements, disclosed processors, documented retention, secure key management, independent tenant/auth review, budget kill switches, source deletion behavior, and a restore/deletion drill have evidence. Public mode is a deliberate configuration change approved by the owner, not the default output of an agent deploy command.

## Presentation, consent, and usage measurement (v1.1)

Treat visible permission wording as a security contract. Gmail read-only access is mailbox-wide, not a receipt-only technical restriction. [S01] Explain application-level purchase filtering without claiming inaccessible non-receipt mail. Hosted processing remains disclosed even with user-owned Drive/BYOK. Claims about processor retention/training/data use require verified terms; never synthesize a zero-retention promise from a settings flag.

No content discovery or extraction after a callback until explicit import/processing authorization. A changed processor, parser destination, disclosure, or user key mode must be checked against the accepted revision before dispatch and external calls. Require renewed review for material processing changes; reject stale Start forms. Control-plane identity/token validation remains separate. Do not expand scopes or bypass provider warnings to improve a conversion metric.

A public config endpoint uses a field allowlist and exposes no token, key reference/value, OAuth client secret, quota reserve, tenant ID, or private diagnostics. Authenticated disclosure/readiness endpoints are tenant-scoped and not cacheable. Static demo mode contains only synthetic values and cannot fetch private APIs or mingle with user state.

Required product policy: no advertising use or sale of email-derived data, no cross-user model training from receipts, no session replay, and no private content in product analytics. These are implement-and-verify controls, not unsupported statements about competitors. Review the actual Google policies and processing contracts before public claims. [S29, S45]

Optional pilot measurement requires both operator enablement and a separate user opt-in; refusal has no feature penalty and opt-out purges optional events. Never reuse OAuth account security signals for product analytics. Use only the tightly bounded event schema in the data model, no arbitrary event JSON. Account deletion purges pilot records and background sync remains fenced. A validated request to open external evidence measures intent, not proof that the receipt loaded or was read on the provider's website.
