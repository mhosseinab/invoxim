# API contracts

The following routes are the application contract, not a claim that handlers already exist. Generate OpenAPI from the shared validated DTOs during implementation. All non-auth public application routes require a session except explicitly documented health/config endpoints containing no secrets. `/public-config` is the only added public JSON route; static landing/demo content does not expose tenant APIs.

## Transport conventions

Base path `/api`. Same-origin JSON API. Money as integer strings; dates as `YYYY-MM-DD`; instants as ISO UTC strings; opaque IDs/cursors. Requests are size-bounded. Responses never contain provider tokens, saved API keys, raw model responses, or full raw email bodies by default.

Tenant identity always comes from the session. Body/query/path user IDs cannot choose a tenant. A source or purchase ID must be authorized again before use. Return 404 for another tenant’s resource where appropriate to avoid exposing existence.

Mutations requiring retry safety accept an `Idempotency-Key` scoped to user, route, and request-body hash. Same key with different body is 409. Persist mutation results/dedupe identities for a documented bounded period. Record edits use expected `version`; a stale version is 409, not last-write-wins.

Standard error: `{ "error": { "code": "...", "message": "safe human message", "requestId": "...", "retryable": false } }`. Use 400/422 for invalid input, 401 unauthenticated, 403 denied action, 404 unknown/inaccessible, 409 conflict, 413 too large, 429 throttled, and 503 temporarily unavailable. Quota-paused processing is a visible job state, not a fabricated 200 extraction success.

## Routes

| Method/path | Behavior |
|---|---|
| Auth library under `/auth/*` | Google login/callback/logout/session. Use library routes, do not invent replacements. |
| `GET /public-config` | Public allowlist of display name, signup mode, demo and actually available feature/provider labels, policy routes; no operator config dump, tenant data, keys or secret references. |
| `GET /me` | Profile, workspace settings, onboarding state, allowed capabilities; no credentials. |
| `GET /onboarding` | Derive resumable setup/import state from session-owned resources; read-only and no-store; never starts a scan. |
| `GET /processing-disclosure` | Current selectable approved parser/inference destinations, user allowance summary, retention/data-use notice references, and version for explicit Start review. |
| `POST /onboarding/start-import` | Explicit idempotent processing/interval/background authorization for a verified owned connection; validate destination/disclosure revision; atomically create/reuse import run and activate schedule; 202 with run ID. |
| `PATCH /me` | Update timezone/reporting currency with versioning; queue needed valuation rebuild. |
| `GET /connections` | List this user’s mailbox/storage connections and sync/archive states. |
| `POST /connections/mailbox/:provider/start` | Create user/session/purpose-bound OAuth state; return approved authorization URL. |
| `GET /oauth/mailbox/:provider/callback` | Consume state, validate authorization, attach correct provider account as awaiting_import, redirect to fixed review path; no message enumeration/body fetch/extraction or auto-sync start. |
| `POST /connections/storage/google-drive/start` | Separate optional storage consent. |
| `GET /oauth/storage/google-drive/callback` | Complete storage authorization independently of login/mailbox. |
| `POST /connections/:id/sync` | Coalesce/start bounded sync only with active processing consent and schedule authorization; 202 with job ID. Awaiting-import connections must use review/start. |
| `POST /connections/:id/backfill` | Validate explicit date interval/query mode and current processing consent; create/reuse parent import with bounded recent/older slices; cannot bypass the same explicit Start guards. |
| `POST /connections/:id/pause` | Stop new sync scheduling without deleting records. |
| `POST /connections/:id/resume` | Resume if credentials/generation valid. |
| `DELETE /connections/:id` | Disconnect locally, fence jobs, clear credentials; retain records by default. |
| `POST /connections/:id/delete-data-preview` | Return affected record counts, including records supported by other sources. |
| `POST /connections/:id/delete-data` | Explicit confirmed, versioned deletion of that source’s data; preserve independent evidence. |
| `GET /imports/:id` | Parent/slice progress, frozen range, ready-record count, discovery/processing/review counts and pause/completion reasons; no fake global percentage; scoped to this user. |
| `GET /purchases` | Cursor-paged authorized list with validated filters. |
| `GET /purchases/:id` | Purchase, ledger entries, source metadata, overrides, review items. |
| `PATCH /purchases/:id` | Whitelisted field changes with expected version and audit. |
| `PATCH /ledger-entries/:id` | Correct amount/currency/event date on an existing owned event with expected version, explicit override and audit; preserve event identity/kind. |
| `POST /purchases/:id/payment-confirmation` | Explicit user-confirmed payment event; requires amount/currency/date and prevents duplicate entry. |
| `POST /purchases/:id/refund-confirmation` | Explicit completed-refund entry, not a status toggle that erases a payment. |
| `POST /purchases/:id/reprocess` | Queue re-extraction if source/consent/budget exists; preserve overrides. |
| `POST /purchases/:id/exclude` | Exclude from totals with reason/version; allow reversible restore. |
| `POST /purchases/:id/restore` | Reinclude if financial blockers resolved; does not bypass validation. |
| `POST /purchases/merge` | Validate all IDs in current tenant; explicit evidence-preserving merge with versions. |
| `POST /purchases/:id/unmerge` | Reverse a recorded merge safely; never duplicate a ledger event. |
| `GET /summary` | Same inclusion/date/filter rules as list/export; conversion and coverage warnings. |
| `GET /review` | Cursor-paged review list, with reason and blocking scope. |
| `POST /review/:id/resolve` | Typed resolution action with expected version; no arbitrary status patch. |
| `GET /recurring` | Suggestions and user-confirmed series; forecasts distinct from ledger. |
| `PATCH /recurring/:id` | Confirm/dismiss/pause/cancel or edit cadence; no provider cancellation action. |
| `POST /documents/:id/archive` | Archive only to this user’s authorized Drive; 202/idempotent. |
| `POST /archives/backfill` | Explicit bounded archiving of still-available sources. |
| `GET /documents/:id/source-link` | Validated provider link or clear unavailable status; no model-selected URL. |
| `GET /documents/:id/archive-link` | User-owned Drive link only after ownership checks. |
| `GET /ai/settings` | Provider/model selection, consent, masked key presence, capabilities. |
| `PUT /ai/settings` | Choose hosted/BYOK and approved provider/model; write-only encrypted key. |
| `POST /ai/test` | Synthetic test only; bounded cost/rate limit; no echoed secret. |
| `DELETE /ai/key` | Remove saved BYOK key and pause affected pending work. |
| `GET /usage` | User allowance, reserved/actual/estimated usage; no billing implementation. |
| `GET /export?format=csv|json` | Authorized export of structured data; no secrets; escaped CSV text. |
| `PUT /privacy/pilot-measurement` | Separate versioned opt-in/out when operator feature enabled; false by default; opting out purges optional events, without blocking product features. |
| `POST /account/delete` | Recent reauthentication and confirmation; initiate fenced deletion, invalidate sessions. |

Webhooks are not an MVP requirement because sync is scheduled. Do not implement a public unauthenticated “enqueue job” endpoint. Queue/scheduled handlers are internal entry points, not ordinary HTTP routes.

## DTO and consistency requirements

Use one set of filter semantics in summary, lists, and exports. A purchase with two mailbox evidence links appears once. Pagination includes deterministic date/ID tie-breaking and does not skip equal-date items. A reporting-currency change preserves original values and shows valuation progress.

Exclusions, suspected duplicates, unknown payments, and FX gaps have explicit inclusion rules. Refunds can belong to purchases outside the current date window. Totals cannot be calculated by summing all purchase document totals.

JSON export includes `schemaVersion`, `exportedAt`, profile preferences, purchases, eligible/excluded ledger entries, source references, overrides, recurring series, and valuation provenance. Exclude credentials, sessions, OAuth state, full messages, and internal security diagnostics. CSV separates amount magnitude, currency, entry kind, and date basis so refunds remain unambiguous.

Large exports are bounded/chunked or streamed within verified platform limits. No temporary R2 file. If an export exceeds the initial supported bound, ask for a narrower range rather than crashing or silently truncating it. The UI must show the exported range/count.


## Correcting gross totals versus actual spending

A purchase gross-total edit does not silently rewrite an installment or cash payment. The detail screen distinguishes document total from payment/refund events. Editing an existing event uses the ledger-entry correction route, preserves event identity and kind, invalidates affected valuations and retains the override on re-extraction. Creating a new user-confirmed payment/refund uses the separate idempotent confirmation routes. Do not turn an amount correction into a duplicate new charge. Any inconsistent remaining allocation becomes review rather than an automatic balancing transaction.

## Onboarding start and display contract (v1.1)

`POST /onboarding/start-import` accepts only a verified connection ID, `expectedConnectionGeneration`, `expectedAiSettingsRevision`, `acceptedDisclosureVersion`, the displayed start/end selection/timezone/reporting currency, and explicit `authorizeHourlySync: true`. Requests use an Idempotency-Key; no client-provided user ID, claimed permission scope, processing count, provider base URL, monetary summary, or ready-state flag is accepted. The server resolves the actual approved destination configuration and consent. Partial missing scopes fail before content access.

First execution durably links consent to the connection/run and starts the fixed-cutoff import plus hourly schedule. A repeated same request returns the existing run; changed body with the same key conflicts. Another tab asking for the same active interval returns the active run or a documented conflict, not a second import. A new intentional older/broader import requires a new explicit request and shares source/business deduplication. A stale disclosure yields `PROCESSING_REVIEW_REQUIRED`, returning safe current review information; it cannot silently follow the newly configured destination.

`GET /onboarding` returns the state required for rendering, not a saved UI step trusted as permission. Supported primary states, readiness flags and copy keys are defined in `contracts/onboarding-view.schema.json`. This is a bounded display projection, not the complete relational model. No response may reveal another tenant's connection identity. `canStartImport` means the current review is ready for explicit acceptance; it is not stored processing authorization. `hasProcessingConsent` can still be false before the user presses Start. No work starts until that acceptance commits; server guards remain authoritative even if a client tampers with the projection.

`GET /purchases/:id` includes a bounded source-derived timeline, clearly labeled lifecycle payment/refund/net values, and evidence availability. Production timeline fields are structured evidence codes and values; no permanent raw-body storage is added. A pending refund is not an eligible refund entry. Home period summary reuses ledger dates, not lifecycle totals.

M1 `useTag` supports personal/work/unassigned on purchase edits and list/summary/export filters. JSON/CSV schemas include that field consistently. Optional event recording is internal to validated application actions where possible, not a generic unauthenticated analytics endpoint. For in-app evidence-open tracking, any dedicated handler must validate the actual owned source, user action and opt-in, reject demo/arbitrary payloads, and never record private identifiers in event rows.
