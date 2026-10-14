import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { useCurrentSchema } from "./db";

const db = env.DB;

beforeAll(async () => {
  await useCurrentSchema(db);
});

it("useCurrentSchema applies migrations 0001–0007 (X1)", async () => {
  const tables = (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='_cf_METADATA' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results.map((r) => r.name);
  // Spot-check tables from each migration generation.
  expect(tables).toContain("user"); // 0001
  expect(tables).toContain("archive_upload_sessions"); // 0002
  expect(tables).toContain("recurring_series"); // 0003
  expect(tables).toContain("archive_backfill_runs"); // 0006
  expect(tables).toContain("archive_document_order"); // 0007
  // 0004 adds excluded_folder_ids to outlook_inventory_states.
  const columns = (
    await db.prepare("PRAGMA table_info(outlook_inventory_states)").all()
  ).results as { name: string }[];
  expect(columns.map((c) => c.name)).toContain("excluded_folder_ids");
});

it("useCurrentSchema is idempotent on an already-migrated database", async () => {
  await expect(useCurrentSchema(db)).resolves.toBeUndefined();
});
