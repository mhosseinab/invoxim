import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import archive from "../../../packages/adapters/migrations/0002_archive_upload_sessions.sql?raw";
import recurrence from "../../../packages/adapters/migrations/0003_recurring_series.sql?raw";
import outlook from "../../../packages/adapters/migrations/0004_outlook_folder_exclusions.sql?raw";
import revision from "../../../packages/adapters/migrations/0005_reporting_revision.sql?raw";
import { createFxValuationRepository } from "../../../packages/adapters/src/fx/repository";
import { createLifecycleCleanup } from "../../../packages/adapters/src/lifecycle/cleanup";
import { cleanupConnection } from "../../../packages/adapters/src/lifecycle/connection-cleanup";
import { createPurchaseRepository } from "../../../packages/adapters/src/purchases";
import { createCredentialCipher } from "../../../packages/adapters/src/security/cipher";
import { createCredentialVault } from "../../../packages/adapters/src/security/vault";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;
const upgradeOwner = "revision-owner";
let owner = upgradeOwner;
let otherTenant = "revision-other";
let fixtureNumber = 0;
async function run(sql: string, ...values: unknown[]) {
  return db
    .prepare(sql)
    .bind(...values)
    .run();
}
async function stamp(userId = owner) {
  return db
    .prepare(
      "SELECT CAST(reporting_revision AS TEXT) AS revision FROM profiles WHERE user_id=?",
    )
    .bind(userId)
    .first<string>("revision");
}
async function user(id: string) {
  await run(
    "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Synthetic',?,1,0,0)",
    id,
    `${id}@example.invalid`,
  );
  await run(
    "INSERT INTO profiles(user_id,reporting_currency,created_at,updated_at) VALUES(?,'USD',0,0)",
    id,
  );
}
async function event(id: string) {
  return run(
    "INSERT INTO ledger_entries(id,user_id,purchase_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES(?,?,'purchase',?,'payment',1,'EUR','2026-01-01','user-confirmed-date',1,'user-confirmed')",
    id,
    owner,
    id,
  );
}
async function seedFixture() {
  await user(owner);
  await run(
    "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,payment_state) VALUES('purchase',?,'Synthetic','synthetic','2026-01-01','paid')",
    owner,
  );
  await event("earlier");
  await user(otherTenant);
  await run(
    "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,payment_state) VALUES('purchase',?,'Other','other','2026-01-01','paid')",
    otherTenant,
  );
  for (const id of ["mail", "mail-next"])
    await run(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address) VALUES(?,?,'mailbox','gmail',?,'synthetic@example.invalid')",
      id,
      owner,
      id,
    );
  await run(
    "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('source',?,'mail','synthetic',0,1)",
    owner,
  );
  await run(
    "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('doc',?,'source','body','synthetic','text/plain',1)",
    owner,
  );
  await run(
    "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('obs',?,'doc',0,'synthetic',1,'explicitly-paid','{\"schemaVersion\":1}','accepted')",
    owner,
  );
  await run(
    "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,'purchase','obs','payment')",
    owner,
  );
  await run(
    "INSERT INTO manual_purchase_evidence(user_id,purchase_id,document_id) VALUES(?,'purchase','doc')",
    owner,
  );
  await run(
    "INSERT INTO review_items(id,user_id,document_id,purchase_id,reason,blocking_scope,created_at) VALUES('review',?,'doc','purchase','unknown-payment','financial',0)",
    owner,
  );
  await run(
    "INSERT INTO field_overrides(user_id,entity_kind,entity_id,field,original_value_json,value_json,revision) VALUES(?,'purchase','purchase','merchant','\"Synthetic\"','\"Manual\"',1)",
    owner,
  );
}
beforeAll(async () => {
  for (const sql of [baseline, archive, recurrence, outlook])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
  await seedFixture();
  // CREATE TRIGGER bodies contain semicolons; END terminates each complete trigger.
  for (const statement of revision.match(
    /ALTER TABLE[\s\S]*?;|CREATE TRIGGER[\s\S]*?END;/g,
  ) ?? [])
    await db.prepare(statement).run();
});

beforeEach(async () => {
  fixtureNumber++;
  owner = `revision-owner-${fixtureNumber}`;
  otherTenant = `revision-other-${fixtureNumber}`;
  await seedFixture();
});

it("FX-05: populated upgrade preserves original facts and initializes a canonical report stamp", async () => {
  expect(await stamp(upgradeOwner)).toBe("1");
  expect(
    await db
      .prepare(
        "SELECT CAST(amount_minor AS TEXT) AS minor,currency FROM ledger_entries WHERE user_id=? AND id='earlier'",
      )
      .bind(upgradeOwner)
      .first(),
  ).toEqual({ minor: "1", currency: "EUR" });
  await user("revision-new");
  expect(await stamp("revision-new")).toBe("1");
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

it("FX-05: correcting an earlier row advances the report stamp without profile version changes", async () => {
  const before = await stamp();
  await run(
    "UPDATE ledger_entries SET amount_minor=2,version=version+1 WHERE user_id=? AND id='earlier'",
    owner,
  );
  expect(await stamp()).not.toBe(before);
  expect(
    await db
      .prepare("SELECT version FROM profiles WHERE user_id=?")
      .bind(owner)
      .first("version"),
  ).toBe(1);
});

it("FX-02/05: eligibility without entry version change invalidates coverage", async () => {
  const before = await stamp();
  await run(
    "UPDATE ledger_entries SET eligible=0 WHERE user_id=? AND id='earlier'",
    owner,
  );
  expect(await stamp()).not.toBe(before);
});

it("FX-05: inserting behind a cursor and deleting rows each invalidate the report", async () => {
  const before = await stamp();
  await event("behind");
  const inserted = await stamp();
  expect(inserted).not.toBe(before);
  await run(
    "DELETE FROM ledger_entries WHERE user_id=? AND id='behind'",
    owner,
  );
  expect(await stamp()).not.toBe(inserted);
});

it.each([
  [
    "purchase category filter",
    "UPDATE purchases SET category='travel' WHERE user_id=?",
  ],
  [
    "purchase period membership",
    "UPDATE purchases SET document_date='2026-02-01' WHERE user_id=?",
  ],
  [
    "purchase exclusion",
    "UPDATE purchases SET record_status='merged' WHERE user_id=?",
  ],
  [
    "lifecycle hidden marker",
    "UPDATE purchases SET lifecycle_delete_connection_id='mail' WHERE user_id=?",
  ],
  [
    "lifecycle recompute marker",
    "UPDATE purchases SET lifecycle_recompute_connection_id='mail' WHERE user_id=?",
  ],
  [
    "source evidence provenance",
    "UPDATE purchase_evidence SET relationship='invoice' WHERE user_id=?",
  ],
  [
    "manual evidence membership",
    "DELETE FROM manual_purchase_evidence WHERE user_id=?",
  ],
  [
    "review filter",
    "UPDATE review_items SET status='resolved' WHERE user_id=?",
  ],
  [
    "review question",
    "UPDATE review_items SET missing_fields_json='[\"currency\"]' WHERE user_id=?",
  ],
  [
    "exported extracted fields",
    'UPDATE observations SET normalized_fields=\'{"schemaVersion":1,"merchant":"Changed"}\' WHERE user_id=?',
  ],
  [
    "observation evidence code",
    "UPDATE observations SET evidence_code='invoice-only' WHERE user_id=?",
  ],
  [
    "observation review",
    "UPDATE observations SET review_state='needs_review' WHERE user_id=?",
  ],
  [
    "document source hash",
    "UPDATE documents SET content_hash='corrected' WHERE user_id=?",
  ],
  [
    "mailbox membership",
    "UPDATE source_messages SET connection_id='mail-next' WHERE user_id=?",
  ],
  [
    "source availability",
    "UPDATE source_messages SET available=0 WHERE user_id=?",
  ],
  [
    "exported source reference",
    "UPDATE source_messages SET provider_message_id='corrected' WHERE user_id=?",
  ],
  [
    "source provider",
    "UPDATE connections SET provider='outlook' WHERE user_id=? AND id='mail'",
  ],
  [
    "mailbox disconnect",
    "UPDATE connections SET state='disconnected' WHERE user_id=? AND id='mail'",
  ],
  [
    "exported override",
    "UPDATE field_overrides SET value_json='\"Corrected\"',revision=2 WHERE user_id=?",
  ],
  [
    "profile currency",
    "UPDATE profiles SET reporting_currency='EUR',version=2 WHERE user_id=?",
  ],
  [
    "profile timezone",
    "UPDATE profiles SET timezone='Europe/Vienna' WHERE user_id=?",
  ],
  [
    "profile deletion barrier",
    "UPDATE profiles SET status='deleting' WHERE user_id=?",
  ],
])(
  "FX-05: %s changes invalidate a same-timestamp report",
  async (_name, sql) => {
    const before = await stamp();
    const otherBefore = await stamp(otherTenant);
    await run(sql, owner);
    expect(await stamp()).not.toBe(before);
    expect(await stamp(otherTenant)).toBe(otherBefore);
  },
);

it("FX-05: ownership moves invalidate both tenants; composite ownership rejects foreign membership", async () => {
  const old = await stamp(),
    next = await stamp(otherTenant);
  await run(
    "UPDATE ledger_entries SET user_id=? WHERE user_id=? AND id='earlier'",
    otherTenant,
    owner,
  );
  expect(await stamp()).not.toBe(old);
  expect(await stamp(otherTenant)).not.toBe(next);
  await expect(
    run(
      "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,'purchase','obs','payment')",
      otherTenant,
    ),
  ).rejects.toThrow();
  expect(await stamp(otherTenant)).not.toBe(next);
});

it("FX-05: no-op replay, stale financial CAS and operational updates preserve the stamp", async () => {
  const before = await stamp();
  await run(
    "UPDATE ledger_entries SET amount_minor=amount_minor WHERE user_id=?",
    owner,
  );
  await run(
    "UPDATE ledger_entries SET amount_minor=3 WHERE user_id=? AND version=999",
    owner,
  );
  await run(
    "INSERT INTO ledger_entries SELECT * FROM ledger_entries WHERE user_id=? ON CONFLICT(user_id,business_event_key) DO NOTHING",
    owner,
  );
  await run(
    "UPDATE connections SET next_sync_at=100,credential_version=1 WHERE user_id=?",
    owner,
  );
  await run("UPDATE documents SET parse_state='ready' WHERE user_id=?", owner);
  await run(
    "UPDATE source_messages SET processing_status='processed' WHERE user_id=?",
    owner,
  );
  await run(
    "UPDATE profiles SET job_recovery_cursor='next',updated_at=100 WHERE user_id=?",
    owner,
  );
  expect(await stamp()).toBe(before);
});

it("FX-05: native batch rollback removes all revision and financial prefixes", async () => {
  const before = await stamp();
  await expect(
    db.batch([
      db
        .prepare("UPDATE ledger_entries SET amount_minor=2 WHERE user_id=?")
        .bind(owner),
      db
        .prepare("UPDATE ledger_entries SET amount_minor=-1 WHERE user_id=?")
        .bind(owner),
    ]),
  ).rejects.toThrow();
  expect(await stamp()).toBe(before);
  expect(
    await db
      .prepare(
        "SELECT amount_minor FROM ledger_entries WHERE user_id=? AND id='earlier'",
      )
      .bind(owner)
      .first("amount_minor"),
  ).toBe(1);
});

it("FX-05: maximum revision fails closed even for conflict-ignore writes", async () => {
  await run(
    "UPDATE profiles SET reporting_revision=9007199254740991 WHERE user_id=?",
    owner,
  );
  await expect(
    run(
      "UPDATE OR IGNORE ledger_entries SET amount_minor=2 WHERE user_id=?",
      owner,
    ),
  ).rejects.toThrow();
  expect(await stamp()).toBe("9007199254740991");
  expect(
    await db
      .prepare(
        "SELECT amount_minor FROM ledger_entries WHERE user_id=? AND id='earlier'",
      )
      .bind(owner)
      .first("amount_minor"),
  ).toBe(1);
  for (const value of [0, -1, 1.5, 9007199254740992])
    await expect(
      run(
        "UPDATE profiles SET reporting_revision=? WHERE user_id=?",
        value,
        owner,
      ),
    ).rejects.toThrow();
});

it("FX-05: deleting a profile safely cascades when its revision parent is absent", async () => {
  await run("DELETE FROM purchase_evidence WHERE user_id=?", owner);
  await run("DELETE FROM manual_purchase_evidence WHERE user_id=?", owner);
  await run("DELETE FROM ledger_entries WHERE user_id=?", owner);
  await run("DELETE FROM profiles WHERE user_id=?", owner);
  expect(await stamp()).toBeNull();
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

it("FX-05: pipeline changes() retains financial rows while D1 metadata exposes trigger amplification", async () => {
  const meter = createInvocationDatabase(db, 40);
  const result = await meter.db.batch([
    meter.db
      .prepare(
        "UPDATE purchases SET payment_state='unpaid',version=version+1 WHERE user_id=?",
      )
      .bind(owner),
    meter.db.prepare("SELECT changes() AS financial_rows"),
  ]);
  expect(result[1]?.results).toEqual([{ financial_rows: 1 }]);
  expect(result[0]?.meta.changes).toBe(2);
  console.info(
    "REPORTING_REVISION_NATIVE_META",
    JSON.stringify({
      submittedStatements: meter.executedStatements(),
      changes: result[0]?.meta.changes,
      rowsRead: result[0]?.meta.rows_read,
      rowsWritten: result[0]?.meta.rows_written,
    }),
  );
  expect(meter.executedStatements()).toBeLessThanOrEqual(2);
  expect(result[0]?.meta.rows_written).toBeGreaterThanOrEqual(2);
});

it("FX-01/02/05: pending valuation, revaluation and stale CAS preserve FX put metadata oracle", async () => {
  const meter = createInvocationDatabase(db, 40);
  const repository = createFxValuationRepository(meter.db, {
    policy: { source: "synthetic-reference", maxPriorAgeDays: 2 },
  });
  const tenant = { userId: owner, authority: "session" } as TenantContext;
  const write = {
    entryId: "earlier",
    expectedProfileVersion: 1,
    expectedEntryVersion: 1,
    expectedValuationVersion: 0,
    reportingCurrency: "USD",
    quote: null,
  };
  const before = await stamp();
  expect(await repository.put(tenant, write)).toMatchObject({
    status: "stored",
    result: { status: "unconverted", reason: "rate_missing" },
  });
  const valued = await stamp();
  expect(valued).not.toBe(before);
  expect(await repository.put(tenant, write)).toEqual({ status: "conflict" });
  expect(await stamp()).toBe(valued);
  expect(
    await repository.put(tenant, {
      ...write,
      expectedValuationVersion: 1,
      quote: {
        fromCurrency: "EUR",
        toCurrency: "USD",
        requestedDate: "2026-01-01",
        effectiveDate: "2026-01-01",
        rate: "0.5",
        source: "synthetic-reference",
        version: "snapshot-v1",
        retrievedAt: 0,
      },
    }),
  ).toMatchObject({
    status: "stored",
    valuationVersion: 2,
    result: { status: "converted", signedMinor: "1" },
  });
  const replayed = await stamp();
  expect(replayed).not.toBe(valued);
  await run("UPDATE ledger_entries SET version=2 WHERE user_id=?", owner);
  const changed = await stamp();
  expect(
    await repository.put(tenant, { ...write, expectedValuationVersion: 2 }),
  ).toEqual({ status: "stale" });
  expect(await stamp()).toBe(changed);
  await run("DELETE FROM entry_valuations WHERE user_id=?", owner);
  expect(await stamp()).not.toBe(changed);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("FX-05: merchant edit reports committed success despite revision trigger amplification", async () => {
  const meter = createInvocationDatabase(db, 40);
  const repository = createPurchaseRepository(meter.db);
  const context = { userId: owner, authority: "session" } as TenantContext;
  const before = await stamp();
  const edited = await repository.updateMerchant(
    context,
    "purchase",
    1,
    "Corrected",
  );
  expect(
    (await repository.detail(context, "purchase"))?.purchase.merchant_raw,
  ).toBe("Corrected");
  expect(edited).toBe(true);
  expect(await stamp()).not.toBe(before);
  expect(await repository.updateMerchant(context, "purchase", 1, "Stale")).toBe(
    false,
  );
  expect(
    await repository.updateMerchant(
      { userId: otherTenant, authority: "session" } as TenantContext,
      "purchase",
      99,
      "Wrong",
    ),
  ).toBe(false);
  expect(meter.executedStatements()).toBeLessThanOrEqual(5);
});

it("FX-05: purchase deletion reports committed success despite child cascades and revisions", async () => {
  const meter = createInvocationDatabase(db, 40);
  const repository = createPurchaseRepository(meter.db);
  const context = { userId: owner, authority: "session" } as TenantContext;
  const before = await stamp();
  const deleted = await repository.delete(context, "purchase", 1);
  expect(await repository.detail(context, "purchase")).toBeNull();
  expect(deleted).toBe(true);
  expect(await stamp()).not.toBe(before);
  expect(await repository.delete(context, "purchase", 1)).toBe(false);
  expect(meter.executedStatements()).toBeLessThanOrEqual(3);
});

it("FX-05: vault clear reports committed disconnect and preserves stale-generation denial", async () => {
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(17)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const meter = createInvocationDatabase(db, 40);
  const vault = createCredentialVault(
    meter.db,
    createCredentialCipher({ activeVersion: 1, keys: { 1: key } }),
  );
  const context = { userId: owner, authority: "session" } as TenantContext;
  const target = { kind: "connection", id: "mail", generation: 1 } as const;
  const cleared = await vault.clear(context, target, 0);
  expect(
    await db
      .prepare(
        "SELECT state,generation,credential_version FROM connections WHERE user_id=? AND id='mail'",
      )
      .bind(owner)
      .first(),
  ).toEqual({ state: "disconnected", generation: 2, credential_version: 1 });
  expect(cleared).toBe(true);
  expect(await vault.clear(context, target, 0)).toBe(false);
  expect(
    await vault.clear(
      { userId: otherTenant, authority: "session" } as TenantContext,
      target,
      0,
    ),
  ).toBe(false);
  expect(meter.executedStatements()).toBeLessThanOrEqual(3);
});

it("FX-05: account cleanup advances after 50 direct deletions despite 100 amplified changes", async () => {
  await run(
    "INSERT INTO field_overrides(user_id,entity_kind,entity_id,field,original_value_json,value_json,revision) SELECT ?,'purchase','purchase','field-'||value,'null','null',1 FROM json_each(?)",
    owner,
    JSON.stringify(Array.from({ length: 49 }, (_, i) => i)),
  );
  await run("UPDATE profiles SET status='deleting' WHERE user_id=?", owner);
  await run(
    "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,stage,journal_ack) VALUES(?,'account','','synthetic-account',0,4,1)",
    owner,
  );
  const meter = createInvocationDatabase(db, 40);
  expect(await createLifecycleCleanup(meter.db, null).runOne()).toEqual({
    status: "pending",
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM field_overrides WHERE user_id=?")
      .bind(owner)
      .first("count"),
  ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT stage FROM lifecycle_deletions WHERE user_id=? AND scope='account'",
      )
      .bind(owner)
      .first("stage"),
  ).toBe(5);
  expect(meter.executedStatements()).toBeLessThanOrEqual(3);
});

it("FX-05: connection cleanup advances after 50 direct eligibility updates despite trigger amplification", async () => {
  await run(
    "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) SELECT 'source-'||value,?,'purchase','obs','source-'||value,'payment',1,'EUR','2026-01-01','document-date',1 FROM json_each(?)",
    owner,
    JSON.stringify(Array.from({ length: 50 }, (_, i) => i)),
  );
  await run(
    "UPDATE connections SET state='disconnected' WHERE user_id=? AND id='mail'",
    owner,
  );
  await run(
    "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,stage,journal_ack) VALUES(?,'connection','mail','synthetic-connection',0,5,1)",
    owner,
  );
  const meter = createInvocationDatabase(db, 40);
  expect(
    await cleanupConnection(meter.db, {
      user_id: owner,
      target_id: "mail",
      request_id: "synthetic-connection",
      stage: 5,
    }),
  ).toEqual({ status: "pending" });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM ledger_entries WHERE user_id=? AND origin='source' AND eligible=1",
      )
      .bind(owner)
      .first("count"),
  ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT stage FROM lifecycle_deletions WHERE user_id=? AND scope='connection'",
      )
      .bind(owner)
      .first("stage"),
  ).toBe(6);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
