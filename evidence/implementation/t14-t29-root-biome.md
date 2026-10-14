# Root repository Biome verification

Command: `pnpm lint:biome`, executed in `/home/geek/workspace/invoxim` after the second copied full verification.

Exit 0. Actual output: `biome check . --error-on-warnings`; `Checked 306 files in 107ms. No fixes applied.` This covers the root repository’s supported files, including canonical/editor/configuration files outside the copied implementation inventory. No rules, warnings, test folders or import assistance were disabled. The copied plain verification separately checked 257 supported files and passed its Biome gate.

Tooling tests also execute the pinned Biome binary against intentionally invalid temporary worker/core/contracts test files, requiring non-null-assertion and control-character-regex rejection. CI invokes the same required verify gate. This proves current checks and omission regressions; it cannot guarantee every future defect will be caught.
