# QUEUE-02 Gmail empty-parts repair

Official Gmail MessagePart documentation permits an empty `parts` field on non-container leaves. The content reader treated `parts: []` as a container and skipped leaf bytes or attachment fetch; normalization rejected those leaves as invalid MIME. Two branch-condition changes route empty arrays through existing bounded leaf handling without changing supported MIME types or limits.

RED: five synthetic cases, three intended failures and two controls passed, exit 1, 1.65 seconds; `/tmp/invoxim-gmail-empty-parts-red.txt`. GREEN: 83 tests across five files, exit 0, 13.70 seconds; `/tmp/invoxim-gmail-empty-parts-green.txt`. Cases cover text bytes, attachment fetch/decoded bytes, malformed/nonempty leaf children and pre-download byte bounds. Independent read-only review approved the actual two-file diff and inspected the GREEN evidence.

No private email was inspected or replayed. This confirmed wire-contract defect may explain some production MIME outcomes, but no live causal claim is made. Combined full verification and deployment remain pending.

Source: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages#MessagePart
