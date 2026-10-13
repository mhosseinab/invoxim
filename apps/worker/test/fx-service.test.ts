import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { createFxReportingService } from "../../../packages/adapters/src/fx/service";
import { createInvocationDatabase } from "../src/invocation-database";

const context = {
  userId: "fx-service-owner",
  authority: "job",
} as TenantContext;
const policy = { source: "synthetic-reference", maxPriorAgeDays: 2 };
const input = {
  expectedProfileVersion: 1,
  reportingCurrency: "USD",
  fromDate: "2026-01-01",
  toDate: "2026-12-31",
  limit: 3,
};
beforeAll(async () => {
  for (const sql of baseline.split(";").filter((value) => value.trim()))
    await env.DB.prepare(sql).run();
  await env.DB.prepare(
    "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Synthetic','fx-service@example.invalid',1,0,0)",
  )
    .bind(context.userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO profiles(user_id,reporting_currency,created_at,updated_at) VALUES(?,'USD',0,0)",
  )
    .bind(context.userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('purchase',?,'Synthetic','synthetic','2026-01-01',1,'EUR','paid')",
  )
    .bind(context.userId)
    .run();
});
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM entry_valuations").run();
  await env.DB.prepare("DELETE FROM fx_rates").run();
  await env.DB.prepare("DELETE FROM ledger_entries").run();
  await env.DB.prepare(
    "UPDATE profiles SET status='active',version=1,reporting_currency='USD'",
  ).run();
});
async function event(
  id: string,
  kind = "payment",
  date = "2026-10-11",
  currency = "EUR",
  amount = 1,
) {
  await env.DB.prepare(
    "INSERT INTO ledger_entries(id,user_id,purchase_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES(?,?,'purchase',?,?,?,?,?,'user-confirmed-date',1,'user-confirmed')",
  )
    .bind(id, context.userId, id, kind, amount, currency, date)
    .run();
}
it("FX-01/03: application persists exact weekend snapshot and sums individually rounded entries", async () => {
  await event("a");
  await event("b");
  const requests: string[] = [];
  const meter = createInvocationDatabase(env.DB, 40);
  const service = createFxReportingService(meter.db, {
    policy,
    reader: {
      async lookup(request) {
        requests.push(request.requestedDate);
        return {
          ...request,
          source: policy.source,
          effectiveDate: "2026-10-09",
          rate: "0.5",
          version: "synthetic-v1",
          retrievedAt: 0,
        };
      },
    },
  });
  expect(await service.revaluePage(context, input)).toMatchObject({
    status: "current",
    processed: 2,
    nextCursor: null,
  });
  expect(await service.readPage(context, input)).toMatchObject({
    status: "current",
    pageSummary: { signedMinor: "2", convertedCount: 2 },
    pendingCount: 0,
  });
  expect(requests).toEqual(["2026-10-11"]);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

function service(
  reader: Parameters<typeof createFxReportingService>[1]["reader"] = null,
) {
  const meter = createInvocationDatabase(env.DB, 40);
  return {
    meter,
    service: createFxReportingService(meter.db, { policy, reader }),
  };
}
it("FX-02: missing conversion retains original units and excludes it from subtotal", async () => {
  await event("missing", "payment", "2026-10-11", "EUR", 120);
  const s = service();
  await s.service.revaluePage(context, input);
  const page = await s.service.readPage(context, input);
  expect(page).toMatchObject({
    status: "current",
    entries: [
      {
        entry: { amountMinor: "120", currency: "EUR" },
        result: { status: "unconverted", reason: "rate_missing" },
      },
    ],
    pageSummary: {
      signedMinor: "0",
      convertedCount: 0,
      unconverted: [{ reason: "rate_missing" }],
    },
    pendingCount: 0,
  });
});
it("FX-04: payment and refund select their own event dates and exact rates", async () => {
  await event("payment", "payment", "2026-01-12", "EUR", 100);
  await event("refund", "refund", "2026-02-12", "EUR", 100);
  const dates: string[] = [];
  const s = service({
    async lookup(request) {
      dates.push(request.requestedDate);
      return {
        ...request,
        source: policy.source,
        effectiveDate: request.requestedDate,
        rate: request.requestedDate.startsWith("2026-01") ? "2" : "3",
        version: "synthetic-v1",
        retrievedAt: 0,
      };
    },
  });
  await s.service.revaluePage(context, input);
  expect(dates).toEqual(["2026-01-12", "2026-02-12"]);
  const page = await s.service.readPage(context, input);
  expect(page).toMatchObject({
    status: "current",
    entries: [
      { result: { signedMinor: "200" } },
      { result: { signedMinor: "-300" } },
    ],
    pageSummary: { signedMinor: "-100" },
  });
  expect(
    await env.DB.prepare(
      "SELECT CAST(SUM(amount_minor) AS TEXT) AS amount FROM ledger_entries",
    ).first("amount"),
  ).toBe("200");
});
it("FX-05: a preference change during quote lookup fences writes and preserves originals", async () => {
  await event("race");
  const s = service({
    async lookup(request) {
      await env.DB.prepare(
        "UPDATE profiles SET version=2,reporting_currency='EUR'",
      ).run();
      return {
        ...request,
        source: policy.source,
        effectiveDate: request.requestedDate,
        rate: "2",
        version: "synthetic-v1",
        retrievedAt: 0,
      };
    },
  });
  expect(await s.service.revaluePage(context, input)).toEqual({
    status: "stale",
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM entry_valuations",
    ).first("total"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS total FROM fx_rates").first(
      "total",
    ),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT CAST(amount_minor AS TEXT) AS amount FROM ledger_entries",
    ).first("amount"),
  ).toBe("1");
  expect(await s.service.readPage(context, input)).toEqual({ status: "stale" });
});
it("FX-05: corrected entry versions require new valuation without overwriting history", async () => {
  await event("identity", "payment", "2026-10-11", "USD", 30);
  await service().service.revaluePage(context, input);
  await env.DB.prepare(
    "UPDATE ledger_entries SET version=2,amount_minor=40",
  ).run();
  expect(await service().service.readPage(context, input)).toMatchObject({
    status: "current",
    pendingCount: 1,
    pageSummary: { signedMinor: "0" },
  });
  await service().service.revaluePage(context, input);
  expect(await service().service.readPage(context, input)).toMatchObject({
    status: "current",
    pageSummary: { signedMinor: "40" },
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM entry_valuations",
    ).first("total"),
  ).toBe(2);
});
it("FX-01: replay uses persisted exact snapshot and never fetches a newer quote", async () => {
  await event("snapshot");
  let calls = 0;
  const s = service({
    async lookup(request) {
      calls++;
      return {
        ...request,
        source: policy.source,
        effectiveDate: request.requestedDate,
        rate: calls === 1 ? "0.5" : "50",
        version: `synthetic-v${calls}`,
        retrievedAt: 0,
      };
    },
  });
  await s.service.revaluePage(context, input);
  await s.service.revaluePage(context, input);
  expect(calls).toBe(1);
  expect(await s.service.readPage(context, input)).toMatchObject({
    status: "current",
    pageSummary: { signedMinor: "1" },
  });
});
it("FX-02: future and stale quotes remain unconverted rather than silently using identity", async () => {
  for (const [id, date] of [
    ["future", "2026-10-12"],
    ["stale", "2026-10-01"],
  ]) {
    if (!id || !date) throw new Error("missing fixture");
    await event(id);
    await service({
      async lookup(request) {
        return {
          ...request,
          source: policy.source,
          effectiveDate: date,
          rate: "1",
          version: "synthetic-v1",
          retrievedAt: 0,
        };
      },
    }).service.revaluePage(context, { ...input, limit: 1 });
    await env.DB.prepare("UPDATE ledger_entries SET eligible=0 WHERE id=?")
      .bind(id)
      .run();
  }
  expect(
    (
      await env.DB.prepare(
        "SELECT reason FROM entry_valuations ORDER BY entry_id",
      ).all<{ reason: string }>()
    ).results,
  ).toEqual([{ reason: "rate_future" }, { reason: "rate_stale" }]);
});
it("FX-05: bounded cursors bind tenant, filters, preference and policy", async () => {
  for (const id of ["a", "b", "c", "d"])
    await event(id, "payment", "2026-10-11", "USD");
  const first = await service().service.revaluePage(context, {
    ...input,
    limit: 2,
  });
  if (first.status !== "current" || !first.nextCursor)
    throw new Error("missing cursor");
  expect(first.processed).toBe(2);
  expect(
    await service().service.revaluePage(context, {
      ...input,
      limit: 2,
      cursor: first.nextCursor,
    }),
  ).toMatchObject({ status: "current", processed: 2, nextCursor: null });
  const page = await service().service.readPage(context, {
    ...input,
    limit: 2,
  });
  if (page.status !== "current" || !page.nextCursor)
    throw new Error("missing cursor");
  expect(page.entries.map((row) => row.entry.id)).toEqual(["a", "b"]);
  await expect(
    service().service.readPage(context, {
      ...input,
      limit: 2,
      toDate: "2026-11-30",
      cursor: page.nextCursor,
    }),
  ).rejects.toThrow("INVALID_FX_INPUT");
  await expect(
    service().service.readPage(
      { userId: "foreign", authority: "job" } as TenantContext,
      { ...input, limit: 2, cursor: page.nextCursor },
    ),
  ).rejects.toThrow("INVALID_FX_INPUT");
});
it("FX-03: page list, subtotal and export projection share exact per-entry signed values", async () => {
  for (const id of ["a", "b", "c"])
    await event(id, "payment", "2026-10-11", "EUR", 9000000000000);
  const s = service({
    async lookup(request) {
      return {
        ...request,
        source: policy.source,
        effectiveDate: request.requestedDate,
        rate: "1000000",
        version: "synthetic-large",
        retrievedAt: 0,
      };
    },
  });
  await s.service.revaluePage(context, input);
  const page = await s.service.readPage(context, input);
  expect(s.meter.executedStatements()).toBeLessThanOrEqual(40);
  if (page.status !== "current") throw new Error("missing page");
  const exportRows = page.entries.map((row) => ({
    id: row.entry.id,
    signedMinor:
      row.status === "valued" && row.result.status === "converted"
        ? row.result.signedMinor
        : null,
  }));
  expect(
    exportRows
      .reduce((total, row) => total + BigInt(row.signedMinor ?? "0"), 0n)
      .toString(),
  ).toBe(page.pageSummary.signedMinor);
  expect(page.pageSummary.signedMinor).toBe("27000000000000000000");
});
it("FX-05: rejects overlarge revaluation/page limits and malformed cursors before provider calls", async () => {
  await expect(
    service().service.revaluePage(context, { ...input, limit: 4 }),
  ).rejects.toThrow("INVALID_FX_INPUT");
  await expect(
    service().service.readPage(context, { ...input, limit: 21 }),
  ).rejects.toThrow("INVALID_FX_INPUT");
  await expect(
    service().service.readPage(context, { ...input, cursor: "invalid" }),
  ).rejects.toThrow("INVALID_FX_INPUT");
});

it("FX-01/04: worst-case three distinct quote calls and reporting share40 native statements", async () => {
  for (const [id, date] of [
    ["a", "2026-01-12"],
    ["b", "2026-02-12"],
    ["c", "2026-03-12"],
  ]) {
    if (!id || !date) throw new Error("missing fixture");
    await event(id, "payment", date);
  }
  let calls = 0;
  const s = service({
    async lookup(request) {
      calls++;
      return {
        ...request,
        source: policy.source,
        effectiveDate: request.requestedDate,
        rate: "1",
        version: "synthetic-v1",
        retrievedAt: 0,
      };
    },
  });
  await s.service.revaluePage(context, input);
  expect(await s.service.readPage(context, input)).toMatchObject({
    status: "current",
    pageSummary: { signedMinor: "3" },
  });
  expect(calls).toBe(3);
  expect(s.meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("FX-05: bounded Unicode entry IDs produce usable opaque continuation cursors", async () => {
  const longId = `a${"界".repeat(3000)}`;
  await event(longId, "payment", "2026-10-11", "USD");
  await event("z", "payment", "2026-10-11", "USD");
  const first = await service().service.readPage(context, {
    ...input,
    limit: 1,
  });
  if (first.status !== "current" || !first.nextCursor)
    throw new Error("missing cursor");
  expect(first.nextCursor.length).toBeGreaterThan(8192);
  const next = await service().service.readPage(context, {
    ...input,
    limit: 1,
    cursor: first.nextCursor,
  });
  expect(next).toMatchObject({
    status: "current",
    entries: [{ entry: { id: "z" } }],
    nextCursor: null,
  });
});
