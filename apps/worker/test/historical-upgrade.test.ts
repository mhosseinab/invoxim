import { env } from "cloudflare:workers";
import { createLoginAuth, loginConfiguration } from "@invoxim/adapters";
import { beforeAll, expect, it } from "vitest";
import { cleanupConnection } from "../../../packages/adapters/src/lifecycle/connection-cleanup";
import worker from "../src/index";
import { createInvocationDatabase } from "../src/invocation-database";
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
  for (const sql of migrations.slice(3, 12)) await apply(sql);
  // EDIT-01: populated rows that exist before the corrections migration (0013)
  // rebuilds the ledger tables and renumbers lifecycle cleanup stages.
  await seedEdit01BeforeCorrections();
  await apply(migrations[12] as string);
  edit01StagesAfterCorrections = await query(
    "SELECT scope,stage FROM lifecycle_deletions WHERE user_id='edit01-owner' ORDER BY scope",
  );
  // Cleanup progressed again before the onboarding migration (0014) restarts
  // only account cleanup.
  await execute(
    "UPDATE lifecycle_deletions SET stage=CASE WHEN scope='account' THEN 6 ELSE 8 END WHERE user_id='edit01-owner'",
  );
  await apply(migrations[13] as string);
  edit01AfterOnboarding = await readEdit01();
  for (const sql of migrations.slice(14, 16)) await apply(sql);
  // Pre-Drive compatibility: the worker serves /api/connections before the
  // optional Drive migration (0017) has created archive_settings.
  preDrive = await preDriveConnections();
  for (const sql of migrations.slice(16)) await apply(sql);
});

let preDrive: Awaited<ReturnType<typeof preDriveConnections>> | undefined;

async function preDriveConnections() {
  const userId = "connections-pre-drive";
  const loginEmail = `${userId}@example.invalid`;
  await execute(
    "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)",
    userId,
    "Synthetic legacy owner",
    loginEmail,
  );
  await execute(
    "INSERT INTO profiles(user_id,timezone,reporting_currency,created_at,updated_at) VALUES(?,'Europe/Vienna','EUR',0,0)",
    userId,
  );
  await execute(
    "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes,credential_ciphertext,credential_key_version,credential_version,scheduling_state) VALUES('mailbox-b',?,'mailbox','gmail','mailbox-b','selected-b@example.invalid',?,'synthetic-encrypted-token',1,1,'awaiting_import')",
    userId,
    JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
  );
  const bindings = {
    DB: env.DB,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://connections-legacy.example.invalid",
    AUTH_SECRET: "synthetic-legacy-connection-secret-1234567890",
    AUTH_GOOGLE_CLIENT_ID: "synthetic-login",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic-login-secret",
    AUTH_ALLOWED_EMAILS: JSON.stringify([loginEmail]),
  };
  const login = loginConfiguration(bindings);
  if (!login) throw new Error("Synthetic login fixture unavailable");
  const auth = await createLoginAuth(db, login).$context;
  const session = await auth.internalAdapter.createSession(userId, false);
  if (!session) throw new Error("Synthetic session not created");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(login.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(session.token),
  );
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${btoa(String.fromCharCode(...new Uint8Array(signed)))}`)}`;
  const archiveSettings = await query(
    "SELECT name FROM sqlite_schema WHERE name='archive_settings'",
  );
  const response = await worker.fetch(
    new Request(`${login.origin}/api/connections`, {
      headers: { Cookie: cookie },
    }),
    bindings,
  );
  return {
    archiveSettings,
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.text(),
  };
}

let edit01StagesAfterCorrections: Record<string, unknown>[] = [];
let edit01AfterOnboarding: Awaited<ReturnType<typeof readEdit01>> | undefined;

async function seedEdit01BeforeCorrections() {
  await execute(
    "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('edit01-owner','Synthetic','edit01@example.invalid',1,0,0)",
  );
  await execute(
    "INSERT INTO profiles(user_id,status,created_at,updated_at) VALUES('edit01-owner','deleting',0,0)",
  );
  await execute(
    "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,stage,journal_ack) VALUES('edit01-owner','account','account','edit01-marker-identity',1000,20,1),('edit01-owner','connection','edit01-mail','edit01-source-marker',1000,8,0)",
  );
  await execute(
    "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES('edit01-mail','edit01-owner','mailbox','gmail','synthetic','edit01@example.invalid','disconnected')",
  );
  await execute(
    "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('edit01-source','edit01-owner','edit01-mail','synthetic',0,1)",
  );
  await execute(
    "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('edit01-doc','edit01-owner','edit01-source','body','synthetic-hash','text/plain',10)",
  );
  await execute(
    "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('edit01-observation','edit01-owner','edit01-doc',0,'synthetic',1,'explicitly-paid','{\"schemaVersion\":1}','accepted')",
  );
  await execute(
    "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('edit01-purchase','edit01-owner','Synthetic','synthetic','2026-01-01',1234,'EUR','paid')",
  );
  await execute(
    "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,version) VALUES('edit01-entry','edit01-owner','edit01-purchase','edit01-observation','edit01-stable-key','payment',1234,'EUR','2026-01-01','document-date',1,4)",
  );
  await execute(
    "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at,missing_fields_json) VALUES('edit01-review','edit01-owner','edit01-doc','edit01-observation','edit01-purchase','incomplete-financial-facts','financial','open',150,'[\"currency\"]')",
  );
  await execute(
    "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at) VALUES('source-deletion:edit01-purchase','edit01-owner','edit01-doc',NULL,'edit01-purchase','incomplete-financial-facts','financial','open',150)",
  );
  await execute(
    "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,version) VALUES('edit01-ineligible','edit01-owner','edit01-purchase','edit01-observation','edit01-ineligible-key','payment',1,'EUR','2026-01-01','document-date',0,7)",
  );
}

async function readEdit01() {
  const one = async (sql: string) => (await query(sql))[0];
  return {
    entry: await one(
      "SELECT amount_minor,origin,version,business_event_key FROM ledger_entries WHERE id='edit01-entry'",
    ),
    ineligible: await one(
      "SELECT eligible,version FROM ledger_entries WHERE id='edit01-ineligible'",
    ),
    purchase: await one(
      "SELECT payment_state,lifecycle_recompute_connection_id FROM purchases WHERE id='edit01-purchase'",
    ),
    sourceDeletionReview: await one(
      "SELECT reason,document_id,observation_id,status,version FROM review_items WHERE id='source-deletion:edit01-purchase'",
    ),
    profileStatus: await one(
      "SELECT status FROM profiles WHERE user_id='edit01-owner'",
    ),
    deletions: await query(
      "SELECT scope,stage,journal_ack,request_id FROM lifecycle_deletions WHERE user_id='edit01-owner' ORDER BY scope",
    ),
    review: await one(
      "SELECT id,version,missing_fields_json,reason,status,observation_id,purchase_id FROM review_items WHERE id='edit01-review'",
    ),
    foreignKeys: await query("PRAGMA foreign_key_check"),
  };
}
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

it("EDIT-01 historical corrections migration 0013 restarts every quiesced cleanup stage", () => {
  // Migration-driven: the reset comes from applying historical 0013 to
  // populated rows at stages 20 and 8, not from a hand-written UPDATE.
  expect(edit01StagesAfterCorrections).toEqual([
    { scope: "account", stage: 0 },
    { scope: "connection", stage: 0 },
  ]);
});

it("EDIT-01 populated migration preserves source entry values and restarts pending cleanup without restoring access", () => {
  expect(edit01AfterOnboarding).toEqual({
    entry: {
      amount_minor: 1234,
      origin: "source",
      version: 4,
      business_event_key: "edit01-stable-key",
    },
    ineligible: { eligible: 0, version: 7 },
    purchase: {
      payment_state: "unknown",
      lifecycle_recompute_connection_id: "edit01-mail",
    },
    sourceDeletionReview: {
      reason: "payment-allocation-review",
      document_id: null,
      observation_id: null,
      status: "open",
      version: 1,
    },
    profileStatus: { status: "deleting" },
    deletions: [
      {
        scope: "account",
        stage: 0,
        journal_ack: 1,
        request_id: "edit01-marker-identity",
      },
      {
        scope: "connection",
        stage: 8,
        journal_ack: 0,
        request_id: "edit01-source-marker",
      },
    ],
    review: {
      id: "edit01-review",
      version: 1,
      missing_fields_json: '["currency"]',
      reason: "incomplete-financial-facts",
      status: "open",
      observation_id: "edit01-observation",
      purchase_id: "edit01-purchase",
    },
    foreignKeys: [],
  });
});

it("LIFECYCLE-04 retained settlement resolves105 questions through at most100 actual D1 row writes per unit", async () => {
  // Runs on the upgraded historical schema (historical 0001–0019, which equals
  // the current 0001 baseline). On the full current schema (0001–0007) the
  // 0005 reporting_revision triggers add one profile write per resolved
  // question; that budget regression is reported separately.
  const user = "lifecycle04-owner";
  await execute(
    "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Synthetic','lifecycle04@example.invalid',1,0,0)",
    user,
  );
  await execute(
    "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    user,
  );
  await execute(
    "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES('bounded-recompute-mail',?,'mailbox','gmail','bounded-recompute','bounded-recompute@example.invalid','disconnected')",
    user,
  );
  await execute(
    "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,stage,journal_ack,deleted_at) VALUES(?,'connection','bounded-recompute-mail','bounded-recompute-cleanup',9,0,0)",
    user,
  );
  await execute(
    "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state,origin,lifecycle_recompute_connection_id) VALUES('bounded-recompute-purchase',?,'Synthetic','synthetic','2026-01-01',100,'EUR','unknown','user-supplied','bounded-recompute-mail')",
    user,
  );
  await execute(
    "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('bounded-recompute-cash',?,'bounded-recompute-purchase',NULL,'bounded-recompute-cash','payment',100,'EUR','2026-01-01','user-confirmed-date',1,'user-confirmed')",
    user,
  );
  await execute(
    "WITH RECURSIVE numbers(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<105) INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at) SELECT 'bounded-recompute-question-'||n,?,NULL,NULL,'bounded-recompute-purchase','payment-allocation-review','financial','open',0 FROM numbers",
    user,
  );
  const writes: number[] = [];
  for (let unit = 0; unit < 5; unit++) {
    const invocation = createInvocationDatabase(env.DB, 5);
    let rowWrites = 0;
    const measured: D1Database = {
      prepare: (sql) => invocation.db.prepare(sql),
      exec: (sql) => invocation.db.exec(sql),
      dump: () => invocation.db.dump(),
      withSession: (constraint) => invocation.db.withSession(constraint),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        const results = await invocation.db.batch<T>(statements);
        rowWrites += results.reduce(
          (sum, result) => sum + result.meta.changes,
          0,
        );
        return results;
      },
    };
    await cleanupConnection(measured, {
      user_id: user,
      target_id: "bounded-recompute-mail",
      request_id: "bounded-recompute-cleanup",
      stage: 9,
    });
    writes.push(rowWrites);
    expect(rowWrites).toBeLessThanOrEqual(100);
    expect(invocation.remainingStatements()).toBeGreaterThanOrEqual(1);
    const [state] = await query<{
      payment_state: string;
      lifecycle_recompute_connection_id: string | null;
    }>(
      "SELECT payment_state,lifecycle_recompute_connection_id FROM purchases WHERE id='bounded-recompute-purchase'",
    );
    if (!state) throw new Error("retained purchase missing");
    if (!state.lifecycle_recompute_connection_id) {
      expect(state.payment_state).toBe("paid");
      break;
    }
    expect(state.payment_state).toBe("unknown");
  }
  expect(writes).toEqual([100, 7]);
  expect(
    await query(
      "SELECT COUNT(*) AS resolved FROM review_items WHERE purchase_id='bounded-recompute-purchase' AND status='resolved'",
    ),
  ).toEqual([{ resolved: 105 }]);
  expect(
    await query(
      "SELECT lifecycle_recompute_connection_id FROM purchases WHERE id='bounded-recompute-purchase'",
    ),
  ).toEqual([{ lifecycle_recompute_connection_id: null }]);
  expect(
    await query(
      "SELECT id,amount_minor,eligible FROM ledger_entries WHERE purchase_id='bounded-recompute-purchase'",
    ),
  ).toEqual([{ id: "bounded-recompute-cash", amount_minor: 100, eligible: 1 }]);
});

it("canonical private metadata works before the optional Drive migration and without OAuth adapters", () => {
  if (!preDrive) throw new Error("pre-Drive checkpoint did not run");
  expect(preDrive.archiveSettings).toEqual([]);
  expect(preDrive.status).toBe(200);
  expect(preDrive.cacheControl).toBe("no-store");
  const value = JSON.parse(preDrive.body) as {
    connections: unknown[];
    hasMore: boolean;
  };
  expect(value.connections).toEqual([
    expect.objectContaining({
      id: "mailbox-b",
      kind: "mailbox",
      provider: "gmail",
      configured: true,
    }),
  ]);
  expect(value.hasMore).toBe(false);
  expect(preDrive.body).not.toContain("synthetic-encrypted-token");
});
