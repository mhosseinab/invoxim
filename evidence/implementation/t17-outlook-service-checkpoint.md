# T17 Outlook inventory and content checkpoint

Status: bounded service increment verified; T17 remains incomplete. Native D1 remains authoritative. No migrations, live provider calls or deployment performed.

The coordinator processes one resumable folder inventory page, with tenant/lease/consent checkpoints, atomic versioned page commits and shared query accounting. Inventory completion does not claim mailbox completion. Repeated non-null continuations return `cursor-loop` before any state write. The caller must handle that outcome without claiming progress or completion.

The content reader maps bounded Graph message bodies and file attachments into neutral MIME inputs. It uses fixed endpoints, immutable IDs, authorization checkpoints, streaming byte/chunk/deadline limits and canonical base64 with exact attachment sizes. Inline attachments are inspected even when `hasAttachments` is false. External references are inert and attachment continuations are explicitly refused. Original content stays transient.

## Executed checks

Root ran native workerd with telemetry disabled:

- Initial inventory RED: seven expected stub failures, `/tmp/invoxim-outlook-coordinator-red-v2.txt`.
- Initial content RED: five expected `CONTENT_UNAVAILABLE` stub failures, recorded alongside the separate FX cursor regression in `m1-service-checkpoints/content-cursor-red-v1.txt`.
- Independent review identified OUTLOOK-INVENTORY-01: a repeated opaque continuation could falsely report progress indefinitely. Actual regression RED: exit 1, one failed/nine passed, 2.03 seconds; `m1-service-checkpoints/outlook-loop-red-v1.txt`.
- Final GREEN: `pnpm --filter @invoxim/worker exec vitest run test/outlook-coordinator.test.ts test/outlook-content.test.ts test/outlook-state.test.ts`, exit 0, 39 tests across three files, zero skips, 4.12 seconds; `m1-service-checkpoints/outlook-final-green-v1.txt`.
- Adapter typecheck passed after the final coordinator fix: `m1-service-checkpoints/adapters-types-v3.txt`. Worker typecheck passed with the added outcome/regression and content typing: `m1-service-checkpoints/worker-types-v2.txt`.
- Scoped Biome (`--error-on-warnings`), ESLint and Prettier passed. No compiler or lint safeguards were weakened.

Independent read-only reviewer `/root/discovery_review` inspected source, tests, hashes and actual RED/GREEN logs. The reviewer closed OUTLOOK-INVENTORY-01 and approved the bounded inventory/content slices. No reviewer execution or edits. Reviewed coordinator SHA-256: `73b1456f63da1b9fd82fb5239eb0713070f178503b3b62e3f4ec53cb1174d40a`; inventory tests: `4aad85b26112eaf54777e7c8e0f535f8266ee2830f133706925ed35c97bd70ae`; content source: `46227e017caff7d55069106ba44ae9c771770b4e1039f590161f975fdd09a5bd`; content tests: `e0fdf4cb101676a62b6d2d09000cc5b1c6648d73074db48ffb6705a3b0edf235`.

## Remaining work

Full delta/import orchestration, trusted credential composition, runtime routing, UI and separately approved live Graph smoke tests remain required. Whole-repository verification, build and browser tests have not certified these changes. Previous frozen restoration certificates remain historical.
