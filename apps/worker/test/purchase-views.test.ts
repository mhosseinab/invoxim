// Explicit populated historical-upgrade fixture; old SQL is never an active deployment migration.

import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import { createPurchaseViewReader } from "../../../packages/adapters/src/purchase-views";
import { useCurrentSchema } from "./support/db";

const db = env.DB;

const tenant = { userId: "views-a", authority: "session" } as TenantContext;
beforeAll(async () => {
  await useCurrentSchema(db);
  for (const owner of ["views-a", "views-b"]) {
    await db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
      )
      .bind(owner, owner, `${owner}@example.invalid`)
      .run();
    await db
      .prepare(
        "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
      )
      .bind(owner)
      .run();
    for (const id of ["a", "b", "c"])
      await db
        .prepare(
          "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state,invoice_ref) VALUES(?,?, 'Synthetic','synthetic','2026-01-01',10000,'EUR','unpaid',?)",
        )
        .bind(id, owner, `invoice-${id}`)
        .run();
  }
  // Upgrade the populated two-owner records fixture before using the current reader.
  await useCurrentSchema(db);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
it("UI-03 bounded stable cursor preserves equal-date ties and excludes other tenants", async () => {
  const reader = createPurchaseViewReader(db);
  const first = await reader.list(tenant, { limit: 2 });
  expect(first.rows.map((r) => r.id)).toEqual(["a", "b"]);
  expect(first.nextCursor).not.toBeNull();
  if (!first.nextCursor) throw new Error("fixture cursor absent");
  const second = await reader.list(tenant, {
    limit: 2,
    cursor: first.nextCursor,
  });
  expect(second.rows.map((r) => r.id)).toEqual(["c"]);
  expect(second.nextCursor).toBeNull();
});
async function evidence(
  owner: string,
  purchase: string,
  observation: string,
  available = 1,
  documentType = "receipt",
  refundEvidence = "none",
) {
  await db
    .prepare(
      "INSERT OR IGNORE INTO connections(id,user_id,kind,provider,provider_subject,display_address) VALUES('mailbox',?,'mailbox','gmail',?,'synthetic@example.invalid')",
    )
    .bind(owner, owner)
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation,available) VALUES(?,?,'mailbox',?,0,1,?)",
    )
    .bind(observation, owner, observation, available)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES(?,?,?,'body','synthetic-hash','text/plain',10)",
    )
    .bind(observation, owner, observation)
    .run();
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state,structured_fields) VALUES(?,?,?,0,?,1,'explicitly-paid','{\"schemaVersion\":1}','accepted',?)",
    )
    .bind(
      observation,
      owner,
      observation,
      observation,
      JSON.stringify({
        schemaVersion: 1,
        documentType,
        record: {
          documentDate: "2026-01-01",
          eventDate: "2026-10-10",
          paymentEvidence: "explicitly-paid",
          refundEvidence,
        },
      }),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,?,?,'payment')",
    )
    .bind(owner, purchase, observation)
    .run();
}
async function event(
  owner: string,
  purchase: string,
  observation: string,
  id: string,
  kind: "payment" | "refund",
  minor: string,
  date: string,
  currency = "EUR",
  eligible = 1,
) {
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES(?,?,?,?,?,?,?, ?,?,'document-date',?)",
    )
    .bind(
      id,
      owner,
      purchase,
      observation,
      id,
      kind,
      minor,
      currency,
      date,
      eligible,
    )
    .run();
}
it("HOME-02/04 current refund period excludes old payment while lifecycle preserves it and source provenance", async () => {
  await evidence("views-a", "a", "paid-observation");
  await evidence("views-a", "a", "pending-refund", 1, "refund", "pending");
  await evidence("views-a", "a", "completed-refund", 1, "refund", "completed");
  await event(
    "views-a",
    "a",
    "paid-observation",
    "old-payment",
    "payment",
    "12000",
    "2026-01-01",
  );
  await event(
    "views-a",
    "a",
    "completed-refund",
    "current-refund",
    "refund",
    "3000",
    "2026-10-10",
  );
  await event(
    "views-a",
    "a",
    "pending-refund",
    "excluded-uncertain",
    "refund",
    "2000",
    "2026-10-10",
    "EUR",
    0,
  );
  const reader = createPurchaseViewReader(db),
    filters = { from: "2026-10-01", to: "2026-10-31" };
  const list = await reader.list(tenant, { ...filters, limit: 25 });
  expect(list.rows.map((r) => r.id)).toEqual(["a"]);
  expect(list.rows[0]?.period).toEqual([
    {
      currency: "EUR",
      paidMinor: "0",
      refundedMinor: "3000",
      netMinor: "-3000",
    },
  ]);
  expect(list.rows[0]?.lifecycle).toEqual([
    {
      currency: "EUR",
      paidMinor: "12000",
      refundedMinor: "3000",
      netMinor: "9000",
    },
  ]);
  expect(await reader.summary(tenant, filters)).toMatchObject({
    recordCount: 1,
    excludedEntryCount: 1,
    dateBasis: "event",
    totals: [
      {
        currency: "EUR",
        paidMinor: "0",
        refundedMinor: "3000",
        netMinor: "-3000",
      },
    ],
    conversion: "not_configured",
  });
  const detail = await reader.detail(tenant, "a", filters);
  expect(detail?.timeline).toHaveLength(3);
  expect(detail?.timeline[0]).toMatchObject({
    observationId: "paid-observation",
    date: "2026-01-01",
  });
  expect(
    detail?.timeline.find((r) => r.observationId === "pending-refund"),
  ).toMatchObject({ refundEvidence: "pending", events: [{ eligible: false }] });
  expect(
    detail?.timeline.find((r) => r.observationId === "completed-refund")
      ?.events,
  ).toMatchObject([{ kind: "refund", minor: "3000", date: "2026-10-10" }]);
});
it("UI-03 filters are shared by list, exact summary and bounded export; search wildcards remain literals", async () => {
  const reader = createPurchaseViewReader(db),
    filter = {
      q: "invoice-a",
      mailbox: "mailbox",
      currency: "EUR",
      paymentState: "unpaid" as const,
    };
  expect(
    (await reader.list(tenant, { ...filter, limit: 25 })).rows.map((r) => r.id),
  ).toEqual(["a"]);
  expect(
    (await reader.exportRows(tenant, filter)).rows.map((r) => r.id),
  ).toEqual(["a"]);
  expect(await reader.summary(tenant, filter)).toMatchObject({
    recordCount: 1,
    unpaidCount: 1,
    totals: [{ netMinor: "9000" }],
  });
  expect((await reader.list(tenant, { limit: 25, q: "%" })).rows).toEqual([]);
  expect(
    (await reader.list(tenant, { limit: 25, category: "software" })).rows,
  ).toEqual([]);
  const first = await reader.list(tenant, { limit: 1 });
  if (!first.nextCursor) throw new Error("cursor fixture");
  await expect(
    reader.list(tenant, { limit: 1, q: "changed", cursor: first.nextCursor }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    reader.list(tenant, { limit: 1, cursor: "invalid" }),
  ).rejects.toMatchObject({ code: "invalid_request" });
});
it("HOME-03/05/06 missing fields remain null, review does not hide existing valid money, unavailable originals preserve record", async () => {
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('unknown','views-a','Unknown','unknown','2026-10-01',NULL,NULL,'unknown')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,created_at) VALUES('review-a','views-a','pending-refund','pending-refund','a','ambiguous-event','financial',0)",
    )
    .run();
  await db
    .prepare(
      "UPDATE source_messages SET available=0 WHERE user_id='views-a' AND id='paid-observation'",
    )
    .run();
  const reader = createPurchaseViewReader(db);
  expect(
    (await reader.list(tenant, { limit: 25, q: "Unknown" })).rows[0],
  ).toMatchObject({
    documentTotalMinor: null,
    currency: null,
    lifecycle: [],
    period: [],
  });
  const detail = await reader.detail(tenant, "a");
  expect(detail?.purchase).toMatchObject({
    reviewReasons: ["ambiguous-event"],
    lifecycle: [{ netMinor: "9000" }],
  });
  expect(
    detail?.timeline.find((r) => r.observationId === "paid-observation")
      ?.source,
  ).toEqual({
    mailboxId: "mailbox",
    provider: "gmail",
    originalAvailable: false,
    reason: "source_deleted",
  });
  expect(
    (await reader.list(tenant, { limit: 25, reviewState: "open" })).rows.map(
      (r) => r.id,
    ),
  ).toEqual(["a"]);
  expect((await reader.summary(tenant)).missingCurrencyCount).toBe(1);
  const text = JSON.stringify(detail);
  expect(text).not.toMatch(
    /synthetic-hash|rawTranscript|quote|provider_message_id|credential/,
  );
});
it("tenant-scoped reads exclude another owner's observation, ledger, review, detail and inactive owner", async () => {
  const reader = createPurchaseViewReader(db);
  expect(
    (
      await reader.detail(
        { userId: "views-b", authority: "session" } as TenantContext,
        "a",
      )
    )?.timeline,
  ).toEqual([]);
  expect(
    await reader.summary({
      userId: "views-b",
      authority: "session",
    } as TenantContext),
  ).toMatchObject({ recordCount: 3, totals: [], reviewCount: 0 });
  expect(await reader.detail(tenant, "missing")).toBeNull();
  await db
    .prepare("UPDATE profiles SET status='deleting' WHERE user_id='views-b'")
    .run();
  expect(
    (
      await reader.list(
        { userId: "views-b", authority: "session" } as TenantContext,
        { limit: 25 },
      )
    ).rows,
  ).toEqual([]);
  expect(
    await reader.detail(
      { userId: "views-b", authority: "session" } as TenantContext,
      "a",
    ),
  ).toBeNull();
});
it("UI-01 exact summary exceeds JS safe integer and separates original currencies without fabricated FX", async () => {
  await evidence("views-a", "b", "large-observation");
  for (let start = 0; start < 1002; start += 100)
    await db.batch(
      Array.from({ length: Math.min(100, 1002 - start) }, (_, offset) =>
        db
          .prepare(
            "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES(?,'views-a','b','large-observation',?,'payment',9000000000000,'USD','2026-01-01','document-date',1)",
          )
          .bind(`large-${start + offset}`, `large-${start + offset}`),
      ),
    );
  expect(
    await createPurchaseViewReader(db).summary(tenant, { q: "invoice-b" }),
  ).toMatchObject({
    totals: [
      {
        currency: "USD",
        paidMinor: "9018000000000000",
        refundedMinor: "0",
        netMinor: "9018000000000000",
      },
    ],
    conversion: "not_configured",
  });
  await expect(
    createPurchaseViewReader(db).list(tenant, {
      limit: 25,
      q: "invoice-b",
    }),
  ).rejects.toMatchObject({ code: "read_limit" });
});
it("HOME-01 coverage counts purchases separately from imported source counts and preserves partial import", async () => {
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES('consent','views-a','mailbox',1,'synthetic','local',1,0,1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO import_runs(id,user_id,connection_id,consent_id,connection_generation,frozen_start,frozen_cutoff,timezone,request_fingerprint,started_at,stage,discovered_count,processed_count,pause_reason) VALUES('run','views-a','mailbox','consent',1,'2025-10-01','2026-10-01','UTC','fingerprint',0,'processing_pending',40,12,'budget')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES('paused','views-a','mailbox','consent',1,'source-extract','paused','paused_budget',0)",
    )
    .run();
  const result = await createPurchaseViewReader(db).coverage(tenant);
  expect(result.readyPurchaseCount).toBe(4);
  expect(result.openReviewCount).toBe(1);
  expect(result.connections[0]).toMatchObject({
    pausedJobs: 1,
    imports: [
      {
        stage: "processing_pending",
        discoveredSources: 40,
        processedSources: 12,
        completedAt: null,
        pauseReason: "budget",
      },
    ],
  });
});
it("T15 shared snapshot contains exact individual cash facts and quote-free owned evidence in two bounded reads", async () => {
  const reader = createPurchaseViewReader(db);
  const snapshot = await reader.exportSnapshot(tenant, {
    q: "invoice-a",
    from: "2026-10-01",
    to: "2026-10-31",
  });
  expect(snapshot.purchases.map((row) => row.id)).toEqual(["a"]);
  expect(
    snapshot.ledgerEntries.map((row) => ({
      id: row.id,
      minor: row.minor,
      eligible: row.eligible,
    })),
  ).toEqual([
    { id: "current-refund", minor: "3000", eligible: true },
    { id: "excluded-uncertain", minor: "2000", eligible: false },
    { id: "old-payment", minor: "12000", eligible: true },
  ]);
  expect(snapshot.sources).toHaveLength(3);
  expect(
    snapshot.sources.find(
      (source) => source.observationId === "paid-observation",
    ),
  ).toMatchObject({
    providerMessageId: "paid-observation",
    available: false,
    originalAvailable: false,
  });
  expect(
    snapshot.observations.find((row) => row.id === "pending-refund"),
  ).toMatchObject({ documentType: "refund", fields: { schemaVersion: 1 } });
  expect(JSON.stringify(snapshot)).not.toMatch(
    /credential|rawTranscript|quote|textParts/,
  );
  const other = await reader.exportSnapshot({
    userId: "views-b",
    authority: "session",
  } as TenantContext);
  expect(other).toEqual({
    overrides: [],
    purchases: [],
    ledgerEntries: [],
    sources: [],
    observations: [],
    summary: {
      totals: [],
      dateBasis: "event",
      recordCount: 0,
      unpaidCount: 0,
      unknownCount: 0,
      reviewCount: 0,
      missingCurrencyCount: 0,
      excludedEntryCount: 0,
      conversion: "not_configured",
    },
  });
  expect(snapshot.summary).toMatchObject({
    totals: [
      {
        currency: "EUR",
        paidMinor: "0",
        refundedMinor: "3000",
        netMinor: "-3000",
      },
    ],
    excludedEntryCount: 1,
  });
  const dense = await reader.exportSnapshot(tenant, { q: "invoice-b" });
  expect(dense.ledgerEntries).toHaveLength(1002);
  expect(dense.summary.totals).toEqual([
    {
      currency: "USD",
      paidMinor: "9018000000000000",
      refundedMinor: "0",
      netMinor: "9018000000000000",
    },
  ]);
});

it("HOME-05 read-only open review list retains linked and unlinked missing-field questions without partial values", async () => {
  const reader = createPurchaseViewReader(db);
  const result = await reader.reviews(tenant);
  expect(result.reviews).toEqual([
    {
      id: "review-a",
      sourceMessageId: "pending-refund",
      documentId: "pending-refund",
      purchaseId: "a",
      reason: "ambiguous-event",
      sourceContext: {
        mailboxAddress: "synthetic@example.invalid",
        receivedAt: 0,
        provider: "gmail",
        available: true,
      },
      missingFields: [],
    },
  ]);
  expect(result.hasMore).toBe(false);
});
it("HOME-05 unlinked incomplete questions are bounded, tenant-owned, typed and contain no guessed partial facts", async () => {
  await db
    .prepare(
      "INSERT INTO review_items(id,user_id,document_id,purchase_id,reason,blocking_scope,created_at,missing_fields_json) VALUES('unlinked-missing','views-a','pending-refund',NULL,'incomplete-financial-facts','financial',1,?)",
    )
    .bind(JSON.stringify(["currency"]))
    .run();
  const reader = createPurchaseViewReader(db);
  expect(await reader.reviews(tenant, 1)).toEqual({
    reviews: [
      {
        id: "unlinked-missing",
        sourceMessageId: "pending-refund",
        documentId: "pending-refund",
        purchaseId: null,
        reason: "incomplete-financial-facts",
        sourceContext: {
          mailboxAddress: "synthetic@example.invalid",
          receivedAt: 0,
          provider: "gmail",
          available: true,
        },
        missingFields: ["currency"],
      },
    ],
    hasMore: true,
  });
  expect(
    await reader.reviews({
      userId: "views-b",
      authority: "session",
    } as TenantContext),
  ).toEqual({ reviews: [], hasMore: false });
  const text = JSON.stringify(await reader.reviews(tenant));
  expect(text).not.toMatch(
    /merchant|totalMinor|evidenceQuote|normalized_fields|structured_fields|provider_message_id|providerMessageId|credential/,
  );
  await expect(reader.reviews(tenant, 51)).rejects.toMatchObject({
    code: "invalid_request",
  });
  await db
    .prepare(
      "UPDATE review_items SET status='resolved' WHERE user_id='views-a' AND id='unlinked-missing'",
    )
    .run();
  expect((await reader.reviews(tenant)).reviews.map((row) => row.id)).toEqual([
    "review-a",
  ]);
});

it("bounded export rejects over 2000 authoritative cash facts without partial totals", async () => {
  for (let start = 0; start < 999; start += 100)
    await db.batch(
      Array.from({ length: Math.min(100, 999 - start) }, (_, offset) =>
        db
          .prepare(
            "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES(?,'views-a','b','large-observation',?,'payment',1,'USD','2026-01-01','document-date',1)",
          )
          .bind(`overflow-${start + offset}`, `overflow-${start + offset}`),
      ),
    );
  await expect(
    createPurchaseViewReader(db).exportSnapshot(tenant, { q: "invoice-b" }),
  ).rejects.toMatchObject({ code: "read_limit" });
});

it("review identifies the original mailbox and received date without message contents", async () => {
  await evidence("views-a", "a", "source-context");
  await db
    .prepare(
      "INSERT INTO review_items(id,user_id,document_id,reason,status,blocking_scope,created_at) VALUES('context-review','views-a','source-context','extraction-review','open','financial',0)",
    )
    .run();
  const result = await createPurchaseViewReader(db).reviews(tenant);
  expect(
    result.reviews.find((review) => review.id === "context-review"),
  ).toMatchObject({
    sourceContext: {
      mailboxAddress: "synthetic@example.invalid",
      receivedAt: 0,
      provider: "gmail",
      available: true,
    },
  });
});
