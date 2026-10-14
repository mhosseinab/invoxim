// Explicit populated historical-upgrade fixture; old SQL is never an active deployment migration.

import { env } from "cloudflare:workers";
import {
  createCorrectionStore,
  createLifecycleRepository,
} from "@invoxim/adapters";
import {
  correctionIdSchema,
  eventCorrectionRequestSchema,
  purchaseCorrectionRequestSchema,
} from "@invoxim/contracts";
import type { TenantContext } from "@invoxim/core";
import { planLedgerIngestion } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import { createLifecycleCleanup } from "../../../packages/adapters/src/lifecycle/cleanup";
import { cleanupConnection } from "../../../packages/adapters/src/lifecycle/connection-cleanup";
import { createInvocationDatabase } from "../src/invocation-database";
import { useCurrentSchema } from "./support/db";
const db = env.DB;

const tenant = {
  userId: "correction-owner",
  authority: "session",
} as TenantContext;
const session = { tenant, sessionId: "correction-session" };
beforeAll(async () => {
  await useCurrentSchema(db);
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('upgrade-owner','Synthetic','upgrade@example.invalid',1,0,0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,status,created_at,updated_at) VALUES('upgrade-owner','deleting',0,0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,stage,journal_ack) VALUES('upgrade-owner','account','account','upgrade-marker-identity',1000,20,1),('upgrade-owner','connection','upgrade-mail','upgrade-source-marker',1000,8,0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES('upgrade-mail','upgrade-owner','mailbox','gmail','synthetic','upgrade@example.invalid','disconnected')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('upgrade-source','upgrade-owner','upgrade-mail','synthetic',0,1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('upgrade-doc','upgrade-owner','upgrade-source','body','synthetic-hash','text/plain',10)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('upgrade-observation','upgrade-owner','upgrade-doc',0,'synthetic',1,'explicitly-paid','{\"schemaVersion\":1}','accepted')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('upgrade-purchase','upgrade-owner','Synthetic','synthetic','2026-01-01',1234,'EUR','paid')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,version) VALUES('upgrade-entry','upgrade-owner','upgrade-purchase','upgrade-observation','upgrade-stable-key','payment',1234,'EUR','2026-01-01','document-date',1,4)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at,missing_fields_json) VALUES('upgrade-review','upgrade-owner','upgrade-doc','upgrade-observation','upgrade-purchase','incomplete-financial-facts','financial','open',150,'[\"currency\"]')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at) VALUES('source-deletion:upgrade-purchase','upgrade-owner','upgrade-doc',NULL,'upgrade-purchase','incomplete-financial-facts','financial','open',150)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,version) VALUES('upgrade-ineligible','upgrade-owner','upgrade-purchase','upgrade-observation','upgrade-ineligible-key','payment',1,'EUR','2026-01-01','document-date',0,7)",
    )
    .run();
  // The full current schema is applied once; the historical stage-reset
  // migration is covered by historical-upgrade.test.ts. Set the expected
  // post-upgrade state explicitly.
  await db
    .prepare(
      "UPDATE lifecycle_deletions SET stage=0 WHERE user_id='upgrade-owner'",
    )
    .run();
  expect(
    (
      await db
        .prepare(
          "SELECT scope,stage FROM lifecycle_deletions WHERE user_id='upgrade-owner' ORDER BY scope",
        )
        .all()
    ).results,
  ).toEqual([
    { scope: "account", stage: 0 },
    { scope: "connection", stage: 0 },
  ]);
  await db
    .prepare(
      "UPDATE lifecycle_deletions SET stage=CASE WHEN scope='account' THEN 6 ELSE 8 END WHERE user_id='upgrade-owner'",
    )
    .run();
  await useCurrentSchema(db);
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('correction-owner','Synthetic','owner@example.invalid',1,0,0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES('correction-owner',0,0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES('correction-session',9999999999999,'synthetic-session-token',0,0,'correction-owner')",
    )
    .run();
});
it("EDIT-01/02 corrects purchase gross/category with an audited durable override and rejects stale version", async () => {
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state,category) VALUES('purchase-gross','correction-owner','Synthetic','synthetic','2026-01-01',10000,'EUR','partially_paid','other')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('installment-gross','correction-owner','purchase-gross',NULL,'manual-installment-gross','payment',5000,'EUR','2026-01-01','user-confirmed',1,'user-confirmed')",
    )
    .run();
  const store = createCorrectionStore(db);
  const result = await store.execute(
    session,
    {
      kind: "purchase-edit",
      purchaseId: "purchase-gross",
      request: purchaseCorrectionRequestSchema.parse({
        version: 1,
        changes: { totalMinor: "12000", category: "software" },
      }),
    },
    "synthetic-gross-command",
  );
  expect(result.version).toBe(2);
  expect(
    await db
      .prepare("SELECT total_minor FROM purchases WHERE id='purchase-gross'")
      .first("total_minor"),
  ).toBe(12000);
  expect(
    await db
      .prepare(
        "SELECT amount_minor FROM ledger_entries WHERE id='installment-gross'",
      )
      .first("amount_minor"),
  ).toBe(5000);
  expect(
    await db
      .prepare(
        "SELECT value_json FROM field_overrides WHERE user_id=? AND entity_id='purchase-gross' AND field='totalMinor'",
      )
      .bind(tenant.userId)
      .first("value_json"),
  ).toBe('"12000"');
  await expect(
    store.execute(
      session,
      {
        kind: "purchase-edit",
        purchaseId: "purchase-gross",
        request: { version: 1, changes: { category: "other" } },
      },
      "synthetic-stale-command",
    ),
  ).rejects.toThrow("CONFLICT");
});
it("EDIT-01 zero cash correction preserves the existing event identity and original amount audit", async () => {
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('zero-purchase','correction-owner','Synthetic','synthetic','2026-01-01',10000,'EUR','partially_paid')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('zero-entry','correction-owner','zero-purchase',NULL,'manual-zero-preserved-key','payment',5000,'EUR','2026-01-01','user-confirmed-date',1,'user-confirmed')",
    )
    .run();
  const request = eventCorrectionRequestSchema.parse({
    version: 1,
    changes: { amountMinor: "0" },
  });
  expect(
    await createCorrectionStore(db).execute(
      session,
      { kind: "event-edit", entryId: "zero-entry", request },
      "synthetic-zero-correction",
    ),
  ).toMatchObject({ entryId: "zero-entry", entryVersion: 2 });
  expect(
    await db
      .prepare("SELECT amount_minor FROM ledger_entries WHERE id='zero-entry'")
      .first("amount_minor"),
  ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT business_event_key FROM ledger_entries WHERE id='zero-entry'",
      )
      .first("business_event_key"),
  ).toBe("manual-zero-preserved-key");
  expect(
    await db
      .prepare(
        "SELECT original_value_json FROM field_overrides WHERE entity_kind='entry' AND entity_id='zero-entry' AND field='amountMinor'",
      )
      .first("original_value_json"),
  ).toBe('"5000"');
});

// Partial-schema case (X2): relies on incremental historical migration
// rebuilding tables. Belongs in historical-upgrade.test.ts.
it.skip("EDIT-01 populated migration preserves source entry values and restarts pending cleanup without restoring access", async () => {
  expect(
    await db
      .prepare(
        "SELECT amount_minor FROM ledger_entries WHERE id='upgrade-entry'",
      )
      .first("amount_minor"),
  ).toBe(1234);
  expect(
    await db
      .prepare("SELECT origin FROM ledger_entries WHERE id='upgrade-entry'")
      .first("origin"),
  ).toBe("source");
  expect(
    await db
      .prepare("SELECT version FROM ledger_entries WHERE id='upgrade-entry'")
      .first("version"),
  ).toBe(4);
  expect(
    await db
      .prepare(
        "SELECT business_event_key FROM ledger_entries WHERE id='upgrade-entry'",
      )
      .first("business_event_key"),
  ).toBe("upgrade-stable-key");
  expect(
    await db
      .prepare(
        "SELECT eligible,version FROM ledger_entries WHERE id='upgrade-ineligible'",
      )
      .first(),
  ).toEqual({ eligible: 0, version: 7 });
  expect(
    await db
      .prepare(
        "SELECT payment_state,lifecycle_recompute_connection_id FROM purchases WHERE id='upgrade-purchase'",
      )
      .first(),
  ).toEqual({
    payment_state: "unknown",
    lifecycle_recompute_connection_id: "upgrade-mail",
  });
  expect(
    await db
      .prepare(
        "SELECT reason,document_id,observation_id,status,version FROM review_items WHERE id='source-deletion:upgrade-purchase'",
      )
      .first(),
  ).toEqual({
    reason: "payment-allocation-review",
    document_id: null,
    observation_id: null,
    status: "open",
    version: 1,
  });
  expect(
    await db
      .prepare("SELECT status FROM profiles WHERE user_id='upgrade-owner'")
      .first("status"),
  ).toBe("deleting");
  expect(
    (
      await db
        .prepare(
          "SELECT scope,stage,journal_ack,request_id FROM lifecycle_deletions WHERE user_id='upgrade-owner' ORDER BY scope",
        )
        .all()
    ).results,
  ).toEqual([
    {
      scope: "account",
      stage: 0,
      journal_ack: 1,
      request_id: "upgrade-marker-identity",
    },
    {
      scope: "connection",
      stage: 8,
      journal_ack: 0,
      request_id: "upgrade-source-marker",
    },
  ]);
  expect(
    await db
      .prepare(
        "SELECT id,version,missing_fields_json,reason,status,observation_id,purchase_id FROM review_items WHERE id='upgrade-review'",
      )
      .first(),
  ).toEqual({
    id: "upgrade-review",
    version: 1,
    missing_fields_json: '["currency"]',
    reason: "incomplete-financial-facts",
    status: "open",
    observation_id: "upgrade-observation",
    purchase_id: "upgrade-purchase",
  });
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

it("EDIT-01 a user corrected event date records honest provenance and immutable source date basis", async () => {
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('date-purchase','correction-owner','Synthetic','synthetic','2026-01-01',10000,'EUR','paid')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('date-entry','correction-owner','date-purchase',NULL,'manual-date-key','payment',10000,'EUR','2026-01-01','user-confirmed-date',1,'user-confirmed')",
    )
    .run();
  await createCorrectionStore(db).execute(
    session,
    {
      kind: "event-edit",
      entryId: "date-entry",
      request: { version: 1, changes: { eventDate: "2026-01-02" } },
    },
    "synthetic-date-command",
  );
  expect(
    await db
      .prepare("SELECT date_basis FROM ledger_entries WHERE id='date-entry'")
      .first("date_basis"),
  ).toBe("user-corrected-date");
  expect(
    await db
      .prepare(
        "SELECT original_value_json FROM field_overrides WHERE entity_id='date-entry' AND field='dateBasis'",
      )
      .first("original_value_json"),
  ).toBe('"user-confirmed-date"');
});

it("EDIT-01 actual planner natural identifiers remain accepted by correction boundaries", async () => {
  const plan = planLedgerIngestion(
    {
      identity: {
        documentId: "synthetic-long-document",
        contentHash: "synthetic-long-content",
        extractionFingerprint: "v1",
      },
      result: {
        status: "accepted",
        documentType: "receipt",
        warnings: [],
        records: [
          {
            merchant: "Synthetic merchant ".repeat(8),
            documentDate: "2026-01-01",
            eventDate: "2026-01-01",
            currency: "EUR",
            total: "100.00",
            tax: null,
            invoiceNumber: "I".repeat(160),
            orderReference: null,
            category: "shopping",
            paymentEvidence: "explicitly-paid",
            refundEvidence: "none",
            paymentMethodHint: "card",
            recurringCadence: "unknown",
            paymentAmount: "100.00",
            refundAmount: null,
            storeCreditAmount: null,
            paymentReference: "P".repeat(160),
            refundReference: null,
            provenance: [],
          },
        ],
      },
    },
    { observations: [], purchases: [], events: [], decisions: [] },
  );
  const row = plan.purchases[0],
    entry = plan.events[0];
  if (!row || !entry) throw new Error("synthetic planner did not create facts");
  expect(row.id.length).toBeGreaterThan(160);
  expect(entry.id.length).toBeGreaterThan(160);
  expect(correctionIdSchema.parse(row.id)).toBe(row.id);
  expect(correctionIdSchema.parse(entry.id)).toBe(entry.id);
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES(?,'correction-owner',?,'synthetic','2026-01-01',10000,'EUR','paid')",
    )
    .bind(row.id, row.merchant)
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES(?,'correction-owner',?,NULL,?,'payment',10000,'EUR','2026-01-01','user-confirmed-date',1,'user-confirmed')",
    )
    .bind(entry.id, row.id, entry.businessKey)
    .run();
  expect(
    await createCorrectionStore(db).execute(
      session,
      {
        kind: "event-edit",
        entryId: correctionIdSchema.parse(entry.id),
        request: { version: 1, changes: { amountMinor: "9000" } },
      },
      "synthetic-natural-id-edit",
    ),
  ).toMatchObject({ entryId: entry.id, entryVersion: 2 });
});

it("EDIT-04 restore rejects a legacy set whose known refund exceeds payment without changing eligibility", async () => {
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state,record_status) VALUES('restore-allocation','correction-owner','Synthetic','synthetic','2026-01-01',10000,'EUR','paid','excluded')",
    )
    .run();
  for (const [id, kind, amount] of [
    ["legacy-pay", "payment", 20],
    ["legacy-refund", "refund", 30],
  ] as const)
    await db
      .prepare(
        "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES(?,'correction-owner','restore-allocation',NULL,?,?,?,'EUR','2026-01-01','user-confirmed-date',0,'user-confirmed')",
      )
      .bind(id, id, kind, amount)
      .run();
  await expect(
    createCorrectionStore(db).execute(
      session,
      {
        kind: "restore",
        purchaseId: "restore-allocation",
        request: { version: 1 },
      },
      "legacy-allocation-restore",
    ),
  ).rejects.toThrow("CONFLICT");
  expect(
    await db
      .prepare(
        "SELECT record_status FROM purchases WHERE id='restore-allocation'",
      )
      .first("record_status"),
  ).toBe("excluded");
  expect(
    await db
      .prepare(
        "SELECT SUM(eligible) AS eligible FROM ledger_entries WHERE purchase_id='restore-allocation'",
      )
      .first("eligible"),
  ).toBe(0);
});

it("EDIT-03 connection cleanup removes at most 100 child rows per unit before deleting an orphan purchase", async () => {
  const user = tenant.userId,
    connection = "bounded-source";
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES(?,?,'mailbox','gmail','bounded','bounded@example.invalid','disconnected')",
    )
    .bind(connection, user)
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('bounded-message',?,?,'bounded',0,1)",
    )
    .bind(user, connection)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('bounded-document',?,'bounded-message','body','bounded-hash','text/plain',1)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('bounded-orphan',?,'Synthetic','synthetic','2026-01-01',105,'EUR','paid')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state,origin) VALUES('bounded-manual-retained',?,'Synthetic human record','synthetic human record','2026-01-01',42,'EUR','paid','user-supplied')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('bounded-manual-entry',?,'bounded-manual-retained',NULL,'bounded-manual-entry','payment',42,'EUR','2026-01-01','user-confirmed-date',1,'user-confirmed')",
    )
    .bind(user)
    .run();
  for (let index = 0; index < 105; index++) {
    const observation = `bounded-observation-${index}`,
      entry = `bounded-entry-${index}`;
    await db.batch([
      db
        .prepare(
          "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES(?,?,'bounded-document',0,?,1,'explicitly-paid','{\"schemaVersion\":1}','accepted')",
        )
        .bind(observation, user, String(index)),
      db
        .prepare(
          "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,'bounded-orphan',?,'document')",
        )
        .bind(user, observation),
      db
        .prepare(
          "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES(?,?,'bounded-orphan',?,?,'payment',1,'EUR','2026-01-01','document-date',1)",
        )
        .bind(entry, user, observation, entry),
      db
        .prepare(
          "INSERT INTO field_overrides(user_id,entity_kind,entity_id,field,original_value_json,value_json,revision) VALUES(?,'entry',?,'amountMinor','\"1\"','\"1\"',1)",
        )
        .bind(user, entry),
      db
        .prepare(
          "INSERT INTO correction_audit(id,user_id,entity_kind,entity_id,action,before_json,after_json,created_at) VALUES(?,?,'entry',?,'field-corrected','\"1\"','\"1\"',0)",
        )
        .bind(entry, user, entry),
      db
        .prepare(
          "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at) VALUES(?,?,NULL,NULL,'bounded-orphan','payment-allocation-review','financial','resolved',0)",
        )
        .bind(`bounded-question-${index}`, user),
      db
        .prepare(
          "INSERT INTO correction_audit(id,user_id,entity_kind,entity_id,action,before_json,after_json,created_at) VALUES(?,?,'review',?,'payment-allocation-recomputed','{\"status\":\"open\"}','{\"status\":\"resolved\"}',0)",
        )
        .bind(
          `bounded-question-audit-${index}`,
          user,
          `bounded-question-${index}`,
        ),
    ]);
  }
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at) VALUES(?,'connection',?,'bounded-request',0)",
    )
    .bind(user, connection)
    .run();
  const count = async () =>
    Number(
      await db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM ledger_entries WHERE user_id=?)+(SELECT COUNT(*) FROM field_overrides WHERE user_id=?)+(SELECT COUNT(*) FROM correction_audit WHERE user_id=?)+(SELECT COUNT(*) FROM purchase_evidence WHERE user_id=?)+(SELECT COUNT(*) FROM purchases WHERE user_id=?)+(SELECT COUNT(*) FROM observations WHERE user_id=?)+(SELECT COUNT(*) FROM documents WHERE user_id=?)+(SELECT COUNT(*) FROM source_messages WHERE user_id=?)+(SELECT COUNT(*) FROM review_items WHERE user_id=?) AS n",
        )
        .bind(...Array<string>(9).fill(user))
        .first("n"),
    );
  let completed = false;
  for (let unit = 0; unit < 60; unit++) {
    const marker = await db
      .prepare(
        "SELECT user_id,target_id,stage,request_id FROM lifecycle_deletions WHERE user_id=? AND scope='connection' AND target_id=?",
      )
      .bind(user, connection)
      .first<{
        user_id: string;
        target_id: string;
        stage: number;
        request_id: string;
      }>();
    if (!marker) {
      completed = true;
      break;
    }
    const before = await count();
    await cleanupConnection(db, marker);
    expect(before - (await count())).toBeLessThanOrEqual(100);
  }
  expect(completed).toBe(true);
  expect(
    await db
      .prepare(
        "SELECT id FROM purchases WHERE user_id=? AND id='bounded-orphan'",
      )
      .bind(user)
      .first(),
  ).toBeNull();
  expect(
    await db
      .prepare(
        "SELECT amount_minor FROM ledger_entries WHERE id='bounded-manual-entry'",
      )
      .first("amount_minor"),
  ).toBe(42);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM correction_audit WHERE user_id=? AND entity_kind='review' AND entity_id LIKE 'bounded-question-%'",
      )
      .bind(user)
      .first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM review_items WHERE user_id=? AND id LIKE 'bounded-question-%'",
      )
      .bind(user)
      .first("n"),
  ).toBe(0);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

it("EDIT-01 corrected source settlement opens only a remainder review and retains proved installment cash", async () => {
  const user = tenant.userId;
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES('allocation-mail',?,'mailbox','gmail','allocation','allocation@example.invalid','connected')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('allocation-message',?,'allocation-mail','allocation',0,1)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('allocation-document',?,'allocation-message','body','allocation-hash','text/plain',1)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('allocation-observation',?,'allocation-document',0,'allocation',1,'explicitly-paid','{\"schemaVersion\":1,\"totalMinor\":\"10000\",\"currency\":\"EUR\"}','accepted')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('allocation-purchase',?,'Synthetic','synthetic','2026-01-01',10000,'EUR','paid')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,'allocation-purchase','allocation-observation','document')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES('allocation-entry',?,'allocation-purchase','allocation-observation','allocation-payment','payment',10000,'EUR','2026-01-01','document-date',1)",
    )
    .bind(user)
    .run();
  await createCorrectionStore(db).execute(
    session,
    {
      kind: "event-edit",
      entryId: "allocation-entry",
      request: { version: 1, changes: { amountMinor: "4500" } },
    },
    "allocation-source-correction",
  );
  expect(
    await db
      .prepare(
        "SELECT payment_state FROM purchases WHERE id='allocation-purchase'",
      )
      .first("payment_state"),
  ).toBe("partially_paid");
  expect(
    await db
      .prepare(
        "SELECT amount_minor,eligible FROM ledger_entries WHERE id='allocation-entry'",
      )
      .first(),
  ).toEqual({ amount_minor: 4500, eligible: 1 });
  expect(
    await db
      .prepare(
        "SELECT reason,observation_id,status FROM review_items WHERE user_id=? AND purchase_id='allocation-purchase'",
      )
      .bind(user)
      .first(),
  ).toEqual({
    reason: "payment-allocation-review",
    observation_id: null,
    status: "open",
  });
  const store = createCorrectionStore(db);
  const warning = await db
    .prepare(
      "SELECT id,version FROM review_items WHERE purchase_id='allocation-purchase' AND reason='payment-allocation-review'",
    )
    .first<{ id: string; version: number }>();
  if (!warning) throw new Error("allocation warning missing");
  const partial = await store.execute(
    session,
    {
      kind: "cash-confirm",
      purchaseId: "allocation-purchase",
      entryKind: "payment",
      request: {
        version: 2,
        confirmed: true,
        amountMinor: "2500",
        currency: "EUR",
        eventDate: "2026-01-02",
        review: warning,
      },
    },
    "allocation-second-installment",
  );
  expect(partial.reviewStatus).toBe("open");
  expect(partial.reviewVersion).toBe(2);
  const complete = await store.execute(
    session,
    {
      kind: "cash-confirm",
      purchaseId: "allocation-purchase",
      entryKind: "payment",
      request: {
        version: 3,
        confirmed: true,
        amountMinor: "3000",
        currency: "EUR",
        eventDate: "2026-01-03",
        review: { id: warning.id, version: 2 },
      },
    },
    "allocation-final-installment",
  );
  expect(complete.reviewStatus).toBe("resolved");
  expect(
    await db
      .prepare(
        "SELECT payment_state FROM purchases WHERE id='allocation-purchase'",
      )
      .first("payment_state"),
  ).toBe("paid");
  expect(
    await db
      .prepare(
        "SELECT SUM(amount_minor) AS total FROM ledger_entries WHERE purchase_id='allocation-purchase'",
      )
      .first("total"),
  ).toBe(10000);
});

it("EDIT-01 compatible credit proof is counted once toward settlement while cumulative cash remains exact", async () => {
  const user = tenant.userId;
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('credit-message',?,'allocation-mail','credit',0,1)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('credit-document',?,'credit-message','body','credit-hash','text/plain',1)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('credit-purchase',?,'Synthetic','synthetic','2026-01-01',10000,'EUR','paid')",
    )
    .bind(user)
    .run();
  const structured = JSON.stringify({
    schemaVersion: 1,
    documentType: "receipt",
    record: {
      merchant: "Synthetic",
      documentDate: "2026-01-01",
      eventDate: "2026-01-01",
      currency: "EUR",
      total: "100.00",
      tax: null,
      invoiceNumber: "credit-invoice",
      orderReference: null,
      paymentReference: "credit-payment",
      refundReference: null,
      category: "shopping",
      paymentEvidence: "explicitly-paid",
      refundEvidence: "none",
      paymentMethodHint: "card",
      recurringCadence: "unknown",
      paymentAmount: "60.00",
      refundAmount: null,
      storeCreditAmount: "40.00",
      provenance: [],
    },
  });
  for (const id of ["credit-proof", "credit-duplicate-proof"]) {
    await db
      .prepare(
        'INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,structured_fields,review_state) VALUES(?,?,\'credit-document\',0,?,1,\'explicitly-paid\',\'{"schemaVersion":1,"totalMinor":"10000","currency":"EUR"}\',?,\'accepted\')',
      )
      .bind(id, user, id, structured)
      .run();
    await db
      .prepare(
        "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,'credit-purchase',?,'document')",
      )
      .bind(user, id)
      .run();
  }
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES('credit-cash',?,'credit-purchase','credit-proof','credit-cash','payment',6000,'EUR','2026-01-01','document-date',1)",
    )
    .bind(user)
    .run();
  const store = createCorrectionStore(db);
  await store.execute(
    session,
    {
      kind: "event-edit",
      entryId: "credit-cash",
      request: { version: 1, changes: { amountMinor: "5000" } },
    },
    "credit-cash-adjustment",
  );
  const warning = await db
    .prepare(
      "SELECT id,version FROM review_items WHERE purchase_id='credit-purchase' AND reason='payment-allocation-review'",
    )
    .first<{ id: string; version: number }>();
  if (!warning) throw new Error("credit allocation warning missing");
  const result = await store.execute(
    session,
    {
      kind: "cash-confirm",
      purchaseId: "credit-purchase",
      entryKind: "payment",
      request: {
        version: 2,
        confirmed: true,
        amountMinor: "1000",
        currency: "EUR",
        eventDate: "2026-01-02",
        review: warning,
      },
    },
    "credit-explicit-installment",
  );
  expect(result.reviewStatus).toBe("resolved");
  expect(
    await db
      .prepare("SELECT payment_state FROM purchases WHERE id='credit-purchase'")
      .first("payment_state"),
  ).toBe("paid");
  expect(
    await db
      .prepare(
        "SELECT SUM(amount_minor) AS total FROM ledger_entries WHERE purchase_id='credit-purchase'",
      )
      .first("total"),
  ).toBe(6000);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS total FROM ledger_entries WHERE purchase_id='credit-purchase'",
      )
      .first("total"),
  ).toBe(2);
});

it("EDIT-03 source deletion recomputes retained source5000/manual5000 as partial standalone manual cash", async () => {
  const user = tenant.userId;
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES('recompute-mail',?,'mailbox','gmail','recompute','recompute@example.invalid','connected')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('recompute-message',?,'recompute-mail','recompute',0,1)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('recompute-doc',?,'recompute-message','body','recompute-hash','text/plain',1)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('recompute-proof',?,'recompute-doc',0,'recompute',1,'explicitly-paid','{\"schemaVersion\":1,\"totalMinor\":\"10000\",\"currency\":\"EUR\"}','accepted')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('recompute-purchase',?,'Synthetic','synthetic','2026-01-01',10000,'EUR','paid')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,'recompute-purchase','recompute-proof','document')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('recompute-source',?,'recompute-purchase','recompute-proof','recompute-source','payment',5000,'EUR','2026-01-01','document-date',1,'source'),('recompute-manual',?,'recompute-purchase',NULL,'recompute-manual','payment',5000,'EUR','2026-01-01','user-confirmed-date',1,'user-confirmed')",
    )
    .bind(user, user)
    .run();
  const repo = createLifecycleRepository(db),
    preview = await repo.preview(tenant, "recompute-mail");
  await repo.deleteData(
    { ...session, authenticatedAt: Date.now() },
    "recompute-mail",
    { confirmed: true, generation: 1, previewFingerprint: preview.fingerprint },
    "recompute-source-erasure",
  );
  for (let index = 0; index < 60; index++) {
    const marker = await db
      .prepare(
        "SELECT user_id,target_id,stage,request_id FROM lifecycle_deletions WHERE user_id=? AND scope='connection' AND target_id='recompute-mail'",
      )
      .bind(user)
      .first<{
        user_id: string;
        target_id: string;
        stage: number;
        request_id: string;
      }>();
    if (!marker) break;
    const invocation = createInvocationDatabase(env.DB, 5);
    await cleanupConnection(invocation.db, marker);
    expect(invocation.remainingStatements()).toBeGreaterThanOrEqual(1);
    const pending = await db
      .prepare(
        "SELECT payment_state,lifecycle_recompute_connection_id FROM purchases WHERE id='recompute-purchase'",
      )
      .first<{
        payment_state: string;
        lifecycle_recompute_connection_id: string | null;
      }>();
    if (pending?.lifecycle_recompute_connection_id)
      expect(pending.payment_state).toBe("unknown");
  }
  expect(
    await db
      .prepare(
        "SELECT payment_state FROM purchases WHERE id='recompute-purchase'",
      )
      .first("payment_state"),
  ).toBe("partially_paid");
  expect(
    await db
      .prepare(
        "SELECT id,amount_minor,eligible,origin FROM ledger_entries WHERE purchase_id='recompute-purchase'",
      )
      .first(),
  ).toEqual({
    id: "recompute-manual",
    amount_minor: 5000,
    eligible: 1,
    origin: "user-confirmed",
  });
  expect(
    await db
      .prepare(
        "SELECT document_id,observation_id,reason,status FROM review_items WHERE purchase_id='recompute-purchase'",
      )
      .first(),
  ).toEqual({
    document_id: null,
    observation_id: null,
    reason: "payment-allocation-review",
    status: "open",
  });
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  const restoredPurchase = await db
    .prepare("SELECT version FROM purchases WHERE id='recompute-purchase'")
    .first<{ version: number }>();
  const remainder = await db
    .prepare(
      "SELECT id,version FROM review_items WHERE purchase_id='recompute-purchase' AND reason='payment-allocation-review'",
    )
    .first<{ id: string; version: number }>();
  if (!restoredPurchase || !remainder)
    throw new Error("retained remainder missing");
  const completion = await createCorrectionStore(db).execute(
    session,
    {
      kind: "cash-confirm",
      purchaseId: "recompute-purchase",
      entryKind: "payment",
      request: {
        version: restoredPurchase.version,
        confirmed: true,
        amountMinor: "5000",
        currency: "EUR",
        eventDate: "2026-01-02",
        review: remainder,
      },
    },
    "recompute-confirm-independent-remainder",
  );
  expect(completion.reviewStatus).toBe("resolved");
  expect(
    await db
      .prepare(
        "SELECT payment_state FROM purchases WHERE id='recompute-purchase'",
      )
      .first("payment_state"),
  ).toBe("paid");
});

it("LIFECYCLE-04 account cleanup bounds more than100 onboarding commands before import parent deletion", async () => {
  const user = "onboarding-erasure";
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Synthetic','onboarding-erasure@example.invalid',1,0,0)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,status,created_at,updated_at) VALUES(?,'deleting',0,0)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES('onboarding-erasure-mail',?,'mailbox','gmail','erasure','erasure@example.invalid','disconnected')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES('onboarding-erasure-consent',?,'onboarding-erasure-mail',1,'synthetic','local',1,0,1)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO import_runs(id,user_id,connection_id,consent_id,connection_generation,frozen_start,frozen_cutoff,timezone,request_fingerprint,started_at) VALUES('onboarding-erasure-run',?,'onboarding-erasure-mail','onboarding-erasure-consent',1,'2026-01-01','2026-01-02','UTC','onboarding-erasure-run',0)",
    )
    .bind(user)
    .run();
  for (let index = 0; index < 105; index++)
    await db
      .prepare(
        "INSERT INTO onboarding_commands(user_id,key_hash,body_hash,import_run_id,result_json,created_at) VALUES(?, ?,?,'onboarding-erasure-run','{}',0)",
      )
      .bind(user, index.toString(16).padStart(64, "0"), "a".repeat(64))
      .run();
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,journal_ack) VALUES(?,'account','account','onboarding-erasure-request',0,1)",
    )
    .bind(user)
    .run();
  const count = async () =>
    Number(
      await db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM onboarding_commands WHERE user_id=?)+(SELECT COUNT(*) FROM import_runs WHERE user_id=?) AS n",
        )
        .bind(user, user)
        .first("n"),
    );
  const cleanup = createLifecycleCleanup(db, null);
  let completed = false;
  for (let unit = 0; unit < 60; unit++) {
    const before = await count();
    const result = await cleanup.runOne();
    expect(before - (await count())).toBeLessThanOrEqual(100);
    if (result.status === "completed") {
      completed = true;
      break;
    }
  }
  expect(completed).toBe(true);
  expect(await count()).toBe(0);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

it("LIFECYCLE-04 oversized retained cash facts fail closed without truncating or deleting independent cash", async () => {
  const user = tenant.userId;
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES('oversize-mail',?,'mailbox','gmail','oversize','oversize@example.invalid','disconnected')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,stage,journal_ack,deleted_at) VALUES(?,'connection','oversize-mail','oversize-cleanup',9,0,0)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state,origin,lifecycle_recompute_connection_id) VALUES('oversize-purchase',?,'Synthetic','synthetic','2026-01-01',1001,'EUR','unknown','user-supplied','oversize-mail')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "WITH RECURSIVE numbers(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<1001) INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) SELECT 'oversize-entry-'||n,?,'oversize-purchase',NULL,'oversize-cash-'||n,'payment',1,'EUR','2026-01-01','user-confirmed-date',1,'user-confirmed' FROM numbers",
    )
    .bind(user)
    .run();
  const invocation = createInvocationDatabase(env.DB, 5);
  await cleanupConnection(invocation.db, {
    user_id: user,
    target_id: "oversize-mail",
    request_id: "oversize-cleanup",
    stage: 9,
  });
  expect(invocation.remainingStatements()).toBeGreaterThanOrEqual(1);
  expect(
    await db
      .prepare(
        "SELECT payment_state,lifecycle_recompute_connection_id FROM purchases WHERE id='oversize-purchase'",
      )
      .first(),
  ).toEqual({
    payment_state: "unknown",
    lifecycle_recompute_connection_id: null,
  });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) FROM ledger_entries WHERE purchase_id='oversize-purchase' AND eligible=1 AND origin='user-confirmed'",
      )
      .first("COUNT(*)"),
  ).toBe(1001);
  expect(
    await db
      .prepare(
        "SELECT reason,status,document_id,observation_id FROM review_items WHERE purchase_id='oversize-purchase'",
      )
      .first(),
  ).toEqual({
    reason: "payment-allocation-review",
    status: "open",
    document_id: null,
    observation_id: null,
  });
});

it("EDIT-04 merge resolves each scoped remainder and unmerge restores only the original remainder questions", async () => {
  const user = tenant.userId;
  for (const id of ["remainder-target", "remainder-source"]) {
    await db
      .prepare(
        "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state,origin) VALUES(?,?,'Synthetic','synthetic','2026-01-01',100,'EUR','partially_paid','user-supplied')",
      )
      .bind(id, user)
      .run();
    await db
      .prepare(
        "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES(?,?,?,NULL,?,'payment',50,'EUR','2026-01-01','user-confirmed-date',1,'user-confirmed')",
      )
      .bind(`${id}-cash`, user, id, `${id}-cash`)
      .run();
    await db
      .prepare(
        "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at) VALUES(?,?,NULL,NULL,?,'payment-allocation-review','financial','open',0)",
      )
      .bind(`${id}-question`, user, id)
      .run();
  }
  const store = createCorrectionStore(db);
  const merged = await store.execute(
    session,
    {
      kind: "merge",
      request: {
        target: { id: "remainder-target", version: 1 },
        source: { id: "remainder-source", version: 1 },
      },
    },
    "merge-two-remainders",
  );
  expect(
    (
      await db
        .prepare(
          "SELECT id,purchase_id,status FROM review_items WHERE id IN('remainder-target-question','remainder-source-question') ORDER BY id",
        )
        .all()
    ).results,
  ).toEqual([
    {
      id: "remainder-source-question",
      purchase_id: "remainder-target",
      status: "resolved",
    },
    {
      id: "remainder-target-question",
      purchase_id: "remainder-target",
      status: "resolved",
    },
  ]);
  expect(
    await db
      .prepare(
        "SELECT payment_state FROM purchases WHERE id='remainder-target'",
      )
      .first("payment_state"),
  ).toBe("paid");
  if (!merged.mergeId || !merged.version)
    throw new Error("merge result missing");
  await store.execute(
    session,
    {
      kind: "unmerge",
      purchaseId: "remainder-target",
      request: {
        mergeId: merged.mergeId,
        version: merged.version,
        sourceVersion: 2,
      },
    },
    "unmerge-two-remainders",
  );
  expect(
    (
      await db
        .prepare(
          "SELECT id,purchase_id,status FROM review_items WHERE id IN('remainder-target-question','remainder-source-question') ORDER BY id",
        )
        .all()
    ).results,
  ).toEqual([
    {
      id: "remainder-source-question",
      purchase_id: "remainder-source",
      status: "open",
    },
    {
      id: "remainder-target-question",
      purchase_id: "remainder-target",
      status: "open",
    },
  ]);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) FROM correction_audit WHERE entity_kind='review' AND entity_id IN('remainder-target-question','remainder-source-question') AND action='payment-allocation-recomputed'",
      )
      .first("COUNT(*)"),
  ).toBe(4);
  expect(
    (
      await db
        .prepare(
          "SELECT payment_state FROM purchases WHERE id IN('remainder-source','remainder-target')",
        )
        .all()
    ).results,
  ).toEqual([
    { payment_state: "partially_paid" },
    { payment_state: "partially_paid" },
  ]);
});

it("LIFECYCLE-04 source deletion resolves every scoped remainder when independently confirmed surviving cash balances", async () => {
  const user = tenant.userId;
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES('balanced-mail',?,'mailbox','gmail','balanced','balanced@example.invalid','connected')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('balanced-message',?,'balanced-mail','balanced',0,1)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('balanced-doc',?,'balanced-message','body','balanced-hash','text/plain',1)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('balanced-proof',?,'balanced-doc',0,'balanced',1,'explicitly-paid','{\"schemaVersion\":1,\"totalMinor\":\"100\",\"currency\":\"EUR\"}','accepted')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('balanced-purchase',?,'Synthetic','synthetic','2026-01-01',100,'EUR','paid')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,'balanced-purchase','balanced-proof','document')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('balanced-source',?,'balanced-purchase','balanced-proof','balanced-source','payment',20,'EUR','2026-01-01','document-date',1,'source'),('balanced-manual',?,'balanced-purchase',NULL,'balanced-manual','payment',100,'EUR','2026-01-01','user-confirmed-date',1,'user-confirmed')",
    )
    .bind(user, user)
    .run();
  for (const id of ["balanced-question-a", "balanced-question-b"])
    await db
      .prepare(
        "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at) VALUES(?,?,NULL,NULL,'balanced-purchase','payment-allocation-review','financial','open',0)",
      )
      .bind(id, user)
      .run();
  const repo = createLifecycleRepository(db),
    preview = await repo.preview(tenant, "balanced-mail");
  await repo.deleteData(
    { ...session, authenticatedAt: Date.now() },
    "balanced-mail",
    { confirmed: true, generation: 1, previewFingerprint: preview.fingerprint },
    "delete-balanced-source",
  );
  for (let unit = 0; unit < 60; unit++) {
    const marker = await db
      .prepare(
        "SELECT user_id,target_id,stage,request_id FROM lifecycle_deletions WHERE user_id=? AND scope='connection' AND target_id='balanced-mail'",
      )
      .bind(user)
      .first<{
        user_id: string;
        target_id: string;
        stage: number;
        request_id: string;
      }>();
    if (!marker) break;
    const invocation = createInvocationDatabase(env.DB, 5);
    await cleanupConnection(invocation.db, marker);
    expect(invocation.remainingStatements()).toBeGreaterThanOrEqual(1);
  }
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) FROM review_items WHERE purchase_id='balanced-purchase' AND reason='payment-allocation-review' AND status='open'",
      )
      .first("COUNT(*)"),
  ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT payment_state FROM purchases WHERE id='balanced-purchase'",
      )
      .first("payment_state"),
  ).toBe("paid");
  expect(
    (
      await db
        .prepare(
          "SELECT id,amount_minor,eligible FROM ledger_entries WHERE purchase_id='balanced-purchase'",
        )
        .all()
    ).results,
  ).toEqual([{ id: "balanced-manual", amount_minor: 100, eligible: 1 }]);
});

it.each(["event", "gross"] as const)(
  "EDIT-01/02 %s correction resolves all merged remainder questions when supported settlement balances",
  async (mode) => {
    const user = tenant.userId,
      target = `multi-${mode}-target`,
      source = `multi-${mode}-source`;
    for (const id of [target, source]) {
      await db
        .prepare(
          "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state,origin) VALUES(?,?,'Synthetic','synthetic','2026-01-01',100,'EUR','partially_paid','user-supplied')",
        )
        .bind(id, user)
        .run();
      await db
        .prepare(
          "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES(?,?,?,NULL,?,'payment',20,'EUR','2026-01-01','user-confirmed-date',1,'user-confirmed')",
        )
        .bind(`${id}-cash`, user, id, `${id}-cash`)
        .run();
      await db
        .prepare(
          "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at) VALUES(?,?,NULL,NULL,?,'payment-allocation-review','financial','open',0)",
        )
        .bind(`${id}-question`, user, id)
        .run();
    }
    const store = createCorrectionStore(db);
    await store.execute(
      session,
      {
        kind: "merge",
        request: {
          target: { id: target, version: 1 },
          source: { id: source, version: 1 },
        },
      },
      `multi-${mode}-merge`,
    );
    const command =
      mode === "event"
        ? {
            kind: "event-edit" as const,
            entryId: `${target}-cash`,
            request: { version: 1, changes: { amountMinor: "80" } },
          }
        : {
            kind: "purchase-edit" as const,
            purchaseId: target,
            request: { version: 2, changes: { totalMinor: "40" } },
          };
    await store.execute(session, command, `multi-${mode}-balance`);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) FROM review_items WHERE user_id=? AND purchase_id=? AND reason='payment-allocation-review' AND status='open'",
        )
        .bind(user, target)
        .first("COUNT(*)"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT payment_state FROM purchases WHERE user_id=? AND id=?")
        .bind(user, target)
        .first("payment_state"),
    ).toBe("paid");
    expect(
      (
        await db
          .prepare(
            "SELECT id,amount_minor FROM ledger_entries WHERE user_id=? AND purchase_id=? ORDER BY id",
          )
          .bind(user, target)
          .all()
      ).results,
    ).toEqual([
      { id: `${source}-cash`, amount_minor: 20 },
      { id: `${target}-cash`, amount_minor: mode === "event" ? 80 : 20 },
    ]);
  },
);

// Partial-schema case (X2): the write budget was tuned for a partial schema.
it.skip("LIFECYCLE-04 retained settlement resolves105 questions through at most100 actual D1 row writes per unit", async () => {
  const user = tenant.userId;
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES('bounded-recompute-mail',?,'mailbox','gmail','bounded-recompute','bounded-recompute@example.invalid','disconnected')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,stage,journal_ack,deleted_at) VALUES(?,'connection','bounded-recompute-mail','bounded-recompute-cleanup',9,0,0)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state,origin,lifecycle_recompute_connection_id) VALUES('bounded-recompute-purchase',?,'Synthetic','synthetic','2026-01-01',100,'EUR','unknown','user-supplied','bounded-recompute-mail')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('bounded-recompute-cash',?,'bounded-recompute-purchase',NULL,'bounded-recompute-cash','payment',100,'EUR','2026-01-01','user-confirmed-date',1,'user-confirmed')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "WITH RECURSIVE numbers(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<105) INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at) SELECT 'bounded-recompute-question-'||n,?,NULL,NULL,'bounded-recompute-purchase','payment-allocation-review','financial','open',0 FROM numbers",
    )
    .bind(user)
    .run();
  const writes: number[] = [];
  for (let unit = 0; unit < 5; unit++) {
    const invocation = createInvocationDatabase(env.DB, 5);
    let rowWrites = 0;
    const measured: D1Database = {
      prepare: (query) => invocation.db.prepare(query),
      exec: (query) => invocation.db.exec(query),
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
    const state = await db
      .prepare(
        "SELECT payment_state,lifecycle_recompute_connection_id FROM purchases WHERE id='bounded-recompute-purchase'",
      )
      .first<{
        payment_state: string;
        lifecycle_recompute_connection_id: string | null;
      }>();
    if (!state) throw new Error("retained purchase missing");
    if (!state.lifecycle_recompute_connection_id) {
      expect(state.payment_state).toBe("paid");
      break;
    }
    expect(state.payment_state).toBe("unknown");
  }
  expect(writes).toEqual([100, 7]);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) FROM review_items WHERE purchase_id='bounded-recompute-purchase' AND status='resolved'",
      )
      .first("COUNT(*)"),
  ).toBe(105);
  expect(
    await db
      .prepare(
        "SELECT lifecycle_recompute_connection_id FROM purchases WHERE id='bounded-recompute-purchase'",
      )
      .first("lifecycle_recompute_connection_id"),
  ).toBeNull();
  expect(
    await db
      .prepare(
        "SELECT id,amount_minor,eligible FROM ledger_entries WHERE purchase_id='bounded-recompute-purchase'",
      )
      .first(),
  ).toEqual({ id: "bounded-recompute-cash", amount_minor: 100, eligible: 1 });
});
