---
name: backend-and-contracts
description: "Implement strict APIs and domain use cases with tenant-scoped authorization."
---

# backend and contracts

## When to use

Routes, use cases, DTOs, pagination or shared contract changes.

## Inputs

Read root `AGENTS.md`, the assigned task and these files: `docs/12-api-contracts.md`, `docs/03-data-model.md`, `contracts/README.md`.

## Procedure

1. Write request/response and authorization tests first. Derive TenantContext from trusted auth; reject extra fields and unsafe magnitudes.

2. Implement the use case in core with narrow ports. Keep Hono handlers thin and provider/ORM details in adapters.

3. Use optimistic versions for edits, body-bound idempotency for commands and stable cursor pagination. Share inclusion/filter semantics across list, summary and export.

4. Map errors to safe typed codes without raw provider content. Verify cross-tenant denial on every new endpoint.

## Deliverable

Typed route/use-case patch, matching schemas, authorization tests and API documentation update.

## Quality gate

No request userId authority; no lost updates; no inconsistent totals or unsafe BigInt serialization.

Respect the assigned writable paths. A review assignment is read-only. Record what was actually run and distinguish blocked checks from successful checks.
