# Demo UX integration

The owner's two browser comments are addressed in the frozen T28 refinement. The demo replaces unavailable actions with functioning refund/unpaid shortcuts and uses searchable receipt evidence with counted payment-status buttons, clear/reset focus restoration and empty-result recovery. The existing blue/white design from docs/design remains the visual authority.

Root owns apps/web/tests/demo.spec.ts. Two behavioral tests failed before implementation for missing refund exploration and receipt-text retrieval (demo-ux-red.txt); all seven browser tests subsequently passed (demo-ux-green.txt). Updating previous disabled-action assertions to absence and select interaction to pressed buttons reflects the explicit requested behavior. Exact money, fixture, network, accessibility and reflow checks remain active.

Independent QA used a clean 70-file copied snapshot, identity 5e0f5711bd6a57aa0a9e022ed7f6a10f56996c90ec4b8419b8502c79c6644f9a. Frozen install and pnpm verify exited 0 with 97 freshly executed tests and 1,500 generated cases included in three property tests. Source comparison found zero differences. See demo-ux-qa.md for execution/cache details and limits. Principal reviewer discovery_review approved the bounded refinement without open findings; see demo-ux-review.md.

Root visually inspected demo-ux-desktop.png, demo-ux-full.png and independent mobile/zoom screenshots. Source remains frozen. No deployment, credentials, live integrations, migrations, permissions, retention, dependency or cost changes were introduced. This closes the static demo refinement, not the remaining MVP milestones. CSS zoom checks and automated axe checks retain their documented practical limits.
