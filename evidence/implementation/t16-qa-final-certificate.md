# T16 local frozen-source verification certificate

Task T16 / M0. Status: required copied local checks passed; staged/live gates remain pending. This certificate does not mark T16, M0, the full MVP, or a release approved.

## Frozen identity and executed results

The approved isolated copy is `/tmp/invoxim-t16-qa-final-_j9mka9k/source`: **322 input files**, manifest SHA-256 `bbdf5d4fb7303baa58265394142f3a7da207a46efa9a041b2333f96cb14a2d02`. Node24.21.0/pnpm12.6.0; synthetic fixtures only. The copy contained no dependencies, Git state, Turbo cache, credentials or generated runtime state. Frozen install reused212 packages/downloaded0 with scripts disabled.

| Actual command in the copied source             | Exit | Result                                                                                     | Immutable raw evidence     |
| ----------------------------------------------- | ---- | ------------------------------------------------------------------------------------------ | -------------------------- |
| pnpm install --frozen-lockfile --ignore-scripts | 0    | Frozen lockfile installed                                                                  | t16-qa-frozen-install.txt  |
| pnpm verify                                     | 0    | 22 tooling +45 contracts +188 core +468 native Worker +62 browser = **785 distinct tests** | t16-qa-frozen-verify.txt   |
| pnpm db:check                                   | 0    | **79 repeated tests**,5 files; migrations0013/0014 included with prerequisites             | t16-qa-frozen-db-check.txt |
| pnpm test:security                              | 0    | Explicit18 native files, **261 repeated tests**                                            | t16-qa-frozen-security.txt |
| pnpm check:deps                                 | 0    | Six manifest policy checks; audit zero info/low/moderate/high/critical advisories          | t16-qa-frozen-deps.txt     |
| python3 /tmp/invoxim-t16-qa-snapshot.py compare | 0    | Initial/tested and root/tested differences both empty                                      | t16-qa-source-match.json   |

Database/security aggregates overlap the785 tests and are not additional distinct coverage. No skipped/todo tests were reported. Plain verify executed boundary/secret/dependency-policy checks, formatting, strict Biome, ESLint, types, unit/native tests, dry-run/build and browser checks. The frozen secret scan inspected317 text files/2781260bytes, skipped5 recognized binary files and found zero configured-pattern matches; this is a bounded scanner, not proof of absence of every possible secret. The audit checked319 dependency entries and reflects this recorded run, not perpetual vulnerability safety.

Initial typecheck and unit graph had zero cache hits. Later builds reused three results generated within this same invocation; no caches were copied from the workspace and native tests were force executed. Native commands used `WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/invoxim-t16-frozen-wrangler`; verify also used `PLAYWRIGHT_BROWSERS_PATH=/tmp/invoxim-playwright-browsers`. The non-Git-copy Turbo warning did not hide a check or cause failure.

`t16-qa-final-snapshot.json` contains every input path/hash; `t16-qa-frozen-results.json` records exact command outcomes and raw-evidence hashes. Inventory excludes only the previously identified generated screenshot `apps/web/evidence/implementation/t29-frontend-mobile.png` as a specific output artifact, alongside dependencies/runtime/build outputs and environment credential files. It does not blanket-exclude nested evidence or unknown fixture paths. All322 original input bytes remained identical after verification and matched the frozen workspace.

## Required regression evidence and scope

The actual Worker lifecycle actor tests passed in the copied full suite: actual A capabilities token plus B cookie is denied before B profile/session/job/connection/credential/journal effects, a second valid session of the same B account rejects the first-session token, and the actual current-session token positively completes the local deletion barrier. Missing/expired/cross-purpose tokens, origin/recent-auth/journal boundaries remain covered. Root implemented the repair; read-only security review is separate from QA execution.

The repaired composition witness passed in the unfiltered copied native suite: same owner/two Gmail mailbox adapters retain independent sources for one payment; another tenant remains independent; queue-pointer dispatch, redelivery/reprocessing, quote/body/transcript/credential sentinel exclusions and bounded D1/queue/log sweeps execute. Its consent/source jobs are synthetic preseeded fixtures and its queue transport/provider responses are injected: it does not prove live Google approval, full Review/Start inside that witness, or a deployed queue. Explicit Start/strict configuration/range/recovery boundaries are covered by separate executed onboarding/measurement tests.

Original actor RED remains `t16-lifecycle-actor-red.txt`. Initial combined25-test check failed the witness and is retained as `t16-composition-actor-initial-red.txt`; narrow fixture scheduling/source-grounding repairs preceded the final copied verification. The older focused actor GREEN raw path was overwritten before the error was identified; its historical recorded result is not reconstructed. The combined partial result and this final independently executed copied suite supply current raw evidence. Preserve that limitation rather than presenting the overwritten file as an immutable historical artifact.

QA changed only assigned tests/evidence; production fixes belonged to root. This certificate records actual local execution, not an independent source-review approval. Root must record the real read-only reviewer decisions and whole-checkout checks separately.

## Remaining live/operational gates

No real Google OAuth/mailbox, real receipt data, paid hosted/BYOK model, independent-journal restore drill, deployment, Cloudflare production cadence or live model-quality check was performed. Required inputs remain an approved OAuth project/domain/test identities, explicit mailbox smoke consent, isolated Cloudflare staging resources/deployment permission, approved processor terms/pricing/notices/secrets and bounded spend, plus independent journal durability and suppression-before-serving restore procedure. A mocked204/refusal/retry does not prove external journal durability or restore suppression.

`test:mutation`, offline/live eval and release wrappers remain explicitly unimplemented; there is no mutation/coverage score or real-model holdout result. The M1 T22 corpus targets and full Outlook/MVP/public-launch/runbook gates are separate. This local certificate supplies no waiver or permission to start a dependency-blocked task. Root/owner must retain truthful pending live gates and decide subsequent dependency handling explicitly.

Earlier T14/T29 certificates/manifests remain preserved. Any status-document closeout after this certificate requires an explicit bounded delta audit against these322 inputs; it does not rewrite the tested baseline.
