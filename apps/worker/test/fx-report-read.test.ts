import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import revision from "../../../packages/adapters/migrations/0005_reporting_revision.sql?raw";
import { createFxPeriodService } from "../../../packages/adapters/src/fx/period";
import { createFxPeriodSigning } from "../../../packages/adapters/src/fx/period-signing";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;
const signing = createFxPeriodSigning(
  "synthetic-report-read-signing-secret-1234567890",
);
const policy = { source: "synthetic-reference", maxPriorAgeDays: 2 };
const filters = { from: "2026-01-01", to: "2026-12-31" };
let context: TenantContext;
let issued: string;
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
function service(
  database = db,
  now = 1000,
  selectedPolicy = policy,
  remainingStatements = () => 40,
) {
  return createFxPeriodService(database, {
    policy: selectedPolicy,
    signing,
    clock: () => now,
    remainingStatements,
  });
}
beforeEach(async () => {
  context = {
    userId: `report-read-${++fixture}`,
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
  await run(
    "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,payment_state) VALUES('purchase',?,'Synthetic','synthetic','2026-01-01','paid')",
    context.userId,
  );
  await run(
    "INSERT INTO ledger_entries(id,user_id,purchase_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('event',?,'purchase','event','payment',1,'USD','2026-01-01','user-confirmed-date',1,'user-confirmed')",
    context.userId,
  );
  const result = await service().read(context, {
    filters,
    actorKey: "session-a",
  });
  if (result.status !== "complete")
    throw new Error("SYNTHETIC_STAMP_NOT_ISSUED");
  issued = result.stamp;
});
function input() {
  return { filters, actorKey: "session-a", stamp: issued };
}
function measured() {
  const meter = createInvocationDatabase(db, 40);
  const queries: string[] = [];
  const database: D1Database = {
    prepare(query) {
      queries.push(query);
      return meter.db.prepare(query);
    },
    batch: <T>(statements: D1PreparedStatement[]) =>
      meter.db.batch<T>(statements),
    withSession: (constraint) => meter.db.withSession(constraint),
    exec: (query) => meter.db.exec(query),
    dump: () => meter.db.dump(),
  };
  return {
    database,
    meter,
    queries,
    reader: service(database, 1000, policy, meter.remainingStatements),
  };
}

it("FX-05 validates an existing stamp and final fence with one profile read each, preserving three settlement statements", async () => {
  const { meter, queries, reader } = measured();
  for (let prefix = 0; prefix < 35; prefix++)
    await meter.db.prepare("SELECT 1").first();
  const result = await reader.beginRead(context, input());
  if (result.status !== "current")
    throw new Error("SYNTHETIC_REPORT_NOT_CURRENT");
  expect(result.snapshot).toMatchObject({
    stamp: issued,
    reportingCurrency: "USD",
    filters,
    actorKey: "session-a",
  });
  expect(queries).toHaveLength(1);
  expect(await reader.assertCurrent(context, result.snapshot)).toBe(true);
  expect(queries).toHaveLength(2);
  expect(queries.join(" ")).not.toMatch(
    /ledger_entries|entry_valuations|fx_rates/,
  );
  expect(queries.every((query) => query.includes("FROM profiles"))).toBe(true);
  expect(meter.remainingStatements()).toBe(3);
  for (let settlement = 0; settlement < 3; settlement++)
    await meter.db.prepare("SELECT 1").first();
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("FX-05 canonical empty filters validate against the issued stamp without reading financial pages", async () => {
  const { queries, reader } = measured();
  const result = await reader.beginRead(context, {
    ...input(),
    filters: { to: filters.to, q: "", from: filters.from },
  });
  expect(result.status).toBe("current");
  expect(queries).toHaveLength(1);
  expect(queries.join(" ")).not.toMatch(
    /ledger_entries|entry_valuations|fx_rates/,
  );
});

it("FX-05 refuses the final fence after a same-version ledger mutation and reports the old stamp stale", async () => {
  const reader = service();
  const result = await reader.beginRead(context, input());
  if (result.status !== "current")
    throw new Error("SYNTHETIC_REPORT_NOT_CURRENT");
  await run(
    "UPDATE ledger_entries SET amount_minor=2 WHERE user_id=? AND id='event'",
    context.userId,
  );
  expect(await reader.assertCurrent(context, result.snapshot)).toBe(false);
  expect(await reader.beginRead(context, input())).toEqual({ status: "stale" });
});

it.each([
  "UPDATE profiles SET timezone='Europe/Vienna' WHERE user_id=?",
  "UPDATE profiles SET reporting_currency='EUR',version=version+1 WHERE user_id=?",
  "UPDATE profiles SET status='deleting' WHERE user_id=?",
])(
  "FX-05 refuses changed or inactive profile at the final fence (%s)",
  async (sql) => {
    const reader = service();
    const result = await reader.beginRead(context, input());
    if (result.status !== "current")
      throw new Error("SYNTHETIC_REPORT_NOT_CURRENT");
    await run(sql, context.userId);
    expect(await reader.assertCurrent(context, result.snapshot)).toBe(false);
    expect(await reader.beginRead(context, input())).toEqual({
      status: "stale",
    });
  },
);

it.each([
  "tenant",
  "session",
  "filters",
  "signature",
  "policy",
  "expiry",
] as const)(
  "FX-05 rejects %s mismatches before any database read",
  async (mismatch) => {
    const { database, meter, queries } = measured();
    const reader = service(
      database,
      mismatch === "expiry" ? 901000 : 1000,
      mismatch === "policy" ? { ...policy, maxPriorAgeDays: 1 } : policy,
      meter.remainingStatements,
    );
    const requested = {
      ...input(),
      ...(mismatch === "session" ? { actorKey: "session-b" } : {}),
      ...(mismatch === "filters"
        ? { filters: { ...filters, from: "2026-02-01" } }
        : {}),
      ...(mismatch === "signature" ? { stamp: `${issued}.junk` } : {}),
    };
    await expect(
      reader.beginRead(
        mismatch === "tenant"
          ? { ...context, userId: "foreign-report-owner" }
          : context,
        requested,
      ),
    ).rejects.toThrow("INVALID_FX_INPUT");
    expect(meter.executedStatements()).toBeLessThanOrEqual(0);
    expect(queries).toEqual([]);
  },
);

it("FX-05 final fence rechecks the signature instead of trusting snapshot fields", async () => {
  const reader = service();
  const result = await reader.beginRead(context, input());
  if (result.status !== "current")
    throw new Error("SYNTHETIC_REPORT_NOT_CURRENT");
  await expect(
    reader.assertCurrent(context, {
      ...result.snapshot,
      stamp: `${issued}.junk`,
    }),
  ).rejects.toThrow("INVALID_FX_INPUT");
});

it("FX-05 final fence does not accept a changed snapshot reporting currency", async () => {
  const reader = service();
  const result = await reader.beginRead(context, input());
  if (result.status !== "current")
    throw new Error("SYNTHETIC_REPORT_NOT_CURRENT");
  await expect(
    reader.assertCurrent(context, {
      ...result.snapshot,
      reportingCurrency: "EUR",
    }),
  ).rejects.toThrow("INVALID_FX_INPUT");
});
