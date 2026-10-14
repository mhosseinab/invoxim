# T12 extraction-to-ledger completion report

Task T12, milestone M0. Status: done. Implementation, fresh verification, independent final review and documentation closeout passed. No commit, PR or deployment identity is claimed. Tested clean copied checkout: `/tmp/invoxim-t12-qa-final-9jxg7ws0/source`. Baseline 226-input SHA-256: `e082739305961074f74f50247af46ca1e971fb9f415677a5738988dce809b4f2`.

## Implemented behavior

Trusted discovery source jobs now compose bounded transient Gmail content, existing document extraction, approved provider-neutral inference and pure ledger reconciliation. Server flags/configuration select concrete adapters; hosted/BYOK preserve their approved destination. Parse/infer/reconcile use existing durable jobs and metadata-only continuations. Every actual D1 statement shares the invocation counter capped at 40. One queue message runs per invocation; additional messages retry. Extraction is unavailable below the 40-statement configured job budget. All live integration flags remain false and new-discovery readiness remains gated on T29 explicit review/start.

Exact content and scoped event references prevent duplicated financial effects; weak merchant/amount/day remains a review suggestion. Reissued invoices and changed extraction identities retain conflict evidence. Legacy observations remain readable and uncertain legacy financial identities cannot authorize extra cash. Invoice/order IDs must be source identifiers, not borrowed phone digits. Independent installments/refunds retain unique cash events, while unpaid invoices, pending refunds, credit notes, statements and redeemed credit do not invent cash events. Full mixed/credit-only settlement sets purchase status paid without increasing cash spending. Existing gross/manual fields remain intact; payment-state projections use optimistic versions.

Quote-free observations, evidence links, purchases, ledger entries, scoped reviews and completion apply atomically. Live optimistic races retry/reload cached inference without a second model call; stale authority refuses writes. Unsupported/per-document failed extraction retains operational review and continues siblings. Invalid keys pause authorization; provider rate limits pause budget. Possibly billed failures retain upper reservations. One inference attempt per document stage; malformed output requires review, while the separately tested inference engine retains its bounded two-attempt repair capability.

Changed areas: core ledger types/planner; extraction contracts/grounding/prompt fingerprint; adapter pipeline content/service/repository/guards; migration 0010; shared exports; Worker composition/queue policy; focused domain/native tests; manual/deployment/configuration documentation. Details and ownership: `t12-handoff.md`.

Acceptance LEDGER-01–09 exercised with explicit independent integer oracles and native isolation/failure controls. Additional required review regressions cover same-extraction conflicts, manual merchant/state preservation, partial refunds, legacy rows, content-only conflicts, document siblings, mixed/credit settlement and optimistic concurrency.

## Executed evidence

- Domain behavioral RED/GREEN and own quality checks: `t12-domain-report.md` and linked logs. Independent domain QA: `t12-qa-domain-red.txt` and `t12-qa-domain-green.txt`.
- Real pipeline/native behavioral REDs and repairs: `t12-qa-pipeline-red.txt`, `t12-qa-compound-select-red.txt`, `t12-qa-document-red.txt`, `t12-qa-version-red.txt`, `t12-qa-version-rejection-red.txt`; latest focused native QA 22 passed. Fixture authoring errors are explicitly separated in `t12-qa.md`.
- Persistence native clean/populated upgrade, isolation, real rollback, deletion, index plans, two-purchase state proof: 26 passed (20 pipeline plus six existing DB), `t12-database-final-green.txt`; report `t12-database.md`.
- Bounded content/runtime genuine RED/GREEN and eight native cases: `t12-runtime.md` and linked logs. Root queue RED then 29 job regressions passed; root source-reference REDs then 65 focused AI tests passed. `t12-reference-closeout.md` records exact outcomes.
- Fresh copied frozen install: exit 0; downloaded zero packages, existing ignore-scripts policy preserved. `t12-qa-frozen-install.txt`.
- Plain fresh `pnpm verify`: exit 0, **560 distinct tests**: 10 tooling, 45 contracts, 165 core, 333 workerd and seven browser. No final skips. Three property cases execute 1,500 fixed-seed samples inside the test count. Required boundaries, formatting, Biome warnings-as-errors, ESLint, five package typechecks, builds and browser checks passed. No caches were copied; later within-command no-emit build replay is not an additional fresh execution. `t12-qa-verify.txt`.
- Explicit `pnpm db:check`: exit 0, 40 native cases, a reexecuted subset of the above 560. Script now includes migration 0010 pipeline checks. `t12-qa-db-check.txt`.
- After tests source comparison: exit 0, zero tested-versus-initial and zero root-versus-tested differences across 226 inputs. `t12-qa-source-match.txt`, `t12-qa-final-snapshot.txt`.
- Whole-root Biome: exit 0, 196 supported files, zero diagnostics; whole-root Prettier and ESLint exit 0 before copy. `t12-root-all-biome.txt`, `t12-root-all-format.txt`, `t12-root-all-eslint.txt`.

Observed native stage statement counts: hosted two-document `[15,33,23,33,22]`; BYOK `[15,35,23]`; refusal/timeout siblings `[15,35,33,21]`. All measured invocations remain at or below 40. These are synthetic local measurements, not deployed CPU, capacity or pricing claims.

Independent read-only reviewer `/root/discovery_review` returned required findings to implementers and approved repaired source. `t12-source-review.md` records actual source approval/hashes. Final certificate `t12-final-review.md` approved the fresh QA and separately verified three-document closeout; all contingencies are closed and no reviewer test execution is claimed.

## Effects and remaining work

Migration 0010 adds document/parser/stage metadata, optional structured observations, indexed references and tenant-owned review items without replacing legacy rows. SQL constrains outer payload shape/size; application strict validation constrains nested quote-free fields/provenance. Native batches prove rollback and adjacent `changes()` completion proof; no generic commit marker/workflow store is added.

Privacy and permissions: no added provider scope, raw retention, R2, fallback or tool access. Originals/text/quotes/model transcripts remain transient. Only synthetic users/documents/keys and mocked provider network were used. No live OAuth/mail/model call, cost, deployment, production migration or public launch performed.

Limitations: local PDF parser subset; eight attachment downloads per parse stage; one model attempt per stage; graph caps 100 candidate purchases/1,000 observations; source labels/merchant names are not verified legal identity or broad model-quality evidence. Established installment gross is not silently replaced by a later full-order total; conflict review preserves both. Durable manual override/merge/correction interfaces remain T14. Reading real records/coverage and integrated onboarding remain T13/T29. Standalone security/evaluation/release placeholders are not represented as completed checks. M0/full MVP and live/release gates remain outstanding in MANUAL_TASKS.md and DEPLOYMENT_CHECKLIST.md.

First usable records derive actual committed purchases, separately from discovery/whole-import completion. Local staged jobs work without an open browser; no first-result speed promise or live full-history completion is claimed. Existing static example/browser isolation tests remain separate from authenticated application behavior.

Next dependency-ready implementation: T13 purchase-first Home/detail/read APIs and T15 structured export/disconnect/deletion, coordinated through shared read/filter contracts. No owner action is required to continue safe local implementation.


Documentation closeout: exactly MANUAL_TASKS.md, DEPLOYMENT_CHECKLIST.md and apps/worker/CONFIGURATION.md changed after the baseline. Independent formatting and exact diff audit exited 0; the other 223 inputs remain byte-identical. Current 226-input root/snapshot comparison has zero differences, manifest SHA-256 `133d28c44f254757a4bf0c8b9bc8731ad32f6eeef254036e1695919f8305e942`. This prose-only audit is not a claim that code tests were rerun after the three documentation edits. See `t12-qa-doc-closeout.md`.
