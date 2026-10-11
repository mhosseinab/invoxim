---
name: cloudflare-runtime
description: "Implement and verify Pages, Workers, Queues and scheduled jobs within actual limits."
---

# cloudflare runtime

## When to use

Worker bindings, deployment, queue/scheduler or runtime-dependent work.

## Inputs

Read root `AGENTS.md`, the assigned task and these files: `docs/02-architecture.md`, `docs/09-operations-and-costs.md`.

## Procedure

1. Confirm stable tool versions and runtime-compatible dependencies. Spike actual auth/crypto/DB/document paths before claiming Free-plan viability.

2. Keep one Worker app with fetch/scheduled/queue entry points and a thin same-origin Pages proxy. Verify binding names, cookie forwarding and trusted origin.

3. Bound work and payloads; persist jobs in D1 and send only IDs. Test lost messages, lease takeover, retries, disconnect generation and poison jobs.

4. Use isolated local/staging/production bindings. Measure CPU/limits, log only safe counters and do not add raw R2 storage.

## Deliverable

Worker/binding patch, actual workerd tests and redacted runtime measurements.

## Quality gate

No Node daemon/native parser assumption; no exactly-once queue assumption; no unbounded fan-out or production preview binding.

Respect the assigned writable paths. A review assignment is read-only. Record what was actually run and distinguish blocked checks from successful checks.
