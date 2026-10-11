---
name: d1-data-integrity
description: "Protect tenant ownership, migrations, financial atomicity and query efficiency."
---

# d1 data integrity

## When to use

Schema, SQL, ORM, repositories, joins, dedupe or job-commit changes.

## Inputs

Read root `AGENTS.md`, the assigned task and these files: `docs/03-data-model.md`, `docs/02-architecture.md`.

## Procedure

1. Design composite tenant foreign keys and unique natural identifiers. Make query plans tenant/index bounded and monetary fields exact.

2. Create migrations and test both clean install and populated upgrade. Verify actual batch semantics on workerd rather than generic ORM assumptions.

3. Fence every write in leased operations. Inject conflict/rollback/crash scenarios and prove partial states cannot become visible financial results.

4. Test cross-tenant joins, duplicate commits and totals beyond JavaScript safe integers. Record measured query/row-scan behavior when relevant.

## Deliverable

Reviewed schema/migrations/repositories plus runtime atomicity and isolation evidence.

## Quality gate

No interactive transaction assumption without proof; no tenantless query; no truncating integer aggregate conversion.

Respect the assigned writable paths. A review assignment is read-only. Record what was actually run and distinguish blocked checks from successful checks.
