# Recurring persistence checkpoint

User-selected, tenant-scoped series persist versioned memberships and confirm/dismiss/pause/cancel decisions. Current projections suppress forecasts when evidence versions, eligibility or original selected-member count change. Forecasts never write ledger events; provider plan identity and pricing remain unknown unless evidenced.

Executed native acceptance: `/tmp/invoxim-recurring-count-green-v2.txt`, exit 0, 10 tests passed, 1.89 seconds. Earlier genuine behavioral RED includes missing stored-series creation and deletion silently reducing selected membership; logs `/tmp/invoxim-fx-recurring-recent-check-v1.txt` and `/tmp/invoxim-recurring-deletion-red-v1.txt`. Independent read-only reviewer `/root/discovery_review` approved the persistence slice and checked source hashes.

Scoped Biome, ESLint, Prettier for three TypeScript files and diff checks passed at this checkpoint. Prettier has no SQL parser configured: an attempted explicit SQL check exited 2 for unsupported parser, followed by successful checks of supported files. The migration is exercised by the native tests. Source-derived maximum 20-member creation is 21 batch statements plus one selection query, 22 executions; it is not an executed maximum-size witness.

Still required: bounded lifecycle cleanup of recurring leaves, API/UI integration, automatic evidence-backed terms and identity/pricing behavior, whole-repository checks and separate live/deployment gates. This checkpoint does not complete T20. Migration `0003_recurring_series.sql` follows the consolidated fresh baseline; do not reset or replay the baseline on existing databases.
