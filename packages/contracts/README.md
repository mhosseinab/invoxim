# Shared bounded contracts

Strict Zod validators implement the three canonical designs in `/contracts`. `packages/contracts/test/contracts.test.ts` checks them against Ajv 2020-12 (with formats) on the example config and the synthetic extraction and onboarding-view fixtures, and requires both to reject injected `userId`/`secretRef` fields. Explicit schema expressions were generated once during implementation; there is no runtime interpreter or schema plugin engine. JSON designs remain the design authority. Integers must fit Zod's safe integer range. Package boundaries forbid importing `@invoxim/core`; core depends on contracts, not the reverse.

## Design modules

`src/designs.ts` is a facade over the split design modules: `extraction.ts` (`extractionSchema`, `inferenceExtractionSchema`, `EXTRACTION_PROMPT_VERSION`, `supportedExtractionPrompt`), `onboarding-view.ts` (`onboardingViewSchema`, `copyKeySchema`) and `app-config.ts` (`configSchema`). `contracts/ux-copy.en.json` is the single copy catalog: `copyKeySchema` is the enum of its `messages` keys, an onboarding view's `headlineKey` must be one of them, and the web app reads the same file.

## Shared primitives

`src/primitives.ts` holds the knowledge other modules and packages reuse instead of copying:

- Currency: `currencyMinorDigits` (the reviewed SIX subset EUR/USD/GBP/CHF 2, JPY 0, KWD 3, published 2026-09-17), `minorDigits` (throws `UNSUPPORTED_CURRENCY`), and one `supportedCurrency` enum used by API and reporting fields. `currencyCode` accepts any 3-letter code for domain inputs that report `currency_unsupported` instead of failing to parse.
- Money: `MINOR_BOUND` (9,000,000,000,000 minor units) bounds every money field and is core's `ENTRY_MINOR_BOUND`. `fxRateDecimal` is a positive decimal rate with up to 13 integer and 18 fraction digits, matching core `convertMinor`.
- Dates: `validCalendarDate`, `calendarDate`, `daysInMonth`, `isLeapYear`, and `dateSchema` for ISO calendar dates. `validTimezone` checks IANA names.
- Identity and concurrency: `generationSchema` (safe positive integer generation/revision) and `connectionIdSchema`.
- Credentials: `keyringSchema` (versioned keyring; the active key encrypts, older keys decrypt) and `oauthTokenResponseSchema` (bounded token-endpoint response, bearer only). The Gmail and Outlook OAuth adapters parse token responses with `oauthTokenResponseSchema`; the adapter keyring readers (AI, Drive, mailbox, Outlook) still define local keyring schemas, so migrating them is consumer-side work.
- `connectionStartRequestSchema`/`connectionStartResponseSchema` for mailbox and storage connection starts, and `hasControlCharacters` for opaque identifiers.

## Semantics outside shape validation

Extraction shape validity does not verify evidence grounding, currency support, monetary magnitude/precision, tax consistency or payment eligibility; core's AI validators do that. Evidence quotes are transient. Never persist model responses or this entire transient extraction DTO.

`onboardingStartRequestSchema` validates the bounded start request shape (connection, expected generations/revisions, accepted disclosure version, review token, frozen date range, timezone, reporting currency, `authorizeHourlySync: true`). Owned connection identity is a server check, never trusted merely because the identifier parses; consent, ownership, scopes, budgets and idempotency belong to the use cases. The processing disclosure exposes bounded destination/model/policy identifiers, a separate conversion destination, allowance and reset times, and no endpoint or key.

`projectPublicConfig` parses nonsecret operator configuration and builds an explicit allowlist from trusted readiness; missing or unknown readiness is unavailable and config intent alone cannot enable a capability. Public DTOs (`publicConfigSchema`) exclude operator budgets, endpoint URLs, key references, user identifiers and diagnostics. The Worker's unauthenticated `GET /api/public-config` builds its response through `publicConfigSchema` from server bindings (login configuration, configured mail providers, Drive archiving availability, the recurring flag; `useTags` is always false).

Purchase review contracts accept `PURCHASE_REVIEW_REASONS`: core's ledger review reasons plus the operational `document-review` (kept per OD-2). Because contracts cannot import core, a core test pins this list to core `CORRECTION_REVIEW_REASONS`.

Start/disclosure use the same supported currency subset and timezone rules. Authenticated onboarding views require `exampleData=false`. Purchase display money stays integer strings or null; actual totals derive from the core kernel.
