# T27 capability and copy freeze — 2026-10-11

Task: T27, M0; dependency T00 is recorded done in `.agents/backlog.json`, with discovery/review evidence in `evidence/implementation/t00-*.md`. Status: review. This is discovery/design validation only. No components, routes, runtime contracts or consent mechanism are implemented by this artifact. Working tree is shared; other agents' edits are preserved. Assigned writable paths are this report and `t27-validation.txt` only.

Authority: `BLUEPRINT.md`, canonical rules 01–07, frontend role and its four skills, `docs/01-product-and-ux.md`, `docs/12-api-contracts.md`, `docs/13-presentation-and-onboarding.md`, `docs/14-market-validation.md`, existing config/onboarding schemas and copy catalog. Market findings remain dated research; no competitor account, price verification, model call or market test was performed.

## Actual capability boundary

At inspection `package.json`, `apps/web`, `apps/worker` and `packages/contracts` were absent. Schemas, example config, copy catalog, and labeled fixtures are specifications. A concurrent T01 spike, if created later, establishes only its recorded synthetic compatibility results. It does not enable product features.

Configured intentions never imply availability. Effective availability requires an implemented, reviewed behavior, its relevant passing acceptance/release tests, operator configuration/readiness, and backend enforcement. Public capability projection must fail closed for absent or unknown readiness. A client-visible flag cannot authorize any operation.

| Capability | Current state / intended guard | Approved copy and action |
|---|---|---|
| Working product name | `product.displayName` is `Inbox Ledger`; configurable, owner has selected no replacement brand | Approved headline `landing.headline` and description `landing.description`; no domain/logo/commercial decision |
| Static example | Intended `product.demoEnabled=true`, but no route yet; enabled only after T28 isolation/parity checks | `landing.cta.example` links to implemented `/demo`; persistent `demo.banner`, `demo.syntheticEvidence`, `demo.readOnly` |
| Google identity login | Unimplemented; operator credentials/release access unknown | After login works, `landing.cta.beta` in allowlist mode, `login.explanation`; absent login has no working sign-in assertion |
| Signup | Example `publicSignupEnabled=false`, `signupMode=allowlist`; general signup requires Gate D | Unapproved identity: `release.notAllowed` plus example link when example is available; no working mailbox action, fake waiting-list success or enrollment collection |
| Gmail connection | Example lists Gmail, but adapter/OAuth absent | Once tested/configured, `mailbox.title`, `mailbox.permission`, `mailbox.change`; permission copy must match actual approved read-only scopes |
| Multiple inboxes | Config limit 3 is an operator setting; no connections work yet | `mailbox.addAnother` only when backend supports another connection; `mailbox.limitReached` from actual count/limit, never permanent pricing claim |
| Outlook | M0 flag false; unavailable until T17, required tests and Microsoft operator setup | Hide active connect/navigation control, or explain `release.unavailable`; roadmap remains separate from supported labels |
| Hosted processing | Example disabled, model/base URL/price version null; not ready | Suppress `landing.betaAllowance`; `import.paused.service` with example/existing-record access where implemented. Default hosted selection only after approved configured destination and budgets exist |
| BYOK | No approved providers in example; advanced option absent until approved adapters/settings work | `ai.advanced`, `ai.byokExplanation` only for configured choices; no forced key screen, arbitrary endpoint, hidden fallback or unknown processor |
| Document converter | Disabled, approved capabilities empty | Disclose unavailable supported processing accurately; no invented parser vendor, OCR/PDF capability or ingestion success |
| Drive archive | Feature false in M0; config provider name is future intent, not archive availability | No active `drive.connect` or `drive.offer`. `import.review.originals` remains true. Missing source uses `purchase.originalUnavailable`; later offer requires T18 readiness and first real purchase opened or explicit request |
| Recurring / use tags | M0 flags false | Hide active Recurring/tag controls; no live claims. `recurring.change` needs enabled T20/T21 behavior and comparable evidence pair; demo tags are fixture data, not live editing availability |
| Pilot measurement | Off, separate opt-in required | No bundled Start consent. `privacy.pilot` only if operator enabled; refusal never blocks a feature. Demo actions never count as activation |

The approved headline's “across inboxes” describes product scope; surrounding supported-provider labels must state only currently available providers. Do not assert that multiple live connections work before proof. No testimonials, customer counts, security certification, comparative superiority, unique/free-forever claim, savings, complete spending, all receipts, bank verification, zero knowledge or speed guarantee is allowed. No final brand, price, licence or permanent free plan is selected. Copy catalog was reviewed against PRESENT-01/PRESENT-04; guarded templates are conditional, not current promises.

## Minimal contracts to implement in T03

These are constraints for bounded strict validators, not new routes or modifications to existing schemas. Reuse `/api` routes and transport/error conventions from docs/12. T03 owns concrete field names for details not named by canonical schemas; coordinate them with T28/T29 before those consumers write code. Do not add a workflow framework or a feature flag service.

| Route / projection | Minimum trusted content | Explicit exclusions / guards |
|---|---|---|
| `GET /public-config` | Allowlisted display name, signup mode, example availability, actually available feature/provider labels and policy routes | Never serialize whole config; exclude secrets, secret references, base URLs, global cost caps, user data and fabricated operator/contact/legal details. Readiness unknown means unavailable. Config flags alone are insufficient |
| `GET /onboarding` | Exactly existing schema's required version/state/headline/action/readiness/count/completion/consent/example/review fields; optional owned connection/import/disclosure identifiers | Session-derived tenant, read-only, no-store, `exampleData=false`. Validate copy keys against central catalog. This view carries no scheduling authority |
| `GET /processing-disclosure` | Current disclosure version; actual selectable inference provider/model and document-conversion destination; versioned retention/data-use/policy references; current user allowance, reset only if known; selected settings revision and real account/range/currency/timezone needed for review | Authenticated user-specific review, no secrets, no invented remaining count. Document conversion remains separately visible with BYOK. Disabled/unknown destinations cannot be rendered ready; no content read/model call |
| `POST /onboarding/start-import` | Verified owned connection ID, `expectedConnectionGeneration`, `expectedAiSettingsRevision`, `acceptedDisclosureVersion`, displayed date selection/timezone/reporting currency, `authorizeHourlySync: true`; Idempotency-Key header | Reject unknown fields including `userId`, scope claims, provider base URL, ready flag, counts or money. Resolve actual destination on server. Validate generation/scopes/revisions/disclosure/readiness/budgets before content access; store accepted consent and fixed range with run/schedule atomically. Return 202 with run ID |

Start replay with same key/body returns existing result; same key/different body conflicts. Another tab targeting the same active interval reuses active run or receives a documented conflict. Changed processor/disclosure yields `PROCESSING_REVIEW_REQUIRED` and refreshed safe review, never acceptance of a new destination. Currency validation and calendar dates use T03's reviewed currency/date kernel. User inclusive date end becomes next-day exclusive; default interval remains 12 calendar months, recent 30-day slice first, then all older approved history. Frozen cutoff and timezone are server facts; client cannot supply trusted processing counts.

OAuth identity/token/scope validation is permitted during callback. Callback records the actual mailbox in `awaiting_import`; it cannot enumerate messages, fetch bodies, invoke conversion/inference, schedule sync or create an import. Canceled authorization retains login (`mailbox.cancelled`); wrong account can be changed before processing. Display `mailbox.awaitingStart` until explicit Start accepts real review.

Consent is distinct from readiness: `review_import` with `canStartImport=true`, `primaryAction=start_import`, `hasProcessingConsent=false` is valid before Start. Tampered `canStartImport` never authorizes mail access. Accepted consent does not mean all records are ready or history finished. The existing schema supplies bounded shape/state invariants, not the complete state reducer or relational model.

## State/copy checklist for consumers

| Server fact | State, key / action |
|---|---|
| Signed in, no mailbox | `connect_mailbox`, `mailbox.title`; connect or example only when each is actually available |
| Mailbox verified, current ready review | `review_import`, `import.review.title`, `start_import`; actual account, range/recent-first, inference/model, parser, currency/timezone, remaining allowance, originals and hourly authorization visible |
| Review changed | `import.review.changeRequired`; refresh details before retry, retain owned account |
| Durable accepted run, no ready record yet | `importing`, `import.progress.recent` / `import.progress.extracting` / `import.progress.older`; `import.progress.background` only after accepted Start |
| No recent matches while older pending | `import.empty.recent`; remain importing, never completed no-match or zero-spend conclusion |
| One or more ready records | `records_ready`, `import.progress.ready`, `view_purchases`; `historyComplete` independent, no auto-redirect/focus theft |
| Completed full range, zero ready and zero review | `no_matches`, `import.empty.complete`, `adjust_range`; show real covered account/dates |
| Completed or partial with uncertain documents needing review | `needs_attention`, `import.reviewNeeded`, `view_review`; uncertain payments excluded; not no-match |
| Only unpaid records ready | `records_ready`, `purchase.noPayment`; show document total and `purchase.unpaid`, do not invent cash payments |
| Budget/auth/service pause | `paused_budget` / `needs_reconnect` / `processing_unavailable` with `import.paused.budget` / `.auth` / `.service`; existing records stay accessible, no checkout or silent provider substitution |
| Source missing | `purchase.originalUnavailable`, precise safe reason; keep extracted purchase, no broken archive/download action |

Ready counts are purchase records, not evidence documents or payment events. Lifecycle `purchase.paid/refunded/net` and `purchase.lifecycle` use eligible ledger magnitudes; Home summary uses period event dates and `home.spendingLabel/caption`. Pending refunds use `purchase.pendingRefund` and never reduce net. `home.coveragePartial` accompanies incomplete totals; missing FX exclusions remain visible. Unknown is null, not zero.

## Independently computed fixture oracle

Executed standard-library integer calculation parses EUR decimal amounts from synthetic evidence text and groups only `payment`/`refund` evidence; it does not derive expected values by reading fixture expectation fields. It compares the results to the fixture labels and checks ledger magnitudes/kinds against supporting text.

| Purchase | Document EUR | Paid EUR | Completed refund EUR | Lifecycle net EUR |
|---|---:|---:|---:|---:|
| Headphones | 120.00 | 120.00 | 30.00 | 90.00 |
| Unpaid studio invoice | 80.00 | 0.00 | 0.00 | 0.00 |
| Supplies receipt SUP-A | 15.00 | 15.00 | 0.00 | 15.00 |
| Supplies receipt SUP-B | 15.00 | 15.00 | 0.00 | 15.00 |

September `[2026-09-01, 2026-10-01)` total: 4 purchases, 7 evidence documents, 3 payment events, 1 completed refund; paid `15000`, refunded `3000`, net `12000` EUR minor units. Unpaid document total `8000` is separate. Summing document totals would produce `23000`, which is not spending. The two same-merchant/date/amount purchases have distinct receipt identities and remain separate. All ledger dates are in range, so period net equals summed lifecycle net in this fixture only. No pending-refund event or FX conversion is represented; those require later adversarial tests.

## Scoped next-task handoffs

T28: dependency T02 plus reviewed T27. Parent assigns exact apps/web and test paths; do not start components before T02. Implement lightweight landing and static read-only `/demo` adapter with reviewed production fixture parity, no production testkit import, no tenant/demo mixing, no private cache/loaders/API prefetch even when signed in, no model calls or writes. Use shared display DTOs once T03 freezes them; until then coordinate an exact boundary, not divergent permissive types. Synthetic evidence opens local labeled text only. Search/filter stays local; edit/sync/account/storage actions disabled with explanation, connect enters normal available onboarding. Planned behavioral RED cases: absent-feature/allowlist CTA guards (PRESENT-02); signed-in demo private-network/cache exclusion (DEMO-01/02); exact numbers/unpaid/distinct receipts (DEMO-03); disabled mutations and safe synthetic evidence (DEMO-04). Planned verification: actual browser network evidence, 360px, 200% zoom/reflow, keyboard/focus and synthetic screenshots. These checks have not run.

T03: dependency T02 plus reviewed T27. Parent assigns packages/contracts/core and matching tests. Implement strict Zod parity for existing schemas, bounded public-config/display/disclosure/start DTOs, validated copy-key references, integer-string money, exact date/calendar/currency logic and serialization. PRESENT-03 must prove readiness/consent separation and public projection secrecy. Planned RED includes ready-review with false consent allowed; forged start fields rejected; unknown copy key/extra secret fields rejected; unknown feature readiness unavailable; exact fixture arithmetic independent of implementation. OAuth/start transaction behavior belongs to auth/job/onboarding tasks, not schema validation alone. Generate shared contracts before coordinated consumers rely on them.

## Evidence and limitations

PRESENT-01/PRESENT-04: static discovery review exercised against catalog, config and approved documents. Helper validation is not application acceptance testing. RED/GREEN not applicable to this discovery-only diff. Commands and exits are in `t27-validation.txt`; helper regressions validate the blueprint tools. Application lint/typecheck/build/E2E/a11y/integration/security/eval/migrations were not run: implementation/tooling absent at inspection. No real first-result/import timing, OAuth/provider/model smoke, deployment, external account, branding/price research or paid resource performed. No data/migration, runtime cost, permission or retention changes. Independent reviewer `discovery_review` approved T27 with no findings via collaboration message after inspecting both artifacts; parent owns the durable review record, backlog status and final integration.
