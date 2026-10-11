# TDD and execution evidence


For a behavior change, write a focused failing test, run it, and confirm the intended behavior is missing. Fixing an import typo is not the RED phase. Implement the smallest passing change, refactor safely, then run relevant regression checks and the required verification scripts.

Link tests to acceptance IDs. Include input, expected behavior and a meaningful adversarial case. Test outcomes and invariant preservation, not only internal mock call counts. Use property tests for money/dedupe and real workerd integration for D1/bindings. Live provider behavior requires separate smoke evidence.

Report exact commands, exit codes, test counts, environment and evidence paths. Distinguish executed, not executed, blocked and waived. Never invent a passing test, fabricated screenshot, review by another agent, provider connection or deployed result. Tests present in a JSON design file are not executed tests.

Do not weaken assertions, skip flaky failures, disable lint rules or change business requirements to get green checks. Explain genuine tool/environment failures separately. An unavailable independent reviewer must be reported, not impersonated through a second paragraph in the same answer.
