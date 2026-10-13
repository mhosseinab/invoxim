import { env } from "cloudflare:workers";
import type { FxRateQuote, PurchaseFilters } from "@invoxim/contracts";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import revision from "../../../packages/adapters/migrations/0005_reporting_revision.sql?raw";
import { createFxPeriodService } from "../../../packages/adapters/src/fx/period";
import { createFxPeriodSigning } from "../../../packages/adapters/src/fx/period-signing";
import { createFxPurchaseReportingReader } from "../../../packages/adapters/src/fx/purchase-reporting";
import { createFxValuationRepository } from "../../../packages/adapters/src/fx/repository";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;
const policy = { source: "synthetic-reference", maxPriorAgeDays: 2 };
const signing = createFxPeriodSigning(
  "synthetic-purchase-reporting-secret-123456",
);
const filters = { from: "2026-01-01", to: "2026-12-31" };
let context: TenantContext;
let fixture = 0;
async function run(sql: string, ...values: unknown[]) {
  return db
    .prepare(sql)
    .bind(...values)
    .run();
}
beforeAll(async () => {
  for (const sql of baseline.split(";").filter((value) => value.trim()))
    await run(sql);
  for (const sql of revision.match(
    /ALTER TABLE[\s\S]*?;|CREATE TRIGGER[\s\S]*?END;/g,
  ) ?? [])
    await run(sql);
});
beforeEach(async () => {
  context = {
    userId: `purchase-reporting-${++fixture}`,
    authority: "session",
  } as TenantContext;
  await run(
    "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Synthetic',?,1,0,0)",
    context.userId,
    `${context.userId}@example.invalid`,
  );
  await run(
    "INSERT INTO profiles(user_id,reporting_currency,timezone,created_at,updated_at) VALUES(?,'USD','UTC',0,0)",
    context.userId,
  );
  for (const id of [
    "alpha",
    "beta",
    "empty",
    "merged",
    "hidden",
    "unselected",
  ]) {
    await run(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,currency,payment_state) VALUES(?,?,?,'synthetic','2026-01-01','EUR','paid')",
      id,
      context.userId,
      `Synthetic ${id}`,
    );
  }
  await run(
    "UPDATE purchases SET record_status='merged' WHERE user_id=? AND id='merged'",
    context.userId,
  );
  await run(
    "UPDATE purchases SET lifecycle_delete_connection_id='synthetic-deletion' WHERE user_id=? AND id='hidden'",
    context.userId,
  );
  for (const [id, purchaseId, kind, date, eligible] of [
    ["paid-a", "alpha", "payment", "2026-01-11", 1],
    ["paid-b", "alpha", "payment", "2026-01-11", 1],
    ["refund", "alpha", "refund", "2026-02-02", 1],
    ["missing", "beta", "payment", "2026-01-11", 1],
    ["pending", "beta", "payment", "2026-01-11", 1],
    ["excluded", "alpha", "payment", "2026-01-11", 0],
    ["outside", "alpha", "payment", "2025-12-31", 1],
    ["merged-event", "merged", "payment", "2026-01-11", 1],
    ["hidden-event", "hidden", "payment", "2026-01-11", 1],
    ["unselected-event", "unselected", "payment", "2026-01-11", 1],
  ] as const) {
    await run(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES(?,?,?,?,?,1,'EUR',?,'user-confirmed-date',?,'user-confirmed')",
      id,
      context.userId,
      purchaseId,
      id,
      kind,
      date,
      eligible,
    );
  }
  const repository = createFxValuationRepository(db, {
    policy,
    clock: () => 1000,
  });
  for (const [id, requestedDate, effectiveDate, rate, expected] of [
    ["paid-a", "2026-01-11", "2026-01-09", "0.5", "1"],
    ["paid-b", "2026-01-11", "2026-01-09", "0.5", "1"],
    ["refund", "2026-02-02", "2026-02-02", "1.5", "-2"],
  ] as const) {
    const quote: FxRateQuote = {
      source: policy.source,
      fromCurrency: "EUR",
      toCurrency: "USD",
      requestedDate,
      effectiveDate,
      rate,
      retrievedAt: 1000,
      version: "synthetic-v1",
    };
    expect(
      await repository.put(context, {
        entryId: id,
        expectedProfileVersion: 1,
        expectedEntryVersion: 1,
        expectedValuationVersion: 0,
        reportingCurrency: "USD",
        quote,
      }),
    ).toMatchObject({ status: "stored", result: { signedMinor: expected } });
  }
  expect(
    await repository.put(context, {
      entryId: "missing",
      expectedProfileVersion: 1,
      expectedEntryVersion: 1,
      expectedValuationVersion: 0,
      reportingCurrency: "USD",
      quote: null,
    }),
  ).toMatchObject({
    status: "stored",
    result: { status: "unconverted", reason: "rate_missing" },
  });
});
function period(database = db, remainingStatements = () => 40) {
  return createFxPeriodService(database, {
    policy,
    signing,
    clock: () => 1000,
    remainingStatements,
  });
}
async function snapshot(selectedFilters: PurchaseFilters = filters) {
  let result = await period().read(context, {
    filters: selectedFilters,
    actorKey: "session-a",
  });
  while (result.status === "in_progress")
    result = await period().read(context, {
      filters: selectedFilters,
      actorKey: "session-a",
      stamp: result.stamp,
      continuation: result.continuation,
    });
  if (result.status !== "complete")
    throw new Error("SYNTHETIC_STAMP_NOT_CURRENT");
  const read = await period().beginRead(context, {
    filters: selectedFilters,
    actorKey: "session-a",
    stamp: result.stamp,
  });
  if (read.status !== "current") throw new Error("SYNTHETIC_READ_NOT_CURRENT");
  return { snapshot: read.snapshot, periodSummary: result.summary };
}
const selectedIds = ["alpha", "beta", "empty"];

it("FX-01/03/04 returns exact historical per-event rounding, explicit pending/missing coverage and zero-event purchases", async () => {
  const current = await snapshot();
  const result = await createFxPurchaseReportingReader(db, { policy }).read(
    context,
    current.snapshot,
    selectedIds,
  );
  expect(result.summary).toEqual({
    paidMinor: "2",
    refundedMinor: "2",
    netMinor: "0",
    convertedCount: "3",
    pendingCount: "1",
    unconvertedCount: "1",
    reasons: { rate_missing: "1" },
  });
  expect(result.purchases).toEqual([
    {
      purchaseId: "alpha",
      summary: {
        paidMinor: "2",
        refundedMinor: "2",
        netMinor: "0",
        convertedCount: "3",
        pendingCount: "0",
        unconvertedCount: "0",
        reasons: {},
      },
    },
    {
      purchaseId: "beta",
      summary: {
        paidMinor: "0",
        refundedMinor: "0",
        netMinor: "0",
        convertedCount: "0",
        pendingCount: "1",
        unconvertedCount: "1",
        reasons: { rate_missing: "1" },
      },
    },
    {
      purchaseId: "empty",
      summary: {
        paidMinor: "0",
        refundedMinor: "0",
        netMinor: "0",
        convertedCount: "0",
        pendingCount: "0",
        unconvertedCount: "0",
        reasons: {},
      },
    },
  ]);
  expect(result.entries.map((value) => value.entry.id)).toEqual([
    "missing",
    "paid-a",
    "paid-b",
    "pending",
    "refund",
  ]);
  expect(
    result.entries.find((value) => value.entry.id === "pending"),
  ).toMatchObject({
    purchaseId: "beta",
    entry: { amountMinor: "1", currency: "EUR", eventDate: "2026-01-11" },
    valuation: { status: "pending" },
  });
  expect(
    result.entries.find((value) => value.entry.id === "refund"),
  ).toMatchObject({
    entryVersion: 1,
    valuation: {
      status: "valued",
      result: {
        signedMinor: "-2",
        quote: {
          requestedDate: "2026-02-02",
          effectiveDate: "2026-02-02",
          rate: "1.5",
          source: policy.source,
        },
      },
    },
  });
});

it("FX-05 shares period selection, omitting merged/hidden/excluded/out-of-period and matching the complete selected period", async () => {
  const current = await snapshot({ ...filters, q: "Synthetic alpha" });
  const result = await createFxPurchaseReportingReader(db, { policy }).read(
    context,
    current.snapshot,
    [...selectedIds, "merged", "hidden", "unselected"],
  );
  expect(result.summary).toEqual(current.periodSummary);
  expect(result.entries.map((value) => value.entry.id)).toEqual([
    "paid-a",
    "paid-b",
    "refund",
  ]);
});

it("FX-05 uses trusted tenant context even with another tenant's internal snapshot and matching purchase IDs", async () => {
  const current = await snapshot();
  const result = await createFxPurchaseReportingReader(db, { policy }).read(
    { ...context, userId: "foreign-synthetic-tenant" },
    current.snapshot,
    selectedIds,
  );
  expect(result.entries).toEqual([]);
  expect(result.summary.convertedCount).toBe("0");
});

it("FX-05 admits exactly one bulk statement between root fences and preserves three remaining settlement statements", async () => {
  const current = await snapshot();
  const meter = createInvocationDatabase(db, 40);
  for (let prefix = 0; prefix < 34; prefix++)
    await meter.db.prepare("SELECT 1").first();
  const fence = period(meter.db, meter.remainingStatements);
  const begun = await fence.beginRead(context, {
    filters,
    actorKey: "session-a",
    stamp: current.snapshot.stamp,
  });
  if (begun.status !== "current") throw new Error("SYNTHETIC_READ_NOT_CURRENT");
  const result = await createFxPurchaseReportingReader(meter.db, {
    policy,
  }).read(context, begun.snapshot, selectedIds);
  expect(result.entries).toHaveLength(5);
  expect(await fence.assertCurrent(context, begun.snapshot)).toBe(true);
  expect(meter.executedStatements()).toBe(37);
  expect(meter.remainingStatements()).toBe(3);
});

it("FX-05 caller's final fence rejects an in-request financial change instead of publishing the bulk result", async () => {
  const current = await snapshot();
  const result = await createFxPurchaseReportingReader(db, { policy }).read(
    context,
    current.snapshot,
    selectedIds,
  );
  expect(result.summary.convertedCount).toBe("3");
  await run(
    "UPDATE ledger_entries SET amount_minor=2 WHERE user_id=? AND id='paid-a'",
    context.userId,
  );
  expect(await period().assertCurrent(context, current.snapshot)).toBe(false);
});

it("FX-03 treats mismatched original snapshots as pending rather than accepting stale converted amounts", async () => {
  await run(
    "UPDATE ledger_entries SET amount_minor=2 WHERE user_id=? AND id='paid-a'",
    context.userId,
  );
  const current = await snapshot();
  const result = await createFxPurchaseReportingReader(db, { policy }).read(
    context,
    current.snapshot,
    ["alpha"],
  );
  expect(result.summary).toMatchObject({
    paidMinor: "1",
    refundedMinor: "2",
    netMinor: "-1",
    convertedCount: "2",
    pendingCount: "1",
  });
});

it("FX-03 rejects corrupt stored monetary valuation rather than returning partial totals", async () => {
  const current = await snapshot();
  await run(
    "UPDATE entry_valuations SET signed_minor='2' WHERE user_id=? AND entry_id='paid-a'",
    context.userId,
  );
  await expect(
    createFxPurchaseReportingReader(db, { policy }).read(
      context,
      current.snapshot,
      selectedIds,
    ),
  ).rejects.toThrow("FX_REPORT_UNAVAILABLE");
});

async function dense(count: number) {
  await run("DELETE FROM ledger_entries WHERE user_id=?", context.userId);
  await run(
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO ledger_entries(id,user_id,purchase_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) SELECT printf('%05d',i),?,'alpha',printf('%05d',i),'payment',9000000000000,'USD','2026-01-01','user-confirmed-date',1,'user-confirmed' FROM n",
    count,
    context.userId,
  );
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([policy.source, 2, "fx-v1"])),
      ),
    ),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  await run(
    "INSERT INTO entry_valuations(user_id,entry_id,reporting_currency,profile_version,entry_version,calculation_version,policy_hash,policy_source,max_prior_age_days,original_kind,original_minor,original_currency,original_event_date,status,signed_minor,basis,reason,rate_id,version,updated_at) SELECT user_id,id,'USD',1,1,'fx-v1',?,'synthetic-reference',2,kind,amount_minor,currency,event_date,'converted',CAST(amount_minor AS TEXT),'identity',NULL,NULL,1,0 FROM ledger_entries WHERE user_id=?",
    hash,
    context.userId,
  );
}
it("FX-03 accepts exactly 2000 events and preserves totals beyond JavaScript safe integers", async () => {
  await dense(2000);
  const current = await snapshot();
  const result = await createFxPurchaseReportingReader(db, { policy }).read(
    context,
    current.snapshot,
    ["alpha"],
  );
  expect(result.entries).toHaveLength(2000);
  expect(result.summary).toMatchObject({
    paidMinor: "18000000000000000",
    refundedMinor: "0",
    netMinor: "18000000000000000",
    convertedCount: "2000",
  });
  expect(result.summary).toEqual(current.periodSummary);
});
it("FX-05 rejects the 2001st eligible period event before exposing truncated financial totals", async () => {
  await dense(2001);
  const current = await snapshot();
  await expect(
    createFxPurchaseReportingReader(db, { policy }).read(
      context,
      current.snapshot,
      ["alpha"],
    ),
  ).rejects.toThrow("FX_REPORT_READ_LIMIT");
});
it("FX-05 binds 500 selected IDs as one JSON value rather than exceeding native parameter limits", async () => {
  const current = await snapshot();
  const ids = [
    "alpha",
    ...Array.from({ length: 499 }, (_, index) => `synthetic-id-${index}`),
  ];
  const result = await createFxPurchaseReportingReader(db, { policy }).read(
    context,
    current.snapshot,
    ids,
  );
  expect(result.summary.convertedCount).toBe("3");
  expect(result.purchases).toHaveLength(500);
});
it("FX-05 rejects more than 500 selected IDs at the validated boundary", async () => {
  const current = await snapshot();
  await expect(
    createFxPurchaseReportingReader(db, { policy }).read(
      context,
      current.snapshot,
      Array.from({ length: 501 }, (_, index) => `synthetic-${index}`),
    ),
  ).rejects.toThrow("INVALID_FX_INPUT");
});
