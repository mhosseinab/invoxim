# M1 three-reader stream-bound independent review

Reviewer: separate read-only security agent `/root/m0_security`. Decision: approve the bounded chunk-memory/iteration/elapsed-time repair in the exact four files below. No source/test edits, native execution or live calls by reviewer. Full provider resource/authentication review remains pending the separate repair waves.

## Frozen inspected snapshot

Current independently observed SHA-256:

| File | SHA-256 |
| --- | --- |
| mailbox/gmail.ts | `c105dd1b034d25e03a107308712be36b3468be3a3da9d710437bdfe8e6ce0ef3` |
| mailbox/outlook.ts | `e9785fff7ae1a6d310436f1c160da85669b17e9f754ea6d6d37a343f78ffc02a` |
| discovery/outlook-transport.ts | `8f1d1a9e58d054d9caa4522b8ea313ab00cc7842620be9ab9c562324bd3bb78d` |
| worker provider-stream-bounds.test.ts | `6ff4a896f42b6186dea3698a1c90b7429a22bc562dce48e906e57ab06bd03e09` |

Root declares these files frozen for review. QA supplied exact execution provenance but reports no newly generated whole-source manifest yet. This is file-scoped approval, not endorsement of an older integration snapshot.

Subsequent root handoff supplies `m1-root-provider-stream-sha256.txt`, confirms no edits after the 140-case GREEN, and the reviewer independently ran `sha256sum -c` (exit 0, all four files OK). This completes the four-file freeze evidence above; it does not create a whole-source manifest.

## Source assessment

Read the three affected JSON reader implementations, complete new twelve-case suite, root `m1-root-provider-stream-bounds.md`, and actual RED/GREEN logs. Each reader uses one 65,536-byte buffer instead of retaining per-chunk arrays. Nonempty payload chunks are capped at 4096; total empty chunks at 32. Admitted bytes are copied directly into the fixed buffer; only its filled region is decoded. Byte limits still apply. There is no per-chunk array or growing retained producer-buffer collection.

Each body read checks the existing absolute ten-second deadline before and after the abort/read race, including EOF. Finite count bounds and elapsed-clock checks handle immediately resolved streams even when timers have not run. Denials use the existing UNAVAILABLE code. Gmail now races pending body reads against its timeout and cancels rejected readers. Outlook retains its existing body race/cancel behavior. Graph retains its owned signal/finally cleanup and late-response handling from prior scoped reviews. These changes do not widen scopes, choose new hosts, alter signed identity authority or persist raw data.

No required finding in the bounded chunk repair. Actual transport may legitimately fragment beyond these limits; controlled refusal is the explicit policy. New tests assert fail-closed outcomes and ordinary fragmentation positives, rather than measuring retained heap or cancel count. Cancellation is supported by source inspection here and prior Graph cleanup evidence; the twelve-case suite alone does not prove every cleanup path.

## Execution evidence

Read `m1-qa-provider-stream-red.txt`: nine intended failures (empty/tiny/elapsed for each reader), three normal-fragmentation positives, twelve total. Failures resolved successfully where controlled refusal was expected, not import/setup failures.

QA `/root/pipeline_qa` supplied the actual command executed from root cwd, session 6563, exit 0:

```text
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/invoxim-provider-stream-green-20261013.log pnpm --filter @invoxim/worker exec vitest run test/provider-stream-bounds.test.ts test/outlook-discovery.test.ts test/outlook-provider.test.ts test/mailbox.test.ts test/mailbox-adversarial.test.ts > evidence/implementation/m1-qa-provider-stream-first-green.txt 2>&1
```

Inspected that raw log: 140 tests in five files passed, start 04:34:26, duration 14.04 seconds, no reported skips. The twelve witnesses use 33 empty chunks, valid sub-byte-cap JSON split into more than 4096 tiny chunks, an advancing clock, and valid normal fragmentation. Five-file regression success also retains existing provider/discovery behavior; controlled HTTP and synthetic credentials do not prove live OAuth. Root records scoped types/ESLint/warning-fatal Biome/format exit 0; reviewer did not rerun them.

## Pending boundaries

This review closes only the retained-chunk and immediately resolved read work finding in these readers. Gmail/Microsoft provider fetch waiting, early unread-body cleanup and Gmail library-owned identity JWKS handling are not established by this patch's chunk tests. Root has separately queued authorization/resource repairs and actual RED evidence; those require their own current-source review and fresh execution before broader approval. AI, auth request, Gmail content/discovery, Drive and FX readers are separate waves. No approval of those unfinished repairs is implied by the 140-case result.

No T17/T18/M1/MVP completion, full copied verification, storage/processing consent authority, live provider smoke, deployment or regulatory approval is claimed. Costs and destination permissions are unchanged by this slice.
