# Delivery and operations


A completed task includes relevant RED/GREEN tests, lint/typecheck/format/build, integration/security/evaluation checks, migration evidence, independent review when available, and updated docs. Report exact omissions and approved waivers. No placeholder implementations, empty tests, disabled guards or TODOs in a claimed-complete feature path.

Treat external calls and queue delivery as fallible. Persist resumable work, enforce leases with fencing on every write, respect provider rate limits, keep retries bounded and make duplicate execution safe. Cancellation/account deletion must stop new writes, not only hide a settings row.

Meter hosted/BYOK inference separately, reserve budgets atomically and disclose potentially billed timeouts. Keep public signup allowlisted until launch gates clear. Cloudflare free tiers are bounded and not a business-model guarantee.

Production changes require explicit owner authority, isolated resource bindings, reviewed migrations, secret management, smoke checks and rollback planning. Restore deleted users only into an isolated environment long enough to suppress them again; never serve a restored database before deletion/session/credential reconciliation. Record actual operating limits and unsupported document/provider cases.
