# Email, OAuth, and user-owned storage

## Authorization separation

Three independent flows: app login, mailbox authorization, and archive authorization. A user can log in as A, connect inboxes B and C, and archive to Drive D. Never merge application users because two provider profiles share a displayed email address. Identity uses the validated provider subject/issuer; mailbox ownership belongs to the currently authenticated app user who initiated that consent.

Use established OAuth/OIDC libraries compatible with Workers, authorization-code flow, PKCE where supported, one-time state bound to session/user/purpose/provider, and fixed redirect URIs. Keep state server-side with a ten-minute proposed TTL. Validate issuer/audience/nonce/signature/expiry for identity tokens. A callback without its initiating valid session must not attach a mailbox to whichever user happens to be logged in.

Persist long-lived provider credentials encrypted. A reconnect response that lacks a new refresh token must not erase an existing valid one. Serialize refresh for each connection with a lease/version check; safely persist rotated refresh tokens. Distinguish invalid grant/consent revoked from transient 429/5xx errors. Do not retry invalid credentials forever.

Repeated callbacks are idempotent. Cancellation leaves the old connection intact. Requested scopes and actually granted scopes are both checked. An access token supplied by a browser is not trusted as proof of which mailbox was authorized without provider validation.

## Provider matrix

| Provider | MVP position | Constraints |
|---|---|---|
| Gmail / Google Workspace | M0 | Delegated Gmail read-only scope; archived mail/custom labels included in selected scope; public-use verification gate. |
| Outlook.com / Microsoft 365 | M1 | Delegated Graph mail reading; work-tenant policies can block consent; no application-wide mailbox permission. |
| Google Drive | M1 optional archive | `drive.file`; app-created folder and files only; account may differ from login/mailbox. |
| Yahoo | Deferred | Provider developer/OAuth access and an IMAP-compatible integration require a separate feasibility task. Do not promise one-click support yet. [S18] |
| Proton | Deferred | Proton Bridge is a desktop/local integration, not an interchangeable cloud OAuth mailbox API. No Bridge daemon in Workers. [S19] |
| OneDrive / Apple login | Deferred | New adapters/identity linking must retain the same ownership and consent constraints. |

### Gmail scope and release rules

Request `openid email profile` for identity and `https://www.googleapis.com/auth/gmail.readonly` for mailbox access. Do not request modify/send/delete merely to read bodies and attachments. Reading via this API must not change read/unread or labels.

Gmail does not offer a permission scoped to “only receipts” for this unattended whole-mailbox search design. Receipt filters restrict application behavior, not the breadth of the granted read permission. Disclose this clearly. `gmail.readonly` is a restricted scope. Server processing/transmission can require verification and security assessment; storing only extracted data or archiving originals in Drive does not remove that concern. [S01, S02, S29]

Google testing-mode refresh tokens for external apps with these scopes can expire after seven days. Distinguish this expected test limitation from a sync bug; do not promise uninterrupted unattended testing indefinitely. [S13] The production-release task must verify the exact applicable requirements and exceptions with the current official process. No invented audit price.

Use explicit account selection when adding a connection. Incremental scope grants and grant revocation can interact across Google flows/client registrations. T08/T18 must test disconnecting mail while retaining Drive/login and vice versa. Local disconnect is always precise; provider-side grant revocation may affect other grants and must be explained before invoking it. Do not create additional Google projects as a verification workaround.

## Gmail discovery and sync

Initial interval: `[start_date, initial_cutoff)` using a fixed cutoff. Compute the preceding 12 calendar months in the user’s chosen timezone; provider search uses explicit timestamp boundaries where supported to avoid assumed provider date timezones.

Receipt-focused query: a maintained, versioned multilingual combination of invoice/receipt/payment/refund/order terms and relevant attachment signals. Exclude spam/trash by default; include inbox, archived messages, and custom labels. An empty result is not proof there were no purchases. A broader range rescan can inspect more candidate metadata and fetch candidate bodies under explicit quotas.

Capture an incremental history anchor before long backfill, durably enumerate message IDs/page state, and replay changes after the anchor so mail arriving during import is not missed. If a history anchor expires during a long import, restart a bounded reconciliation/backfill with idempotent dedupe rather than pretending the cursor is valid.

For ongoing sync, use Gmail history records to obtain changed/new message references, then apply purchase-candidate filtering. Gmail history cursors can expire and return 404; recover through a full/bounded resync of the configured interval. [S12] Treat history IDs as opaque integer strings, not JS numbers. Cursor advancement happens after durable job/source records, not merely after receiving an HTTP page.

Provider deletions/label changes update source availability; they do not delete accepted financial records. Handle an attachment disappearing between discovery and fetch. Preserve separate counts for enumerated, candidate, processed, unsupported, failed, and review items. Never infer percentage complete from an unreliable estimate.

## Microsoft Graph

Register an app that supports the intended personal and work/school accounts. Use delegated `Mail.Read`, plus identity/offline scopes actually required; use `User.Read` only if retrieving `/me` identity requires it. `Mail.ReadBasic` is insufficient for bodies/attachments. No application permissions, tenant-wide access, or admin-impersonation shortcuts. Microsoft Graph supports mail access for personal and organization accounts, subject to consent/policy. [S14, S15]

Enumerate relevant mail folders, including nested folders and archive, and track messages per folder. Exclude junk/deleted/drafts/sent by default, documenting any exclusions. An Inbox-only implementation cannot be marked complete. Refresh folder enumeration to find newly created folders. Standard mailbox archive folders are in scope; separate online archive/shared/delegated mailboxes are deferred unless specifically verified.

Use per-folder message delta tracking. Preserve opaque next/delta URLs without rewriting query tokens; validate them against the trusted Graph origin before fetching. Graph message delta is per folder, not one global mailbox cursor. [S16] Include `Prefer: IdType="ImmutableId"` consistently where supported to reduce move-related identity churn. Immutable IDs still have documented lifecycle limits; do not assume global permanence. [S17]

Use initial bounded date discovery with the documented API semantics; do not combine unsupported search/order/filter/delta options. A bootstrap delta may enumerate older metadata to establish its token: discard out-of-scope financial content and report progress. Folder creation/moves and invalid delta tokens require tests. Overlap/rescan can be used for recovery, but a fixed recent-date filter alone must not be claimed to detect old mail moved between folders.

Respect `Retry-After`, pagination, attachment types, and reference attachments. Do not fetch arbitrary external reference-attachment links. If work-tenant policy blocks consent, show that reason and leave the account disconnected.

## MIME and candidate handling

A single email may contain several invoices, a PDF duplicated by body text, inline tracking images, or a forwarded attachment. Decode base64url and quoted-printable correctly, validate MIME against content, normalize Unicode carefully, and bound nesting/decoded sizes. One source message may produce several logical documents/observations.

HTML becomes inert text with scripts/styles/forms/remote images removed. Never execute email markup, load remote pixels, follow links, or let a model retrieve invoice URLs. Attachments are untrusted even if their sender is a familiar merchant.

Support text-layer PDFs through the configured document-text adapter. A scanned PDF, encrypted PDF, malformed MIME, archive file, office macro, executable, or over-limit input must be rejected/flagged explicitly. JPEG/PNG receipt extraction can be enabled only after the configured image adapter passes numeric-fidelity tests. A converter’s generic image caption is not evidence of a receipt’s exact total.

## Drive archiving

Enable only after explicit archive consent and successful storage authorization. Use an app-created root folder such as `Inbox Ledger Receipts`, with optional year/month subfolders. Request `drive.file`, not the user’s entire Drive. [S04]

PDF/image attachments: archive exact original bytes and original MIME. Body-only receipt: archive the original MIME message as `.eml`; a generated PDF or text rendition is not an “original invoice.” Distinguish them in metadata/UI. Do not archive unrelated attachments automatically.

Use a stable document hash and archive record. Obtain a pre-generated Drive file ID and persist it before uploading. Retried creates with that ID avoid duplicate file creation; successful earlier creation may return 409 on retry. Verify the expected file metadata/ownership before treating that as success. Use no format conversion. [S40]

If Drive upload succeeds but the local commit fails, retry/inspect the planned ID rather than uploading again with a new ID. Folder creation also needs deterministic reconciliation. Different invoices with identical filenames must not overwrite one another. Sanitize filenames and never use model output as an unvalidated path.

Archive failure never blocks extraction or duplicates financial effects. Handle full quota, denied folder access, revoked credentials, user-renamed/moved folders, remotely deleted files, network timeout, and disconnect during upload. Before initiating work and committing metadata, recheck the storage generation/tenant state. An already submitted upload may finish; reconcile its outcome without resurrecting deleted app records.

Storage enabled later applies to new documents and offers an explicit, bounded archive-backfill action for older sources still accessible. If source and archive are gone, show unavailable. Turning storage off stops new uploads; it does not delete earlier Drive files. Unlinking the app does not make a private Drive file public.

Default account deletion removes application data/credentials and leaves user-owned Drive files intact. State that in the confirmation screen. No whole-Drive deletion or permission changes are permitted.

## Authorization timing and recent-first history (v1.1)

Login, mailbox authorization, processing authorization, and storage authorization are distinct. Obtain only needed scopes in context; partial denial does not justify repeated automatic consent prompts. [S44] A mailbox OAuth callback verifies identity/tokens/scopes and leaves content scheduling at `awaiting_import`. It must not enumerate/fetch purchase messages or run extraction. The explicit review/start action binds destinations, range, mailbox, and hourly behavior to the accepted disclosure version.

At Start, fix the parent interval and split it into recent (last 30 calendar days, clamped to the selected start) and older non-overlapping ranges. Never replace the user's requested 12-month import with only the recent range. Use independent slice cursors and a separate live incremental cursor; a persisted parent run summarizes progress. Provider search order is not guaranteed to be newest-first; narrow bounded date ranges where needed. Coarse provider date filters must be followed by adapter boundary checks. On history reset or recovery, preserve the user-approved interval and selection.

An account added during another import gets its own verified connection and explicit import review. Reauthorization of a known connection resumes its existing durable work when current consent is still valid; it does not automatically create another historical scan or move the authenticated workspace. Provider readiness and allowed account types determine visible connect buttons.

Offer optional Drive after first useful results, with explicit access from Settings for users who prefer archiving before import. Late archive backfill only uses sources still available. The archive badge reflects an actual successful upload; an OAuth grant or queued job is not a saved original. Drive denial/failure cannot block financial extraction or falsely mark monetary evidence incomplete.
