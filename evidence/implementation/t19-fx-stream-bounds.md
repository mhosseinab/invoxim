# T19 FX stream work and accumulator bounds

Status: implementation verified, independent re-review pending. This ORIGINAL-01 sibling repair changes only `packages/adapters/src/fx/reference.ts` and `apps/worker/test/fx-reference.test.ts`. Previous23-case cleanup/review/log/hash evidence remains historical and unchanged. Frozen current hashes: `t19-fx-stream-bounds-sha256.txt`.

The old byte cap allowed indefinite accumulation of empty chunk objects, and excessive tiny-chunk work below the byte limit. Its abort timer also did not independently check elapsed time around body reads. The reader now allocates one existing16384-byte-cap Uint8Array and copies directly into it; it retains no chunks array. Cumulative limits are4096 nonempty chunks and32 empty chunks. Reads beyond either limit reject with the existing `invalid_response` code, before retaining/copying further chunk data. Existing response status, exact rate lexeme, date/source admission and no-fallback behavior are unchanged.

Each lookup records the absolute request deadline when starting its existing timeout timer. The body loop checks signal/deadline before and immediately after every read, including completion, and throws the existing `timeout` code when elapsed. Host-clock checks supplement the timer; they are not a claim about platform CPU scheduling or a real-provider latency benchmark. Existing reader cancellation, received-unread-body cleanup and late-response cleanup remain in place. No config/core/API/persistence/provider changes or live calls were made.

## Actual behavioral evidence

Focused RED command after explicit QA lane permission:

`WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/t19-fx-stream-bounds-red.log pnpm --filter @invoxim/worker exec vitest run test/fx-reference.test.ts -t 'finite empty|finite tiny|ordinary fragmented|elapsed deadline' > evidence/implementation/t19-fx-stream-bounds-red.txt 2>&1`

Actual exit **1**, **4 failed/1 passed**,23 filtered, duration **1.47s**. Finite33-empty and4102 one-byte valid under-bytecap JSON bodies resolvednull rather than rejecting. Both finite elapsed-before/after-read fixtures also resolvednull instead of timeout. Ordinary fragmented exact-decimal JSON already passed. These were behavioral failures, not fixture/import failures. Assertions were preserved.

Final unfiltered GREEN command after a separate explicit QA lane grant:

`WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/t19-fx-stream-bounds-green.log pnpm --filter @invoxim/worker exec vitest run test/fx-reference.test.ts > evidence/implementation/t19-fx-stream-bounds-green.txt 2>&1`

Actual exit **0**, **28/28**, no skips, duration **1.78s**. All previous23 rate/configuration/timeout/late-body/early-error oracles remain GREEN. The tiny-chunk test verifies bounded upstream pull count (at most4098, allowing stream prefetch) and actual cancellation once; ordinary seven-byte fragmentation preserves the exact18-fractional-digit rate. Deadline fixtures advance the host clock finitely before/during a zero-prefetch body read while the timeout callback has not run, and assert0/1 actual underlying reads respectively.

Final scoped exact commands and observed exit0 results are in `t19-fx-stream-bounds-checks.txt`: adapters typecheck, Worker typecheck, ESLint, strict Biome (no diagnostics/fixes), Prettier. `sha256sum -c evidence/implementation/t19-fx-stream-bounds-sha256.txt` verified both frozen files, exit0. Whole-workspace verify/build and independent review are orchestrator integration work, not asserted by these scoped commands.

## Scope and limitations

This proves application accumulator and read-work admission on synthetic native workerd streams. The buffer is fixed16384 bytes, plus the currently supplied transport chunk/decoder output; this is not a measured global process RSS limit or a guarantee about buffering inside an arbitrary transport/platform. Empty/tiny input is rejected even if its eventual JSON would be valid. No real rate endpoint, monetary mutation, provider retry/fallback, new cost, credential or persistent raw payload is introduced. Independent frozen-source re-review remains pending; prior23-case approval is not treated as approval of this missing path.
