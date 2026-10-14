# Compact import review plan

Task UX-REVIEW-01. The owner requests a simpler Review and start page using a subagent, moving lengthy descriptions into on-demand modal/bottom-sheet details. Implementation owner `/root/compact_import_review`; separate read-only reviewer `/root/langchain_review`; parent integrates and commits.

Bounded scope: onboarding review component/copy/scoped CSS and existing onboarding browser specs. Native dialog on desktop with mobile sheet styling. No new package, general modal framework, backend/DTO/authorization behavior, consent weakening, provider changes or deployment.

Default view must foreground the selected mailbox, actual calendar range with recent-first ordering, currency/timezone, actual processor/model/classification/conversion summary, remaining document allowance and resets, originals location, explicit authorization and Start. Long retention/data-use policies, exact interval boundaries and processing units remain available before consent through a clearly labeled details control. User’s explicit progressive-disclosure request takes precedence over expanded prose in docs13. Errors/blocked/stale states remain visible. BYOK remains optional.

Acceptance: UX-R01 compact default view and desktop Start visibility with synthetic full-disclosure fixture; UX-R02 named dialog open/close, Escape, focus containment/return and readable policy text; UX-R03 360px layout and scrollable bottom sheet without horizontal overflow; UX-R04 existing identity/token/idempotency/stale/consent/BYOK adversarial browser behavior preserved. Focused RED first, GREEN and browser screenshots, applicable style/types/build/publication checks, independent review, scoped recoverable commits. No live account or provider actions.
