# T04 integration completion

Task: D1 schema and tenant repositories, M0. Status: done for the bounded local persistence increment. Independent frozen source identity: 55b9f0d8b375e9c6a186b661c85f2754a92c5a324d599ed10dc2fd1bf8ef81d7 (84 files including SQL). This is a source manifest, not a commit or deployment identity. Full M0 remains incomplete.

Implemented: generated pinned auth schema plus tenant-owned profiles, connections, consents, import parent/recent-older/live state, sources/documents/observations, purchase evidence, ledger and job-compatible fence state. Clean and populated-upgrade migrations preserve data and exercise ownership constraints/index plans. Focused repositories accept an opaque TenantContext and provide scoped reads/joins/optimistic merchant edits/deletes, exact BigInt totals, and atomic accepted-source persistence. Exact retries preserve identities and manual edits; conflicting source bytes, observations, purchase financial facts or ledger events abort with COMMIT_CONFLICT. Review barriers and stale lease/fence/generation/consent prevent writes. Unknown total/currency stay null. Full auth, scheduler and extraction workflows are excluded.

Root changed package.json (real db:check), pnpm-lock.yaml, adapters package.json/tsconfig, worker dependencies/test harness/env declarations, and core TenantContext/export. Database implementer owns adapters source/migrations/README and database.test.ts; QA independently owns database-adversarial.test.ts. No prior user changes were reset. The direct D1 prepared-SQL decision and primary documentation checks are recorded in t04-persistence-decision.md.

## Evidence

Initial behavioral RED: t04-implementer-red.txt, exit1, cross-tenant purchase/observation association wrongly succeeded. Independent diagnostic RED logs reproduced silent conflicting amount/source-byte/observation/purchase acceptance, completed-job lifecycle mismatch and observation review-barrier bypass before fixes. These are genuine failures, not missing imports or fabricated tests. Earlier environment/configuration failures remain separately recorded.

Final root command: WRANGLER_LOG_PATH=/tmp/invoxim-t04-db-check.log WRANGLER_SEND_METRICS=false pnpm db:check; exit0, 20 actual D1 tests across two files (6 implementer +14 QA), t04-db-check.txt. All DB-01/02/03/04 acceptance cases are locally exercised. Exact large-total expectation 9018000000000000 minor units is checked beyond JavaScript safe-integer range; no staging performance/capacity claim.

Independent QA final post-barrier clean copied source: frozen install exit0; pnpm verify exit0; explicit db:check exit0. Actual fresh tests: 7 tooling +39 core +39 contracts +25 workerd (20 database +5 prior) +7 browser =117. Three core property tests additionally execute 1,500 generated cases within the 39 core tests. Five-package typechecks and core/contracts/adapters prerequisite builds were freshly executed; those build logs were reused later within the same verification run, with remote caching disabled. Final source comparison found zero differences. See t04-qa.md and t04-qa-final-{install,verify,db-check,snapshot}.txt, t04-qa-source-match.txt. Earlier pre-barrier full verification is explicitly superseded by this final run.

Independent read-only reviewer discovery_review approved the final identity and durable execution evidence, with no open scoped findings; no reviewer tests or edits. See t04-review.md. Scoped implementer formatting/lint/typecheck/build checks also exit0, documented in t04-implementer-completion.md (its initial pending-certification wording is superseded by this integration report).

Existing-checkout install attempts hit ERR_PNPM_IGNORED_BUILDS for pre-existing generated esbuild/workerd state despite committed ignoreScripts. No scripts were approved or policy bypassed. Both independent clean installs using the committed policy passed; final install evidence certifies fresh reproducibility rather than claiming those failed local attempts passed.

## Effects and remaining work

No production database/binding/resource, deployment, provider call, credential access or added service cost. DB is currently a local test binding; future application composition must use an explicitly configured approved resource. Structured metadata only; no persisted originals, mail bodies, model transcripts or arbitrary payloads. Auth token columns follow the generated schema, but no auth-provider token writes or credential encryption are implemented here.

TenantContext is a type boundary, not authentication. T05/T07 must derive it internally from verified sessions/stored jobs. T06 supplies encryption; T07 supplies claim/dispatch/recovery; T11/T12 supply current destination revision/grounded reconciliation and typed conflict resolution; T14/T15 supply review resolution and complete disconnect/deletion/cancellation. Source cascades are not a deletion guarantee. M1 tables remain deferred. No live OAuth, remote D1, provider integration, native browser zoom or full MVP/release gate is claimed.

Next dependency-ready tasks: T05 Google login/isolated sessions and T06 credential vault/OAuth state. Live smoke tests require operator configuration separately; safe synthetic implementation can proceed.
