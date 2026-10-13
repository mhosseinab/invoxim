import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import expected from "./baseline-schema.json";

const db = env.DB;
async function execute(sql: string, ...args: unknown[]) {
  return db
    .prepare(sql)
    .bind(...args)
    .run();
}
async function query<T = Record<string, unknown>>(
  sql: string,
  ...args: unknown[]
): Promise<T[]> {
  return (
    await db
      .prepare(sql)
      .bind(...args)
      .all<T>()
  ).results;
}

beforeAll(async () => {
  await db.batch(
    baseline
      .split(";")
      .filter((s) => s.trim())
      .map((sql) => db.prepare(sql)),
  );
});
it("DB-BASELINE: clean D1 contains every historical table, CHECK, tenant FK, default and index", async () => {
  const rows = await query<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string;
  }>(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name!='_cf_METADATA' ORDER BY type,name",
  );
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
  expect(rows.map((r) => ({ ...r, sql: normalize(r.sql) }))).toEqual(
    expected.map((r) => ({ ...r, sql: normalize(r.sql) })),
  );
});
it("DB-BASELINE: owner CHECK and composite constraints reject hostile records", async () => {
  await execute(
    'INSERT INTO "user" VALUES(?,?,?,?,?,?,?)',
    "baseline-a",
    "A",
    "a@example.invalid",
    1,
    null,
    0,
    0,
  );
  await execute(
    'INSERT INTO "user" VALUES(?,?,?,?,?,?,?)',
    "baseline-b",
    "B",
    "b@example.invalid",
    1,
    null,
    0,
    0,
  );
  await execute(
    "INSERT INTO profiles(user_id,created_at,updated_at) VALUES('baseline-a',0,0),('baseline-b',0,0)",
  );
  await execute(
    "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address) VALUES('baseline-mail','baseline-b','mailbox','gmail','subject','b@example.invalid')",
  );
  await expect(
    execute(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('foreign','baseline-a','baseline-mail','msg',0,1)",
    ),
  ).rejects.toThrow();
  await expect(
    execute("UPDATE profiles SET version=0 WHERE user_id='baseline-a'"),
  ).rejects.toThrow();
  await expect(
    execute(
      "INSERT INTO archive_settings(user_id,enabled,version) VALUES('baseline-a',1,1)",
    ),
  ).rejects.toThrow();
});

it("DB-BASELINE: fresh initialization retains historical dispatch, schedule and recovery cursor seeds", async () => {
  expect(
    await query(
      "SELECT kind,last_user_id,version FROM scheduler_cursors ORDER BY kind",
    ),
  ).toEqual([
    { kind: "dispatch", last_user_id: "", version: 0 },
    { kind: "recovery", last_user_id: "", version: 0 },
    { kind: "schedule", last_user_id: "", version: 0 },
  ]);
});
