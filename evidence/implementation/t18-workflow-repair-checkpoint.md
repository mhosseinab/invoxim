# T18 reviewed multipart workflow repair checkpoint

Status: bounded multipart workflow locally verified and independently reviewed. T18 remains incomplete; runtime queue composition, larger-file resumable uploads, backfill, links/UI and live provider tests remain required. Public archiving remains disabled. No migration, remote provider call, upload or deployment occurred.

The preceding recoverable WIP commit is `8700cb9`; its failed test and review finding remain recorded in `t18-workflow-wip-checkpoint.md`. This repair uses the canonical Outlook permission URI and compares complete financial rows without nondeterministic D1 execution metadata. The Outlook test fixture retains both selected-content reads and the original-reader identity check before exact EML retrieval.

## Actual evidence

- Scope RED: two intended failures with seven deliberately filtered cases, exit 1, 5.88 seconds; `m1-service-checkpoints/drive-outlook-scope-red-v1.txt`. A valid full Graph scope was refused and the shortened ungranted scope was incorrectly admitted.
- Final unfiltered native GREEN: `pnpm --filter @invoxim/worker exec vitest run test/archive-workflow.test.ts test/archive-workflow-transport.test.ts test/drive-transport.test.ts test/archive-objects.test.ts test/archive-objects-adversarial.test.ts test/drive-folders.test.ts`, exit 0, 102 tests across six files, zero skips, 13.95 seconds; `m1-service-checkpoints/drive-final-green-v3.txt`.
- The nine workflow cases cover exact original/selected-part identity, immutable saved IDs, credential changes between source requests, refresh deferral with no bytes or allocated IDs, newer-lease refusal, canonical Outlook EML and zero-HTTP missing-permission refusal. Actual shared-meter assertions pass at 33 statements for the synthetic cold multipart path and 19 for refresh deferral, including guarded release/settlement. These are synthetic local measurements, not production guarantees.
- Adapter and Worker typechecks passed after the scope change. Repository-wide Prettier passed after fixture repair. Biome uses warnings as errors; no rule, typecheck, byte, authorization or query limit was weakened.

Independent read-only reviewer `/root/discovery_review` inspected final source, test and actual native evidence and closed ARCHIVE-WORKFLOW-01. Approval covers the bounded workflow only; the reviewer performed no execution or edits. Reviewed workflow SHA-256: `415eba55db0d14ecd815b9bf3f90e422155b88e1866f8ad893f5def708719316`; tests: `29ce6817f48fb6dfa22386fedb9180a14aa520481fad0220c3310e191e9b7965`.

The consolidated baseline remains unchanged (SHA-256 `a9e200f7314995740439925756dad7f80cc5138613cc0d7b84721674ab777323`). No whole-repository test/build/browser certificate, live integration or complete-MVP approval is claimed by this increment.
