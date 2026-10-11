# Dated primary-source register

Checked October 11, 2026. Sources support platform constraints, not claims that this application has been implemented, approved, benchmarked, or audited. Product decisions and proposed thresholds are original design choices. Recheck changing APIs, prices, permissions, and tool configuration during T00 and before public launch.

## S01: Gmail authorization scopes

`https://developers.google.com/workspace/gmail/api/auth/scopes`

Read-only mailbox access is restricted; server storage/transmission can require a security assessment.

## S02: Restricted-scope verification

`https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification`

Public-launch prerequisites and assessment rules; confirm applicability for the final implementation.

## S03: Cloudflare Pages bindings

`https://developers.cloudflare.com/pages/functions/bindings/`

Pages Functions can call a bound Worker service; verify cookie/origin behavior in the deployed app.

## S04: Drive authorization scopes

`https://developers.google.com/workspace/drive/api/guides/api-specific-auth`

drive.file limits the application to files it creates or the user selects for it.

## S05: Queues delivery guarantees

`https://developers.cloudflare.com/queues/reference/delivery-guarantees/`

At-least-once delivery requires idempotent consumers; do not assume ordering.

## S06: Queues pricing

`https://developers.cloudflare.com/queues/platform/pricing/`

Free operations and 24-hour retention; paid allowances; retry operation costs.

## S07: D1 limits

`https://developers.cloudflare.com/d1/platform/limits/`

Per-database size, query constraints, and plan-dependent Time Travel retention.

## S08: Workers limits

`https://developers.cloudflare.com/workers/platform/limits/`

Runtime and request/CPU limits; benchmark rather than assume free-tier suitability.

## S09: Workers pricing

`https://developers.cloudflare.com/workers/platform/pricing/`

Free allowances and paid subscription baseline; recheck before deployment.

## S10: D1 pricing

`https://developers.cloudflare.com/d1/platform/pricing/`

Rows read/written and storage billing; indexes matter.

## S11: D1 Database API

`https://developers.cloudflare.com/d1/worker-api/d1-database/`

Prepared statements and batch API; test actual atomic/fencing behavior, not generic ORM transaction assumptions.

## S12: Gmail synchronization

`https://developers.google.com/workspace/gmail/api/guides/sync`

Full/partial sync and expired history recovery.

## S13: Google OAuth 2.0

`https://developers.google.com/identity/protocols/oauth2`

Token lifecycle and external Testing-mode refresh-token expiry exceptions.

## S14: Microsoft Graph mail overview

`https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0`

Personal and organizational mailbox support; service/account restrictions remain relevant.

## S15: Microsoft Graph permissions

`https://learn.microsoft.com/en-us/graph/permissions-reference`

Delegated Mail.Read versus insufficient basic-mail access.

## S16: Microsoft Graph message delta

`https://learn.microsoft.com/en-us/graph/delta-query-messages`

Per-folder delta state and opaque continuation links.

## S17: Microsoft Graph immutable IDs

`https://learn.microsoft.com/en-us/graph/outlook-immutable-id`

Request header and lifecycle limitations for stable message identifiers.

## S18: Yahoo developer access

`https://senders.yahooinc.com/developer/developer-access/`

Commercial access is not a guaranteed instant OAuth integration; defer until verified.

## S19: Proton Mail Bridge

`https://proton.me/mail/bridge`

Desktop-local bridge is not a drop-in Cloudflare cloud mailbox connector.

## S20: Better Auth Google provider

`https://better-auth.com/docs/authentication/google`

Google login integration; not a reason to conflate app identity and additional mailbox authorizations.

## S21: Better Auth Drizzle adapter

`https://better-auth.com/docs/adapters/drizzle`

Adapter setup; select and pin compatible stable versions after the runtime spike.

## S22: Drizzle D1 connection

`https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1`

D1 integration exists; check stable package versions and runtime behavior.

## S23: Cloudflare Vitest integration

`https://developers.cloudflare.com/workers/testing/vitest-integration/`

Tests in the Workers runtime rather than Node-only mocks.

## S24: Workers AI Markdown conversion

`https://developers.cloudflare.com/workers-ai/features/markdown-conversion/`

Candidate document-conversion adapter, not an OCR accuracy guarantee.

## S25: Markdown supported formats

`https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/`

Check supported MIME formats and test numeric fidelity for actual receipt types.

## S26: Workers AI data usage

`https://developers.cloudflare.com/workers-ai/platform/data-usage/`

Service data-use policy; check model licensing and the selected processing path.

## S27: Workers AI pricing

`https://developers.cloudflare.com/workers-ai/platform/pricing/`

Account-level allowance and model-dependent costs; not a guaranteed number of free receipts.

## S28: Frankfurter API

`https://frankfurter.dev/`

Current v2 API, historical rates and providers; prefer a stated provider such as ECB and persist exact rate snapshots.

## S29: Google API Services User Data Policy

`https://developers.google.com/terms/api-services-user-data-policy`

Limited Use, security, and transfer rules also matter for derived data and processors.

## S30: OWASP prompt injection prevention

`https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html`

Treat document instructions as untrusted input; combine structural controls and output validation.

## S31: OWASP SSRF prevention

`https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html`

Constrain destinations, redirects, and network reachability for configurable providers.

## S32: WCAG 2.2

`https://www.w3.org/TR/WCAG22/`

AA is the accessibility target, not a certification supplied by an automated test.

## S33: Codex skills

`https://developers.openai.com/codex/skills/`

Canonical skill layout and discovery; the documentation may redirect to ChatGPT Learn.

## S34: Codex subagents

`https://developers.openai.com/codex/multi-agent/`

Native role TOML layout, required fields, and concurrency configuration; smoke-test installed version.

## S35: Claude Code subagents

`https://code.claude.com/docs/en/sub-agents`

Native Markdown frontmatter, role tools, and skill loading behavior.

## S36: OpenCode agents

`https://opencode.ai/docs/agents/`

Native agent Markdown and permission options.

## S37: OpenCode skills

`https://opencode.ai/docs/skills/`

Agent Skills discovery, including .agents/skills; avoid conflicting duplicate names.

## S38: Agent Skills specification

`https://agentskills.io/specification`

SKILL.md name/description metadata and directory naming rules.

## S39: Cloudflare official skills repository

`https://github.com/cloudflare/skills`

Optional upstream reference only; review and pin before importing third-party instructions.

## S40: Drive upload management

`https://developers.google.com/workspace/drive/api/guides/manage-uploads`

Pre-generated IDs support safe retry for supported file types, including binary invoice archives.

## Version 1.1: product and consent references

New references below were checked for this revision. Vendor claims are not independent benchmarks. Existing S01 and S04 were also rechecked for the permission wording; unchanged platform/tooling references are retained from v1.0, not newly re-audited.

### [S41] Clint pricing

URL: https://www.clint.website/en/pricing

Checked: 2026-10-11. Supports: Vendor-published free allowance with Gmail/Drive sync and USD 5/month individual plan; not a usability or accuracy benchmark.

### [S42] SparkReceipt pricing and inbox features

URL: https://sparkreceipt.com/pricing/

Checked: 2026-10-11. Supports: Vendor-published tiered inbox access and historical imports; baseline competitor features, not measured quality.

### [S43] Gennai pricing

URL: https://www.gennai.io/pricing

Checked: 2026-10-11. Supports: Vendor-published free automatic capture with two inboxes at limited invoice volume.

### [S44] Google OAuth 2.0 policies

URL: https://developers.google.com/identity/protocols/oauth2/policies

Checked: 2026-10-11. Supports: Public homepage and privacy/terms, secure external authorization, partial-scope handling, and contextual incremental authorization.

### [S45] Google Workspace user data and developer policy

URL: https://developers.google.com/workspace/workspace-api-user-data-developer-policy

Checked: 2026-10-11. Supports: Transparent limited use, disclosure and user consent, advertising/sale restrictions, and processing/security obligations.
