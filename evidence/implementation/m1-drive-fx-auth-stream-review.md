# Independent Drive/FX/login-request stream repair review

Reviewer: separate read-only security agent `/root/m0_security`. Decision: approve the frozen resource repairs below. No required finding in these bounded patches. No production/test edits, native execution or live calls by this reviewer; only this report is written.

## Frozen source identity

Independently checked all three manifests with `sha256sum -c`, each exit 0/all files OK:

| File | SHA-256 |
| --- | --- |
| drive/transport.ts | `a80664bfa9a6595109384bb2487c648d68e673277112874d9acc5c4ce7b1ca9b` |
| drive/authorization.ts | `7c6d366034ae900804134e0a61d8b110e3ecefebce62fb9316c0e37d2c83cbf7` |
| drive-transport.test.ts | `5411cf389e63542c48a345304e7f77f01a6ebf40b463279b85d30d1c11450d55` |
| drive-authorization.test.ts | `3737d467ac3adcb7525f9fc73ea50eb0a746824015b06612cae7d2e0a309a4bc` |
| fx/reference.ts | `00c72195ca22357564a5ea9ca4647fb4f9289db1670f533993bf1c893818dedd` |
| fx-reference.test.ts | `c81405bd179d694dba045f04c6841aba2d2e5b8cd6561f62c3b457bc72c8ad15` |
| auth/http.ts | `934084f4b9790f6b97e04fb830e95082bcb3f59fa0193a75f9000ad905261ce9` |
| auth-stream-bounds.test.ts | `7a3ad7f6b63e229351a2499005117994d9cf586780a967e5b82131766442e363` |

Manifests: `t18-drive-json-chunks-final-source-sha256.txt`, `t19-fx-stream-bounds-sha256.txt`, `m1-auth-request-stream-sha256.txt`. Earlier authorization/FX approvals remain historical for their earlier hashes; current repair approval is anchored here.

## Source and proof assessment

Read affected body-reader implementations and cleanup/outer request paths, complete new auth-request test, new Drive/FX finite resource tests and prior late/early cancellation tests. Read implementer reports `t18-drive-{authorization,transport}.md`, `t19-fx-stream-bounds.md`, `m1-auth-request-stream-bounds.md` and corresponding raw GREEN logs.

All four readers now use one fixed accumulator: Drive transport/FX 16 KiB, Drive authorization 64 KiB, login request 4096 bytes. They retain no per-chunk array. Each caps total nonempty chunks at 4096 and total empty chunks at 32, refusing before copying inadmissible data. Accepted bytes are copied immediately and only the filled region is decoded. Existing byte caps and strict UTF-8/JSON behavior remain. Each provider response reader checks its request signal and absolute elapsed deadline before/after reads, including terminal reads. This supplements its timer/abort race for immediate streams; no global process RSS or transport-internal memory measurement is implied.

Drive/FX `finally` paths cancel readers and release locks even for count/deadline refusal. Their existing owned controller finalization, early unread-response cancellation and late fetch settlement observer remain. New pull-driven Drive cancellation oracles preserve strict one-cancel/no-extra-HTTP assertions. Old closed/pre-enqueued producers could not witness source cancellation after closure; the disclosed fixture repair changes delivery only, preserving payload/count/refusal expectations. No production change is inferred from that fixture-only failure.

Drive scopes, signed identity, token rotation, fixed host/callback, exact planned upload ID and digest validation remain unchanged. FX keeps exact decimal lexemes, fixed public provider/date policy and no fallback; ordinary fragmentation preserves an 18-fractional-digit rate. Login retains strict login schemas and 413 `request_too_large` for excess body work. Its reader cancels on count/byte refusal and releases its lock, but intentionally introduces no stalled-body deadline. The two auth tests prove 33-empty refusal and 32-empty/one-byte positive; they do not independently observe source cancellation. Source inspection supplies that narrow cleanup conclusion.

## Actual execution provenance

Drive implementer records the exact final command:

```text
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/invoxim-t18-json-chunks-wrangler.log pnpm --filter @invoxim/worker exec vitest run test/drive-transport.test.ts test/drive-authorization.test.ts
exit 0
```

Inspected `t18-drive-json-chunks-final-green-20261013.txt`: 121/121, two files, 04:37:11, 5.13s, no reported skips/unhandled errors. Genuine initial six behavioral failures/two positives and intermediate 117/121 four cancellation-observer failures are preserved separately; the latter is not counted as GREEN. Eight diagnostic cases subsequently passed with unchanged strict assertions before this unfiltered run.

FX implementer records:

```text
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/t19-fx-stream-bounds-green.log pnpm --filter @invoxim/worker exec vitest run test/fx-reference.test.ts > evidence/implementation/t19-fx-stream-bounds-green.txt 2>&1
exit 0
```

Inspected raw output: 28/28, 04:35:38, 1.78s, no skips; prior 23 cases plus five new cases remain. Focused genuine RED four failures/ordinary-fragmentation positive is preserved in `t19-fx-stream-bounds-red.txt`. Tiny-stream cancellation and bounded pull count are asserted; mocked finite clock tests prove zero/one reads before/after elapsed deadline.

Auth executor/root reports session 72088 exit 0 for the three explicit files `auth-stream-bounds.test.ts`, `auth.test.ts`, `auth-adversarial.test.ts`. Inspected raw `m1-qa-auth-stream-first-green.txt`: 26/26, three files, 04:36:13, 10.43s. Genuine initial one failure/one positive is preserved in `m1-qa-auth-stream-red.txt`. Exact shell provenance requested from QA; no invented command is recorded here. Root/implementers report scoped types/ESLint/warning-fatal Biome/format exit 0; reviewer did not rerun those checks.

QA subsequently supplied the actual command, confirming session 72088 completed exit 0 (no new run):

```text
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/invoxim-auth-stream-green-20261013.log pnpm --filter @invoxim/worker exec vitest run test/auth-stream-bounds.test.ts test/auth.test.ts test/auth-adversarial.test.ts > evidence/implementation/m1-qa-auth-stream-first-green.txt 2>&1
```

Central executor provenance also resides in `m1-qa-reader-resource-wave.md`.

## Remaining gates

These patches close the chunk-retention and immediate-stream work gaps in the named readers only. They can refuse unusually fragmented legitimate responses by policy. They do not complete optional Drive state/session/consent/persistence/upload composition, live provider operation, full T18/T19 financial runtime, unbounded/stalled login request I/O, other provider fetch/identity or AI/Gmail reader waves. Whole-source verification and deployments remain orchestrator gates. No permission widening, new destination, secret handling, raw persistence, monetary mutation, cost or regulatory/full-milestone approval results from this inspection.
