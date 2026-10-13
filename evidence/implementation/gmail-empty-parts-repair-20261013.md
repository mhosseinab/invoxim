# QUEUE-02 Gmail empty-parts repair

Official Gmail MessagePart documentation permits an empty `parts` field on non-container leaves. The content reader treated `parts: []` as a container and skipped leaf bytes or attachment fetch; normalization rejected those leaves as invalid MIME. Two branch-condition changes route empty arrays through existing bounded leaf handling without changing supported MIME types or limits.

RED: five synthetic cases, three intended failures and two controls passed, exit 1, 1.65 seconds; `/tmp/invoxim-gmail-empty-parts-red.txt`. GREEN: 83 tests across five files, exit 0, 13.70 seconds; `/tmp/invoxim-gmail-empty-parts-green.txt`. Cases cover text bytes, attachment fetch/decoded bytes, malformed/nonempty leaf children and pre-download byte bounds. Independent read-only review approved the actual two-file diff and inspected the GREEN evidence.

No private email was inspected or replayed. This confirmed wire-contract defect may explain some production MIME outcomes, but no live causal claim is made. Deployment remains pending.

Combined Clef/Gmail `pnpm verify` passed with exit 0 in the isolated checkout: 1409 native Worker tests across 116 files, 379 core tests, 48 contract tests and 84 browser tests, plus boundaries, secret/dependency policy, format/Biome/ESLint, typecheck, builds and production publication guard. Log: `/tmp/invoxim-clef-gmail-combined-verify.txt`. Shared-checkout integration also passed typecheck, 27 focused Clef tests and five Gmail regressions. Primary implementation commits: `94fcc02` (Clef) and `40895c4` (Gmail repair).

Source: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages#MessagePart
