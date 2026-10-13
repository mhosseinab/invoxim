import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import schema from "./baseline-schema.json";
import migration0 from "./migrations/historical/0001_auth.sql?raw";
import migration1 from "./migrations/historical/0002_records.sql?raw";
import migration2 from "./migrations/historical/0003_indexes_and_schedule.sql?raw";
import migration3 from "./migrations/historical/0004_credentials_and_oauth.sql?raw";
import migration4 from "./migrations/historical/0005_profile_version.sql?raw";
import migration5 from "./migrations/historical/0006_jobs.sql?raw";
import migration6 from "./migrations/historical/0007_mailbox.sql?raw";
import migration7 from "./migrations/historical/0008_discovery.sql?raw";
import migration8 from "./migrations/historical/0009_ai.sql?raw";
import migration9 from "./migrations/historical/0010_ledger_pipeline.sql?raw";
import migration10 from "./migrations/historical/0011_lifecycle.sql?raw";
import migration11 from "./migrations/historical/0012_review_fields.sql?raw";
import migration12 from "./migrations/historical/0013_corrections.sql?raw";
import migration13 from "./migrations/historical/0014_onboarding.sql?raw";
import migration14 from "./migrations/historical/0015_fx.sql?raw";
import migration15 from "./migrations/historical/0016_outlook_folders.sql?raw";
import migration16 from "./migrations/historical/0017_drive_storage.sql?raw";
import migration17 from "./migrations/historical/0018_archive_objects.sql?raw";
import migration18 from "./migrations/historical/0019_archive_folders.sql?raw";

const migrations = [
  migration0,
  migration1,
  migration2,
  migration3,
  migration4,
  migration5,
  migration6,
  migration7,
  migration8,
  migration9,
  migration10,
  migration11,
  migration12,
  migration13,
  migration14,
  migration15,
  migration16,
  migration17,
  migration18,
];
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

async function apply(sql: string) {
  await db.batch(
    sql
      .split(";")
      .filter((s) => s.trim())
      .map((sql) => db.prepare(sql)),
  );
}
beforeAll(async () => {
  // Create genuine pre-upgrade rows before later table-rebuilding migrations.
  for (const sql of migrations.slice(0, 3)) await apply(sql);
  await execute(
    'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
    "upgrade-owner",
    "Synthetic",
    "upgrade@example.invalid",
    1,
    1791885600123,
    1791885600123,
  );
  await execute(
    "INSERT INTO profiles(user_id,created_at,updated_at) VALUES('upgrade-owner',1791885600123,1791885600123)",
  );
  await execute(
    "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address) VALUES('upgrade-mail','upgrade-owner','mailbox','gmail','identity','upgrade@example.invalid')",
  );
  await execute(
    "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('upgrade-source','upgrade-owner','upgrade-mail','message',1791885600123,1)",
  );
  await execute(
    "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('upgrade-document','upgrade-owner','upgrade-source','part','hash','application/pdf',10)",
  );
  await execute(
    "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,currency,payment_state,total_minor) VALUES('upgrade-purchase','upgrade-owner','Synthetic','synthetic','2026-10-13','EUR','unpaid',9000000000000)",
  );
  for (const sql of migrations.slice(3)) await apply(sql);
});
it("DB-BASELINE: populated historical forward upgrade equals fresh baseline constraints", async () => {
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
    schema.map((r) => ({ ...r, sql: normalize(r.sql) })),
  );
  expect(await query("PRAGMA foreign_key_check")).toEqual([]);
});
it("DB-BASELINE: upgrade retains ownership, millisecond timestamps and exact monetary integers", async () => {
  expect(
    await query(
      'SELECT id,createdAt,typeof(createdAt) AS storage FROM "user" WHERE id=?',
      "upgrade-owner",
    ),
  ).toEqual([
    { id: "upgrade-owner", createdAt: 1791885600123, storage: "integer" },
  ]);
  expect(
    await query(
      "SELECT id,user_id,CAST(total_minor AS TEXT) AS total FROM purchases WHERE id=?",
      "upgrade-purchase",
    ),
  ).toEqual([
    {
      id: "upgrade-purchase",
      user_id: "upgrade-owner",
      total: "9000000000000",
    },
  ]);
  expect(
    await query(
      "SELECT id,user_id,source_message_id FROM documents WHERE id=?",
      "upgrade-document",
    ),
  ).toEqual([
    {
      id: "upgrade-document",
      user_id: "upgrade-owner",
      source_message_id: "upgrade-source",
    },
  ]);
});

it("DB-BASELINE: populated historical upgrade retains the same scheduler initialization rows as the new baseline", async () => {
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
