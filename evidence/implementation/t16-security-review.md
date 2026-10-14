# T16 independent scoped security review

Reviewer: separate read-only agent `/root/m0_security`, 2026-10-13. Task: inspect the private Gmail M0 trust/privacy boundaries and existing execution evidence. No production/test edits, migrations, provider calls, heavy tests or deployment were performed by this reviewer. This report is the only file written, under the orchestrator's explicit report-path authorization.

Decision: initial request changes for one P1; the inspected patch and focused executed QA evidence close that finding. Approve that bounded repair, contingent on fresh integrated verification. This is not M0 Gate B completion, complete-MVP approval, public-release authorization or a regulatory assessment.

## Initial finding and reproduction

**P1: stale account-delete confirmation can delete the newly logged-in account.** Initial locations: `apps/worker/src/lifecycle-routes.ts:88` and `:191`; `packages/contracts/src/lifecycle.ts:26`; `packages/adapters/src/lifecycle/repository.ts:67`. The route checked actual session ownership, exact Origin and recent authentication, but the body contained only confirmation and profile version. Those checks did not bind the initiating form to its account/session.

Retain account A's `{confirmed:true,version:1}` request, then switch the browser cookie to recently authenticated account B with the same profile version. Submit that unchanged request with the legitimate same-origin headers, idempotency key and configured journal. The source resolved B and initiated B's deletion, invalidating B's sessions and creating B's deletion marker. Expected: reject the stale actor before any deletion, revocation or journal effects. Tenant-scoped SQL correctly targeting B does not preserve A's originating intent.

QA independently reproduced this against the actual Worker. `t16-lifecycle-actor-red.txt` records exit1, two genuine failures: expected403 received202; B became deleting/version2, its sessions were removed and a deletion marker existed. The initial journal observer constructed a workerd Request with unsupported redirect:error, so its empty append-spy result was not proof of no attempted journal call. The actor-deletion failure is independently proved by the actual persisted deletion effects. QA corrected that synthetic observer without changing the production journal protocol or rejection oracle.

## Repair re-review

The root implementer reused the existing HMAC token mechanism with the separate closed `lifecycle` purpose. Authenticated `GET /api/lifecycle/capabilities` issues a bounded ten-minute token carrying the verified tenant/session. All lifecycle mutation routes verify that token against the current live account/session, secret, purpose and expiry after existing exact-Origin/recent-auth checks and before constructing journal/revocation dependencies or invoking the use case. Tokens from corrections or AI settings cannot authorize lifecycle operations. No client user ID becomes authority; no additional database query is introduced for signature verification. Strict capabilities projection exposes only the intended token and existing public capabilities, with no-store transport.

The reviewed actual-Worker regression obtains A/B tokens through the real GET endpoint, checks equal profile versions, submits A's token with B's signed cookie and requires403 with unchanged A/B profiles/sessions/commands/deletion markers and no journal append. Its current-B positive control obtains B's own token and requires202, a durable mock journal marker for B and A remaining unchanged. The second case covers absent tokens across account-delete/disconnect/data-preview/data-delete, wrong purpose, expired token, missing journal and stale recent authentication, with unchanged state/no journal effects. QA executed `WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/invoxim-t16-qa-wrangler pnpm --filter @invoxim/worker exec vitest run test/lifecycle-actor.test.ts`, exit0,2/2,no skips,6.15seconds; output is `t16-lifecycle-actor-green.txt`. This reviewer inspected those assertions and logs and did not execute them.

Inspected repair SHA256 identities:

- `apps/worker/src/lifecycle-routes.ts`: `a6c00399c6a2f4274dd143ef09e5a3ca1ebac1d9971d5d1b2229c429a70db9a2`
- `packages/adapters/src/corrections/workspace-token.ts`: `e2980e12d8815b269353d05a5c55efcff522cdccb80d951611f86d28d880e692`
- `packages/contracts/src/lifecycle.ts`: `e392deb63d775e22d6ae3b253f028444209ec1288618267cbf6e29496143d6fb`
- Initial reviewed `apps/worker/test/lifecycle-actor.test.ts`: `ef1fccb720e930934fa68b31b7f74f2a9ab56b17abf1e4b1c6fa58f5d2a79ad9` (superseded by the strengthened test below).

No further required defect was found in this bounded repair. Source changes after these hashes require applicable re-review and verification; the prior770 certificate does not certify this later patch.

## Scope and evidence inspected

Read root AGENTS, BLUEPRINT, all seven canonical rules, assigned T16 backlog scope and selected acceptance specifications; security role and its four required skills; docs06/07/10 plus relevant onboarding/product/API contracts. Inspected actual Worker route composition, auth/mailbox/correction/AI/onboarding/lifecycle/job routes; Pages proxy; login configuration/verified identity/encrypted state/profile; OAuth state and credential cipher/vault; Gmail authorization/content and bounded MIME/PDF handling; AI destination configuration/transport/provider factory and quote-free persistence validator; pipeline live/cache guards; onboarding signed review, atomic Start and bounded job recovery; lifecycle authorization/journal/export; private identity-bookended loaders and security headers. Corresponding adversarial assertions and relevant final logs were read.

Trust boundaries inspected: allowlisted Google identity versus independently verified mailbox; browser versus session-derived tenant authority; job payload versus loaded/fenced internal authority; encrypted retained secrets versus transient plaintext processing; inert mail/PDF/model candidates versus typed structured records; operator-approved destinations versus public provider IDs; disclosed accepted policy versus current processing configuration; live records versus deletion barriers and independently acknowledged erasure; synthetic demo versus private loaders.

The existing frozen certificate `t14-t29-qa-final-certificate.md` reports770 distinct tests and79 repeated native database checks for319 inputs, manifest `7e8623fa63b9f1a88fe9c08a2461ff6290d1365e1309dbd3a5728da29a0d75d0`. Read the actual fresh verify/database tails and source-match JSON, plus T29 independent source review. That evidence includes meaningful state/nonce/AAD/CAS/endpoint/tool/refusal/consent-digest/delete-fence assertions. Browser tests use synthetic API fixtures and native transport tests use synthetic provider responses; neither proves live Google/model behavior. `t16-qa-gate-map.md` records further acceptance/evidence gaps without treating absent witnesses as executed failures.

Principal acceptance families reviewed: DB-01; AUTH-01 through05; SECRETS-01 through04; AI-03/07; LIFECYCLE-02/03/06; ONBOARD-03/04/06/07/09; RECENT-05/07/09. This bounded inspection is not a case-by-case certification of every T16 requirement.

## Remaining evidence and release boundaries

- Fresh integrated verification must include the lifecycle repair, aligned legacy fixtures and the independent actor regression. The historical770/79 source certificate remains preserved.
- No live OAuth/Gmail/model/revocation or deployment smoke was executed. Processor terms, restricted-scope approvals, real-model quality, approved pricing and actual hosted/BYOK configuration remain owner/operator prerequisites; code's registry cannot verify legal or retention promises.
- Native journal refusal/ACK/recovery tests prove access fences and deferred erasure. They do not prove independently durable production storage or isolated deletion-aware restore suppression. No restore drill was located; the manual/deployment checklist correctly retains it.
- Selected persisted-field/export raw-content sentinels are meaningful partial minimization evidence. A combined all-D1/queue/application-log retention sweep was not established by the inspected certificate. Platform request/access-log scrubbing, external processor retention and actual cleanup cadence remain unproved.
- Reproducible secret/dependency/security gate entrypoints and coverage/mutation/evaluation omissions are tracked in the separate QA gate map. This report does not certify scanners or execution that were absent, nor pull M1 holdout/runbook scope into an invented M0 result.

Security/privacy/cost effects: the repair prevents cross-account destructive intent swaps without broadening provider scopes, destinations, credentials, retained raw data or paid external work. Hosted processing remains server-visible, not zero knowledge. No new operational subsystem is recommended by this review.

Reviewer execution consisted only of read-only cat/sed/rg/python inspection and SHA256 commands, plus the explicitly permitted report write. No tests or external verification were run by the reviewer. Searches for a few absent filenames returned nonzero and were resolved to their actual locations; they were not labeled test failures or execution evidence.

## Strengthened actor-regression re-review

QA extended the same two cases without changing the three inspected production files. The before/after oracle now includes real ready jobs and connection state, scheduling, generation, credential version/ciphertext and next-sync metadata. The wrong-actor denial preserves all those rows; the current-B positive control cancels B's own job, clears its credentials and increments its connection generation while preserving A. A second actual signed session for the same B account refuses the first session's token with unchanged state and no journal effect. The second session's own capabilities GET returns200 and issues its token, demonstrating that the negative result is not an invalid synthetic-session fixture. That GET is a session-validity positive control, not a separate second-session deletion execution.

Read-only re-review confirms the stronger assertions are aligned with the actor/session requirement. QA reran the same exact Vitest command above: exit0,2/2,no skips,5.92seconds, recorded in the latest `t16-lifecycle-actor-green.txt` at02:03:25. This repeats the existing two tests; it is not two additional distinct cases. Final test SHA256: `00304826bee00cc8094be1125bb948d412cd1c70b494b458b0b579ff80008336`. The three production hashes above are unchanged. P1 remains closed for the bounded inspected repair, with integrated verification and all operational/live limitations unchanged.

## Evidence provenance correction — supersedes prior focused-log references

QA subsequently redirected a combined pipeline/actor invocation into `t16-lifecycle-actor-green.txt`, overwriting the prior focused raw2/2 output. The historical focused success at5.92seconds was reported through QA tools and inspected during the earlier review, but its separately retained raw output is now unavailable. **Neither that filename nor the preceding focused-log statements are an immutable artifact proving the earlier command.** Do not reconstruct the lost log or present the overwritten file as a focused all-green run.

The actual replacement output is preserved verbatim as `t16-composition-actor-initial-red.txt`: two files,24passed/1failed, exit1, start02:13:09,9.66seconds. The actor file's two tests passed;22of23 pipeline tests passed. The additional composition fixture failed because its queued sync work was passed to a source-extraction-only handler and returned handler-unavailable. This run is partial passing evidence with a fixture/composition failure, not a green combined suite and not a classified production behavioral RED. The initial pre-fix actor RED artifact remains unchanged.

The latest actor source adds an explicit assertion that A's actual capabilities GET issued a lifecycle token before the A-token/B-cookie rejection. This removes any ambiguity that the account-switch negative was merely a missing-token case. Reviewed final test SHA256 is now `634145a61b5814ec6bfea976922b1869dbea28f7f4095a60ee0f31012880b4e6`, superseding the previous test hash. Its actual two passed cases are evidenced by the preserved combined output and corresponding source; all three production hashes remain unchanged. The bounded source approval and closed P1 remain valid, while fresh integrated all-green/source-match evidence remains required. No broader M0 approval is granted.
