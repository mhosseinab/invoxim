// Explicit populated historical-upgrade fixture; old SQL is never an active deployment migration.

import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import { createPurchaseViewReader } from "../../../packages/adapters/src/purchase-views";
import { useCurrentSchema } from "./support/db";

const db = env.DB;

beforeAll(async () => {
  await useCurrentSchema(db);
  for (const id of ["a", "b"]) {
    await db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
      )
      .bind(id, id, `${id}@example.invalid`)
      .run();
    await db
      .prepare(
        "INSERT INTO profiles(user_id,status,created_at,updated_at) VALUES(?,'active',0,0)",
      )
      .bind(id)
      .run();
  }
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address) VALUES('c-b','b','mailbox','gmail','b','b@example.invalid')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('s-b','b','c-b','message-b',0,1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('d-b','b','s-b','body','hash','text/plain',10)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('observation-owned-by-b','b','d-b',0,'v1',1,'explicitly-paid','{\"schemaVersion\":1}','accepted')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,currency,payment_state) VALUES('p-a','a','Synthetic','synthetic','2026-01-01','EUR','paid')",
    )
    .run();
});
it("DB-01: rejects cross-tenant purchase observation association at database boundary", async () => {
  await expect(
    db
      .prepare(
        "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES('a','p-a','observation-owned-by-b','payment')",
      )
      .run(),
  ).rejects.toThrow();
});

it("DB-03: populated forward upgrade preserves values, source defaults and indexed reads", async () => {
  const context = { userId: "a", authority: "session" } as TenantContext;
  const reader = createPurchaseViewReader(db);
  expect((await reader.detail(context, "p-a"))?.purchase.documentTotalMinor).toBeNull();
  expect((await reader.list(context, { limit: 50 })).rows.map((row) => row.id)).toEqual(["p-a"]);
  expect(
    await db
      .prepare(
        "SELECT scheduling_state FROM connections WHERE user_id='b' AND id='c-b'",
      )
      .first("scheduling_state"),
  ).toBe("awaiting_import");
  expect(
    await db
      .prepare(
        "SELECT parse_state FROM documents WHERE user_id='b' AND id='d-b'",
      )
      .first("parse_state"),
  ).toBe("discovered");
  const listPlan = (
    await db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM purchases WHERE user_id=? AND document_date<? ORDER BY document_date DESC,id LIMIT 50",
      )
      .bind("a", "2027-01-01")
      .all<{ detail: string }>()
  ).results;
  expect(listPlan.map((row) => row.detail).join(" ")).toContain(
    "purchases_tenant_date",
  );
  const totalPlan = (
    await db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id,kind,amount_minor FROM ledger_entries WHERE user_id=? AND currency=? AND eligible=1 AND id>? ORDER BY id LIMIT 500",
      )
      .bind("b", "EUR", "")
      .all<{ detail: string }>()
  ).results;
  expect(totalPlan.map((row) => row.detail).join(" ")).toContain(
    "ledger_tenant_currency_id",
  );
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
it("DB-02: unique source-part identity rejects a second document without discarding original", async () => {
  await expect(
    db
      .prepare(
        "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('duplicate','b','s-b','body','different-hash','text/plain',10)",
      )
      .run(),
  ).rejects.toThrow();
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM documents WHERE user_id='b' AND source_message_id='s-b' AND part_key='body'",
      )
      .first("count"),
  ).toBe(1);
});
it("DB-04: exact aggregate crosses JavaScript safe integers and negative refund net safely", async () => {
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,currency,payment_state) VALUES('p-b','b','Synthetic B','synthetic b','2026-01-01','EUR','paid')",
    )
    .run();
  for (let start = 0; start < 1002; start += 100) {
    const batch = Array.from(
      { length: Math.min(100, 1002 - start) },
      (_, index) => {
        const id = `large-${String(start + index).padStart(4, "0")}`;
        return db
          .prepare(
            "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES(?,'b','p-b','observation-owned-by-b',?,'payment',9000000000000,'EUR','2026-01-01','document',1)",
          )
          .bind(id, id);
      },
    );
    await db.batch(batch);
  }
  const context = { userId: "b", authority: "session" } as TenantContext;
  const reader = createPurchaseViewReader(db);
  const eurTotals = (await reader.summary(context, { currency: "EUR" })).totals;
  expect(eurTotals).toEqual([
    { currency: "EUR", paidMinor: "9018000000000000", refundedMinor: "0", netMinor: "9018000000000000" },
  ]);
  const aTotals = (
    await reader.summary(
      { userId: "a", authority: "session" } as TenantContext,
      { currency: "EUR" },
    )
  ).totals;
  expect(aTotals).toEqual([]);
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES('refund','b','p-b','observation-owned-by-b','refund','refund',1200,'USD','2026-01-01','document',1)",
    )
    .run();
  const allTotals = (await reader.summary(context)).totals;
  const usd = allTotals.find((t) => t.currency === "USD");
  expect(usd).toEqual({ currency: "USD", paidMinor: "0", refundedMinor: "1200", netMinor: "-1200" });
  await expect(
    db
      .prepare(
        "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES('over-bound','b','p-b','observation-owned-by-b','over-bound','payment',9000000000001,'EUR','2026-01-01','document',1)",
      )
      .run(),
  ).rejects.toThrow();
});
it("DB-01: observations reject absent schema version and unapproved retained payload", async () => {
  for (const fields of [
    "{}",
    '{"schemaVersion":1,"rawTranscript":"synthetic disallowed"}',
    '{"schemaVersion":"1"}',
  ]) {
    await expect(
      db
        .prepare(
          "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES(?,'b','d-b',1,?,1,'unknown',?,'needs_review')",
        )
        .bind(`invalid-${fields}`, `invalid-${fields}`, fields)
        .run(),
    ).rejects.toThrow();
  }
});
it("DB-04: unknown purchase preserves null total and currency without substitution", async () => {
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('unknown-a','a','Synthetic unknown','synthetic unknown','2026-02-01',NULL,NULL,'unknown')",
    )
    .run();
  const detail = await createPurchaseViewReader(db).detail(
    { userId: "a", authority: "session" } as TenantContext,
    "unknown-a",
  );
  expect(detail?.purchase).toMatchObject({
    documentTotalMinor: null,
    currency: null,
    paymentState: "unknown",
  });
});
