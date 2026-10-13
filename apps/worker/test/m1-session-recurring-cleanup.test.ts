import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import sessions from "../../../packages/adapters/migrations/0002_archive_upload_sessions.sql?raw";
import recurring from "../../../packages/adapters/migrations/0003_recurring_series.sql?raw";
import {
  cleanupM1Leaves,
  type M1CleanupItem,
} from "../../../packages/adapters/src/lifecycle/m1-leaf-cleanup";
import { createRecurringService } from "../../../packages/adapters/src/recurring/service";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;
beforeAll(async () => {
  for (const source of [baseline, sessions, recurring])
    for (const statement of source.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
});
async function owner(user: string) {
  await db
    .prepare(
      "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Synthetic',?,1,0,0)",
    )
    .bind(user, `${user}@example.invalid`)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind(user)
    .run();
  for (const connection of ["target", "other", "drive", "other-drive"])
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES(?,?,?,?,?,'synthetic@example.invalid','disconnected')",
      )
      .bind(
        connection,
        user,
        connection.includes("drive") ? "storage" : "mailbox",
        connection.includes("drive") ? "google-drive" : "gmail",
        connection,
      )
      .run();
  for (const connection of ["target", "other"])
    await db
      .prepare(
        "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,?,?,0,1)",
      )
      .bind(connection, user, connection, connection)
      .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('doc',?,'target','body','synthetic','text/plain',1)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('obs',?,'doc',0,'synthetic',1,'explicitly-paid','{\"schemaVersion\":1}','accepted')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('purchase',?,'Synthetic','synthetic','2026-01-31',1000,'EUR','paid')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES('entry',?,'purchase','obs','entry','payment',1000,'EUR','2026-01-31','document-date',0)",
    )
    .bind(user)
    .run();
}
async function mark(
  user: string,
  scope: "account" | "connection",
  target = "target",
  stage = 6,
): Promise<M1CleanupItem> {
  if (scope === "account")
    await db
      .prepare("UPDATE profiles SET status='deleting' WHERE user_id=?")
      .bind(user)
      .run();
  const targetId = scope === "account" ? "account" : target;
  const requestId = `request-${user}`;
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,stage,journal_ack) VALUES(?,?,?,?,0,?,1)",
    )
    .bind(user, scope, targetId, requestId, stage)
    .run();
  const base = {
    user_id: user,
    target_id: targetId,
    request_id: requestId,
    stage,
  };
  return scope === "account"
    ? { ...base, scope, deleted_at: 0 }
    : { ...base, scope };
}
async function archive(
  user: string,
  count: number,
  mailbox = "target",
  storage = "drive",
  prefix = "upload",
) {
  await db
    .prepare(
      "WITH RECURSIVE ids(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<?) INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) SELECT ?||n,?,?,?||n,'synthetic','application/pdf',1 FROM ids",
    )
    .bind(count, prefix, user, mailbox, prefix)
    .run();
  await db
    .prepare(
      "INSERT INTO archive_objects(id,user_id,document_id,source_message_id,provider_message_id,part_key,document_hash,document_mime,document_size,mailbox_connection_id,mailbox_generation,storage_connection_id,storage_generation,storage_subject,settings_version) SELECT id,user_id,id,source_message_id,'synthetic',part_key,'synthetic','application/pdf',1,?,1,?,1,?,1 FROM documents WHERE user_id=? AND id LIKE ?",
    )
    .bind(mailbox, storage, storage, user, `${prefix}%`)
    .run();
  await db
    .prepare(
      "INSERT INTO archive_upload_sessions(user_id,object_id,reference_ciphertext,key_version,version,expires_at) SELECT user_id,id,'synthetic-encrypted-session',1,1,9999999999 FROM archive_objects WHERE user_id=? AND id LIKE ?",
    )
    .bind(user, `${prefix}%`)
    .run();
}
async function series(
  user: string,
  count: number,
  entry = "entry",
  prefix = "series",
) {
  await db
    .prepare(
      "WITH RECURSIVE ids(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<?) INSERT INTO recurring_series(user_id,id,identity_kind,identity_key,currency,cadence,anchor_date,selected_entry_count,mutation_id,updated_at) SELECT ?,?||n,'user-confirmed','synthetic-plan','EUR','monthly','2026-01-31',1,?,0 FROM ids",
    )
    .bind(count, user, prefix, "a".repeat(36))
    .run();
  await db
    .prepare(
      "INSERT INTO recurring_entries(user_id,series_id,entry_id,selected_entry_version,selected_purchase_version) SELECT user_id,id,?,1,1 FROM recurring_series WHERE user_id=? AND id LIKE ?",
    )
    .bind(entry, user, `${prefix}%`)
    .run();
}
async function count(table: string, user: string) {
  return db
    .prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE user_id=?`)
    .bind(user)
    .first<number>("total");
}
async function unit(item: M1CleanupItem) {
  const meter = createInvocationDatabase(db, 3);
  const result = await cleanupM1Leaves(meter.db, item);
  expect(meter.executedStatements()).toBeLessThanOrEqual(3);
  return result;
}
it("M1-CLEANUP-01: account session leaves drain at most100 before archive-object cascade", async () => {
  const user = "session-account-cap";
  await owner(user);
  await owner("session-foreign");
  await archive(user, 105);
  await archive("session-foreign", 2);
  const item = await mark(user, "account");
  expect(await unit(item)).toBe(true);
  expect(await count("archive_upload_sessions", user)).toBe(5);
  expect(await count("archive_objects", user)).toBe(105);
  expect(await count("archive_upload_sessions", "session-foreign")).toBe(2);
  expect(await unit(item)).toBe(true);
  expect(await count("archive_upload_sessions", user)).toBe(0);
  expect(await count("archive_objects", user)).toBe(105);
});
for (const target of ["target", "drive"])
  it(`M1-CLEANUP-02: ${target} connection session cleanup is bounded and excludes unrelated mailbox/storage pairs`, async () => {
    const user = `session-${target}-cap`;
    await owner(user);
    await archive(user, 105);
    await archive(user, 2, "other", "other-drive", "retained");
    const item = await mark(user, "connection", target);
    expect(await unit(item)).toBe(true);
    expect(await count("archive_upload_sessions", user)).toBe(7);
    expect(await count("archive_objects", user)).toBe(107);
    expect(await unit(item)).toBe(true);
    expect(await count("archive_upload_sessions", user)).toBe(2);
    expect(await count("archive_objects", user)).toBe(107);
  });
it("M1-CLEANUP-03: account recurring references drain before bounded series erasure and ledger parents", async () => {
  const user = "recurring-account-cap";
  await owner(user);
  await owner("recurring-foreign");
  await series(user, 105);
  await series("recurring-foreign", 2);
  const item = await mark(user, "account");
  expect(await unit(item)).toBe(true);
  expect(await count("recurring_entries", user)).toBe(5);
  expect(await count("recurring_series", user)).toBe(105);
  expect(await count("ledger_entries", user)).toBe(1);
  expect(await count("recurring_entries", "recurring-foreign")).toBe(2);
  expect(await count("recurring_series", "recurring-foreign")).toBe(2);
  expect(await unit(item)).toBe(true);
  expect(await count("recurring_entries", user)).toBe(0);
  expect(await count("recurring_series", user)).toBe(105);
  expect(await unit(item)).toBe(true);
  expect(await count("recurring_series", user)).toBe(5);
  expect(await count("ledger_entries", user)).toBe(1);
});
it("M1-CLEANUP-04: source connection references wait for stage6, preserve manual facts and retain series metadata", async () => {
  const user = "recurring-connection-cap";
  await owner(user);
  await series(user, 105);
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('manual',?,'purchase','manual','payment',50,'EUR','2026-01-31','user-confirmed-date',1,'user-confirmed')",
    )
    .bind(user)
    .run();
  await series(user, 1, "manual", "manual-series");
  const early = await mark(user, "connection", "target", 5);
  expect(await unit(early)).toBe(false);
  expect(await count("recurring_entries", user)).toBe(106);
  await db
    .prepare("UPDATE lifecycle_deletions SET stage=6 WHERE user_id=?")
    .bind(user)
    .run();
  const item = { ...early, stage: 6 };
  expect(await unit(item)).toBe(true);
  expect(await count("recurring_entries", user)).toBe(6);
  expect(await count("recurring_series", user)).toBe(106);
  expect(await unit(item)).toBe(true);
  expect(await count("recurring_entries", user)).toBe(1);
  expect(await count("recurring_series", user)).toBe(106);
  expect(await count("ledger_entries", user)).toBe(2);
  expect(
    await createRecurringService(db).read(
      {
        userId: user,
        authority: "job",
      } as TenantContext,
      "series1",
    ),
  ).toMatchObject({
    status: "stale",
    reason: "evidence_changed",
    entryIds: [],
  });
});
it("M1-CLEANUP-05: stale request, active account and unacknowledged journal cannot erase leaves", async () => {
  const user = "session-stale";
  await owner(user);
  await archive(user, 105);
  const item = await mark(user, "account");
  expect(await unit({ ...item, request_id: "old-request" })).toBe(true);
  expect(await count("archive_upload_sessions", user)).toBe(105);
  await db
    .prepare("UPDATE lifecycle_deletions SET journal_ack=0 WHERE user_id=?")
    .bind(user)
    .run();
  expect(await unit(item)).toBe(true);
  expect(await count("archive_upload_sessions", user)).toBe(105);
  await db
    .prepare("UPDATE lifecycle_deletions SET journal_ack=1 WHERE user_id=?")
    .bind(user)
    .run();
  await db
    .prepare("UPDATE profiles SET status='active' WHERE user_id=?")
    .bind(user)
    .run();
  expect(await unit(item)).toBe(true);
  expect(await count("archive_upload_sessions", user)).toBe(105);
});
