import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { createCorrectionStore } from "../../../packages/adapters/src/corrections/store";
import { createPurchaseViewReader } from "../../../packages/adapters/src/purchase-views";

const db = env.DB;

const now = 1000;
// Synthetic authority only: the cast does not authenticate a real caller.
const context = (userId: string) =>
  ({ userId, authority: "job" }) as TenantContext;
const reader = createPurchaseViewReader(db);
const corrections = createCorrectionStore(db, () => now);

beforeAll(async () => {
  for (const sql of [baseline]) {
    for (const statement of sql.split(";").filter((part) => part.trim())) {
      await db.prepare(statement).run();
    }
  }
  for (const user of ["qa-a", "qa-b"]) {
    await db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
      )
      .bind(user, user, `${user}@example.invalid`)
      .run();
    await db
      .prepare(
        "INSERT INTO profiles(user_id,status,created_at,updated_at) VALUES(?,'active',0,0)",
      )
      .bind(user)
      .run();
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state) VALUES(?,?,'mailbox','gmail',?,?,'active')",
      )
      .bind(`connection-${user}`, user, user, `${user}@example.invalid`)
      .run();
    await db
      .prepare(
        "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES(?,?,?,1,'synthetic-model','synthetic-parser',1,0,1)",
      )
      .bind(`consent-${user}`, user, `connection-${user}`)
      .run();
  }
});

async function seedPurchase(user: string, id: string) {
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,?,?,0,1)",
    )
    .bind(`source-${id}`, user, `connection-${user}`, `message-${id}`)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES(?,?,?,?,?, 'text/plain',10)",
    )
    .bind(`doc-${id}`, user, `source-${id}`, "body", "a".repeat(64))
    .run();
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES(?,?,?,0,?,1,'explicitly-paid','{\"schemaVersion\":1}','accepted')",
    )
    .bind(`obs-${id}`, user, `doc-${id}`, `fp-${id}`)
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES(?,?,?,?, '2026-10-01',1200,'EUR','paid')",
    )
    .bind(`purchase-${id}`, user, "Synthetic merchant", "synthetic merchant")
    .run();
  await db
    .prepare(
      "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,?,?,'source')",
    )
    .bind(user, `purchase-${id}`, `obs-${id}`)
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES(?,?,?,?,?,'payment',1200,'EUR','2026-10-01','document-date',1)",
    )
    .bind(`entry-${id}`, user, `purchase-${id}`, `obs-${id}`, `event-${id}`)
    .run();
}

async function count(table: string, user: string, id: string) {
  return db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id=? AND id=?`)
    .bind(user, id)
    .first<number>("count");
}

it("DB-01 rejects cross-tenant document, ledger and evidence parent substitutions", async () => {
  for (const user of ["qa-a", "qa-b"]) {
    await seedPurchase(user, `fk-${user}`);
  }
  await expect(
    db
      .prepare(
        "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('hostile-document','qa-a','source-fk-qa-b','part','hash','text/plain',1)",
      )
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "UPDATE ledger_entries SET observation_id='obs-fk-qa-b' WHERE user_id='qa-a' AND id='entry-fk-qa-a'",
      )
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "UPDATE purchase_evidence SET observation_id='obs-fk-qa-b' WHERE user_id='qa-a' AND purchase_id='purchase-fk-qa-a'",
      )
      .run(),
  ).rejects.toThrow();
  expect(await count("documents", "qa-a", "hostile-document")).toBe(0);
  expect(
    (await reader.detail(context("qa-a"), "purchase-fk-qa-a"))?.purchase.id,
  ).toBe("purchase-fk-qa-a");
});

it("DB-04 scopes list, joined detail, update and delete to synthetic trusted context", async () => {
  for (const user of ["qa-a", "qa-b"]) {
    await seedPurchase(user, `scope-${user}`);
  }
  const victim = "purchase-scope-qa-b";
  const before = await reader.detail(context("qa-b"), victim);
  expect(
    (await reader.list(context("qa-a"), { limit: 50 })).rows.some(
      (row) => row.id === victim,
    ),
  ).toBe(false);
  expect(await reader.detail(context("qa-a"), victim)).toBeNull();
  expect(
    await corrections
      .execute(
        { tenant: context("qa-a"), sessionId: "hostile-edit" },
        {
          kind: "purchase-edit",
          purchaseId: victim,
          request: { version: 1, changes: { merchant: "Hostile edit" } },
        },
        "hostile-edit-key",
      )
      .then(
        () => true,
        () => false,
      ),
  ).toBe(false);
  expect(
    await db
      .prepare(
        "DELETE FROM purchases WHERE user_id='qa-a' AND id=? AND version=1 RETURNING 1 AS applied",
      )
      .bind(victim)
      .first(),
  ).toBeNull();
  expect(await reader.detail(context("qa-b"), victim)).toEqual(before);
});

it("DB-02 unique source-message identity rejects a second source with the same provider message", async () => {
  await seedPurchase("qa-a", "dup-first");
  await expect(
    db
      .prepare(
        "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('dup-other','qa-a','connection-qa-a','message-dup-first',0,1)",
      )
      .run(),
  ).rejects.toThrow();
  expect(await count("source_messages", "qa-a", "source-dup-first")).toBe(1);
});

it("DB-02 unique ledger business event key rejects a second entry", async () => {
  await seedPurchase("qa-a", "event-first");
  await expect(
    db
      .prepare(
        "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES('event-dup','qa-a','purchase-event-first','obs-event-first','event-event-first','payment',1200,'EUR','2026-10-01','document-date',1)",
      )
      .run(),
  ).rejects.toThrow();
  expect(await count("ledger_entries", "qa-a", "entry-event-first")).toBe(1);
});

it("T04 unique document part identity rejects a second document without discarding original", async () => {
  await seedPurchase("qa-a", "part-first");
  await expect(
    db
      .prepare(
        "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('part-dup','qa-a','source-part-first','body','b'.repeat(64),'text/plain',10)",
      )
      .run(),
  ).rejects.toThrow();
  expect(await count("documents", "qa-a", "doc-part-first")).toBe(1);
});

it("T04 unique observation fingerprint rejects a second observation with the same fingerprint", async () => {
  await seedPurchase("qa-a", "obs-first");
  await expect(
    db
      .prepare(
        "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('obs-dup','qa-a','doc-obs-first',0,'fp-obs-first',1,'explicitly-paid','{\"schemaVersion\":1}','accepted')",
      )
      .run(),
  ).rejects.toThrow();
  expect(await count("observations", "qa-a", "obs-obs-first")).toBe(1);
});

it("T04 amount bound rejects values above 9000000000000", async () => {
  await seedPurchase("qa-a", "bound-first");
  await expect(
    db
      .prepare(
        "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES('over-bound','qa-a','purchase-bound-first','observation-bound-first','event-over-bound','payment',9000000000001,'EUR','2026-10-01','document-date',1)",
      )
      .run(),
  ).rejects.toThrow();
});
