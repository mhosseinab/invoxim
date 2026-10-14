import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { accountTables } from "../../../packages/adapters/src/lifecycle/cleanup";
import { m1LeafTables } from "../../../packages/adapters/src/lifecycle/m1-leaf-cleanup";
import { useCurrentSchema } from "./support/db";

const db = env.DB;

/**
 * Tables that own tenant rows but are erased outside the two cleanup lists:
 * profiles flips to deleting and is removed with the user row; the deletion
 * journal is the cleanup record itself.
 */
const handledOutsideCleanupLists = new Set(["profiles", "lifecycle_deletions"]);

beforeAll(async () => {
  await useCurrentSchema(db);
});

it("P1.6 LIFECYCLE-SCHEMA: every user_id table is covered by account stages or M1 leaves (C6)", async () => {
  const tables = (
    await db
      .prepare(
        "SELECT m.name AS name FROM sqlite_schema m WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' AND m.name!='_cf_METADATA' AND EXISTS(SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name='user_id') ORDER BY m.name",
      )
      .all<{ name: string }>()
  ).results.map((row) => row.name);
  expect(tables.length).toBeGreaterThan(20);
  const covered = new Set<string>([
    ...accountTables,
    ...m1LeafTables,
    ...handledOutsideCleanupLists,
  ]);
  const missing = tables.filter((name) => !covered.has(name));
  expect(missing).toEqual([]);
});

it("P1.6 LIFECYCLE-SCHEMA: M1 leaf list matches its schema probe (C6)", async () => {
  const placeholders = m1LeafTables.map(() => "?").join(",");
  const present = (
    await db
      .prepare(
        `SELECT name FROM sqlite_schema WHERE type='table' AND name IN (${placeholders}) ORDER BY name`,
      )
      .bind(...m1LeafTables)
      .all<{ name: string }>()
  ).results.map((row) => row.name);
  // Every leaf the cleanup offers must exist in the current schema, otherwise
  // the drain silently skips it and the parent table is erased first.
  expect(present).toEqual([...m1LeafTables].sort());
});
