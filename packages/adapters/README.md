# @invoxim/adapters

Provider, persistence and Worker-facing adapters for the core package. Module READMEs: [auth](src/auth/README.md), [security](src/security/README.md), [jobs](src/jobs/README.md), [ai](src/ai/README.md), [documents](src/documents/README.md), [pipeline](src/pipeline/README.md), [lifecycle](src/lifecycle/README.md). Mailbox, discovery and Drive have no README of their own and are summarized below.

## Public surface

`package.json` exports only `src/index.ts`. After SW-3 that barrel is an explicit list of named re-exports (no `export *`) containing the names consumed outside this package; internal helpers such as `src/http.ts` readers, `src/hash.ts`, `security/token.ts` and `security/helpers.ts` stay package-internal. From `src/http.ts` only `BoundedJsonError` and `boundedJsonResponse` are exported. `ai/budget.ts` remains a re-exporting facade over the AI-7 split modules.

## Shared HTTP reader (`src/http.ts`, SEC-4)

- `readBoundedJson(body, maxBytes, { signal?, deadline? })` copies at most `maxBytes` into a fixed buffer and parses UTF-8 JSON with a fatal decoder. More than 4096 data chunks, more than 32 empty chunks, or a chunk past the byte cap fail as `too-large`. Every read races one promise that rejects at abort or at the deadline, so a source whose pull never settles (and that ignores cancel) still fails as `aborted`. The reader is cancelled on any incomplete read.
- `readJsonRequestBody` requires `application/json` and rejects a declared `Content-Length` above the cap before streaming. `readJsonResponseBody` refuses any 3xx response as `redirect` before reading the body (callers fetch with `redirect: "manual"`), then applies the same length check. A missing or malformed `Content-Length` falls through to the streamed cap.
- `boundedJsonResponse` serializes under the 128 KiB Worker response cap (W8), sets JSON content type and `Cache-Control: no-store` unless one is supplied, and throws `too-large` so the caller can produce its own 413.
- Consumers of the reader: `auth/http.ts` (`readAuthJson`), `ai/http.ts` and `mailbox/provider-json.ts`. Discovery transports, pipeline content readers, Drive requests and `documents/original-mail.ts` still keep their own bounded stream loops.
- `parseRetryAfter(value, now)` accepts delay-seconds (digits only) or an HTTP-date matching the strict `Ddd, DD Mon YYYY HH:MM:SS GMT` shape. G5 rule: any other non-numeric value is treated as absent (`undefined`), never passed to `Date.parse`, so garbage cannot become an elapsed cooldown. Results are clamped to at least 1000 ms; a value over one day, an unsafe integer, or a header longer than 128 characters returns the pause sentinel 86400001 ms so callers cannot shorten it. Consumers apply their own default when it returns `undefined`: `discovery/gmail.ts` and `discovery/outlook-transport.ts` (`RATE_DEFAULT_RETRY_AFTER_MS`, 30 s), `ai/http.ts` (30 s on 429), `documents/original-mail.ts` (30 s on 429/503), and `pipeline/gmail-batch.ts`, which re-exports it as `retryAfterMs` for itself and `pipeline/gmail-content.ts` (30 s only for 429).

## Hashing (`src/hash.ts`, SW-1)

`sha256Hex` (lowercase hex of UTF-8 text or bytes), `hashJsonValue` (`sha256Hex(JSON.stringify(value))`) and `sourceKey(userId, connectionId, messageId, generation)`, which returns `source:<hashJsonValue([userId, connectionId, messageId])>:<generation>`. Gmail (`discovery/pages.ts`) and Outlook (`discovery/outlook-delta-page.ts`) discovery both use `sourceKey`. The former inline digest copies collapse onto these names so stored values stay byte-identical; `security/helpers.ts` re-exports `sha256Hex`.

## Mailbox (`src/mailbox`)

- `google-oauth.ts` is the one Google OAuth client for Gmail mailbox and Drive storage authorization (INT-2, D2): one authorization URL builder, token exchange, userinfo read and RS256 ID-token verification against Google's fixed JWKS with exact audience/`azp`, issued-before-expiry and a single matching key ID. It never calls `fetch` itself; each adapter supplies its bounded transport. Code exchange requires the state-bound nonce: `verifyIdToken` rejects an empty or over-256-character nonce and compares it to the token's claim, and only refresh passes `null`. `gmail.ts` and `outlook.ts` also refuse `exchange` with `INVALID_STATE` when the nonce is missing. App login does not use this client; see `src/auth`.
- `provider-json.ts` (`mailboxProviderJson`, G8) is the one Gmail/Outlook OAuth, userinfo and JWKS transport: caller-fixed URL, `redirect: "manual"`, a 10 s timeout and deadline, and a 64 KiB cap on the shared reader. Transport or parse failures are `UNAVAILABLE`; 400 `invalid_grant` is `RECONNECT_REQUIRED`; a 400 error listed by the caller is `MISSING_PERMISSION`. No provider text is passed through.
- `credentials.ts`: `refreshSealedCredential` is the refresh-lease lifecycle shared by `mailbox/service.ts` and `drive/refresh.ts` (60 s lease, provider call only while 45 s remain, `needs_reconnect` on reconnect-class failures, release always attempted). `openMailboxCredential` (one 30000 ms `CREDENTIAL_REFRESH_SKEW_MS`) and `requireOutlookConnection` are used by the Gmail and Outlook discovery provider factories. The pipeline content factories (`pipeline/gmail-factory.ts`, `pipeline/outlook-factory.ts`) still inline the same 30000 ms checks.
- `service.ts` reads connections through one tenant-scoped row reader (O7), checks the live session through the shared session-live fragment (O6), and uses `security/helpers.ts` `stateHash`; it still has its own 64-byte PKCE verifier function.
- Gmail is enabled by `GMAIL_ENABLED=true` with valid login configuration. Outlook requires `OUTLOOK_ENABLED=true` and is not live-verified against a real Microsoft tenant.

## Discovery (`src/discovery`)

Metadata-only Gmail and Outlook discovery for durable jobs. `createGmailDiscoveryProviderFactory` and `createOutlookDiscoveryProviderFactory` open sealed credentials through `openMailboxCredential`; the Outlook factory additionally runs `requireOutlookConnection`.

- `rate-decision.ts` (G4): the one rate policy for both providers. Missing Retry-After defaults to 30 s, delays are at least 1 s, more than one day pauses rate service, and the fifth consecutive rate limit pauses (`consecutive_failures` is capped at 5). Used by `pages.ts`, `outlook-job.ts`, `outlook-state.ts` and `outlook-delta-recovery.ts`.
- `outlook-guard.ts` (G2): the one Outlook lease guard, built on `leaseLive` plus Outlook provider, `Mail.Read` grant and the reviewed AI selection/digest check that Gmail's consent check enforces.
- `stage-and-settle.ts` (G10/O9): the guarded continuation and completion builders and `stageAndSettle` used by `pages.ts`, `outlook-state.ts` and the `outlook-delta-*` modules. It adds no statements (G-40).
- `outlook-delta.ts` (G11) keeps its module path and delegates to `outlook-delta-parent.ts`, `outlook-delta-recovery.ts` and `outlook-delta-page.ts`, with shared types and SQL in `outlook-delta-shared.ts`.
- `import-progress.ts` (G11): Gmail import progress moved out of `pages.ts`, three reads followed by a pure summary.
- `outlook-budget.ts` (O5): named statement reservations for the Outlook runners. Per OD-11 an Outlook shortfall stays `retry/transient`, while Gmail keeps `paused/budget`.
- `source-jobs.ts` (G1): one initial source-extract job per source across connection generations.

## Drive (`src/drive`)

Barrel exports cover Drive authorization (on the shared Google client), storage connections, archive consent, configuration and the storage service used by the Worker's storage routes. Drive token refresh goes through `refreshSealedCredential`. The archive upload path (`workflow.ts`, `queue.ts`/`archive-job.ts`, `resumable*.ts`, `backfill.ts`, `dispatch-store.ts`) exists with synthetic tests only. It is not exported from the barrel and not wired into the Worker, and the Worker reports `driveArchive: false`.

## Persistence

Persistence uses native D1 parameterized SQL and Better Auth 1.7.7's Drizzle adapter (`drizzle-orm` 0.45.4) for login tables. Explicit SQL keeps tenant ownership, conditional lease/consent writes and native atomic batches reviewable. Worker invocation wrappers enforce the shared statement budget, including authentication queries. There is no Prisma runtime, generated client, schema/config or direct dependency (the owner reverted that experiment; Better Auth's optional Prisma adapter appears in the lockfile only as a transitive package).

Wrangler applies `packages/adapters/migrations`: the `0001_initial.sql` empty-database baseline (47 tables, 46 explicit indexes, the three scheduler cursor seeds) followed by incremental migrations `0002`–`0007` (archive upload sessions, recurring series, Outlook folder exclusions, reporting revision, archive dispatch/backfill, archive document order). Native CHECKs, composite tenant FKs, partial indexes and INTEGER auth millisecond storage are authoritative. `src/auth-schema.ts` holds the Better Auth mapping.

The former 19 migrations live only under `apps/worker/test/migrations/historical` for explicit populated-upgrade compatibility tests. Never replay the baseline against a populated database. Follow [the non-destructive transition checklist](../../docs/runbooks/baseline-transition-checklist.md) and obtain deployment authority before any remote migration. Evidence records for the Prisma experiment and the native-D1 restoration are kept outside git; historical copies are in the commit history before fe99887.
