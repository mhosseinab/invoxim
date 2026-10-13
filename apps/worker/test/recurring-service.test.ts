import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import recurringMigration from "../../../packages/adapters/migrations/0003_recurring_series.sql?raw";
import { createRecurringService } from "../../../packages/adapters/src/recurring/service";
import { createInvocationDatabase } from "../src/invocation-database";

const context = {
  userId: "recurring-owner",
  authority: "session",
} as TenantContext;
beforeAll(async () => {
  for (const source of [baseline, recurringMigration])
    for (const sql of source.split(";").filter((value) => value.trim()))
      await env.DB.prepare(sql).run();
  await env.DB.prepare(
    "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Synthetic','recurring@example.invalid',1,0,0)",
  )
    .bind(context.userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO profiles(user_id,reporting_currency,created_at,updated_at) VALUES(?,'EUR',0,0)",
  )
    .bind(context.userId)
    .run();
});
beforeEach(async () => {
  await env.DB.prepare("DROP TRIGGER IF EXISTS recurring_abort").run();
  await env.DB.prepare("DELETE FROM recurring_entries").run();
  await env.DB.prepare("DELETE FROM recurring_series").run();
  await env.DB.prepare("DELETE FROM ledger_entries").run();
  await env.DB.prepare("DELETE FROM purchases").run();
  await env.DB.prepare("UPDATE profiles SET status='active'").run();
  await env.DB.prepare(
    "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('purchase',?,'Synthetic','synthetic','2026-01-31',1000,'EUR','paid')",
  )
    .bind(context.userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO ledger_entries(id,user_id,purchase_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('payment',?,'purchase','payment','payment',1000,'EUR','2026-01-31','user-confirmed-date',1,'user-confirmed')",
  )
    .bind(context.userId)
    .run();
});
const input = {
  id: "series",
  identityKey: "synthetic-plan-confirmed-by-user",
  cadence: "monthly" as const,
  anchorDate: "2026-01-31",
  entries: [{ entryId: "payment", expectedVersion: 1 }],
};
function metered() {
  const meter = createInvocationDatabase(env.DB, 40);
  return {
    meter,
    service: createRecurringService(meter.db, { clock: () => 0 }),
  };
}
it("RECUR-01/05: explicit user membership and month-end terms persist without creating a charge", async () => {
  const meter = createInvocationDatabase(env.DB, 40);
  const service = createRecurringService(meter.db);
  expect(
    await service.createUserSeries(context, {
      id: "series",
      identityKey: "synthetic-plan-confirmed-by-user",
      cadence: "monthly",
      anchorDate: "2026-01-31",
      entries: [{ entryId: "payment", expectedVersion: 1 }],
    }),
  ).toMatchObject({ status: "stored", version: 1 });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM ledger_entries",
    ).first(),
  ).toEqual({ total: 1 });
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  expect(await service.read(context, "series")).toMatchObject({
    status: "current",
    series: {
      identity_kind: "user-confirmed",
      state: "suggestion",
      pricing_kind: "unknown",
    },
    projection: {
      status: "series",
      state: "suggested",
      scheduleBasis: "user-confirmed",
      forecast: {
        estimatedNextDate: "2026-02-28",
        monthlyMinor: "1000",
        annualMinor: "12000",
        certainty: "estimate",
      },
      lastPayment: {
        entryId: "payment",
        currency: "EUR",
        pricing: { kind: "unknown" },
      },
    },
  });
});
it("RECUR-05: confirm/pause/cancel/dismiss use CAS, survive reconstruction and never write spending", async () => {
  const s = metered();
  await s.service.createUserSeries(context, input);
  expect(
    await s.service.decide(context, "series", {
      expectedVersion: 1,
      state: "confirmed",
    }),
  ).toEqual({ status: "stored", version: 2 });
  expect(
    await s.service.decide(context, "series", {
      expectedVersion: 1,
      state: "dismissed",
    }),
  ).toEqual({ status: "conflict" });
  expect(
    await s.service.decide(context, "series", {
      expectedVersion: 2,
      state: "paused",
    }),
  ).toEqual({ status: "stored", version: 3 });
  expect(
    await createRecurringService(env.DB).read(context, "series"),
  ).toMatchObject({
    status: "current",
    series: { state: "paused", version: 3 },
    projection: { forecast: null },
  });
  expect(
    await s.service.decide(context, "series", {
      expectedVersion: 3,
      state: "canceled",
    }),
  ).toEqual({ status: "stored", version: 4 });
  expect(
    await s.service.decide(context, "series", {
      expectedVersion: 4,
      state: "dismissed",
    }),
  ).toEqual({ status: "stored", version: 5 });
  expect(
    await env.DB.prepare(
      "SELECT CAST(SUM(amount_minor) AS TEXT) AS total,COUNT(*) AS entries FROM ledger_entries",
    ).first(),
  ).toEqual({ total: "1000", entries: 1 });
  expect(s.meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("RECUR-05: changed facts invalidate estimates while preserving the user's selected membership", async () => {
  const s = metered();
  await s.service.createUserSeries(context, input);
  await s.service.decide(context, "series", {
    expectedVersion: 1,
    state: "confirmed",
  });
  await env.DB.prepare(
    "UPDATE ledger_entries SET amount_minor=1200,version=2 WHERE user_id=? AND id='payment'",
  )
    .bind(context.userId)
    .run();
  expect(await s.service.read(context, "series")).toMatchObject({
    status: "stale",
    reason: "evidence_changed",
    entryIds: ["payment"],
    series: { state: "confirmed", version: 2 },
  });
  expect(
    await s.service.decide(context, "series", {
      expectedVersion: 2,
      state: "confirmed",
    }),
  ).toEqual({ status: "conflict" });
  expect(
    await s.service.decide(context, "series", {
      expectedVersion: 2,
      state: "paused",
    }),
  ).toEqual({ status: "stored", version: 3 });
  expect(
    await env.DB.prepare(
      "SELECT entry_id,selected_entry_version FROM recurring_entries",
    ).first(),
  ).toEqual({ entry_id: "payment", selected_entry_version: 1 });
});
it("RECUR-02/03: automatic preview exposes missing stable identity rather than grouping merchants", async () => {
  const s = metered();
  expect(
    await s.service.previewAutomatic(context, { entries: input.entries }),
  ).toMatchObject({
    status: "insufficient",
    reason: "missing_service_identity",
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM recurring_series",
    ).first(),
  ).toEqual({ total: 0 });
});
it("RECUR-05: cross-tenant read/create/decisions cannot use another owner's payment or series", async () => {
  const s = metered();
  await s.service.createUserSeries(context, input);
  const other = {
    userId: "other-recurring-owner",
    authority: "session",
  } as TenantContext;
  expect(await s.service.read(other, "series")).toEqual({ status: "missing" });
  expect(await s.service.createUserSeries(other, input)).toEqual({
    status: "conflict",
  });
  expect(
    await s.service.decide(other, "series", {
      expectedVersion: 1,
      state: "canceled",
    }),
  ).toEqual({ status: "conflict" });
});
it("RECUR-05: duplicate creation preserves previous manual decisions and all original links", async () => {
  const s = metered();
  await s.service.createUserSeries(context, input);
  await s.service.decide(context, "series", {
    expectedVersion: 1,
    state: "dismissed",
  });
  expect(
    await s.service.createUserSeries(context, {
      ...input,
      identityKey: "new-user-choice",
    }),
  ).toEqual({ status: "conflict" });
  expect(await s.service.read(context, "series")).toMatchObject({
    status: "current",
    series: { identity_key: input.identityKey, state: "dismissed", version: 2 },
  });
});
it("RECUR-05: ineligible/refund/excluded purchases and installment allocations cannot become a series", async () => {
  const s = metered();
  await env.DB.prepare("UPDATE ledger_entries SET eligible=0").run();
  expect(await s.service.createUserSeries(context, input)).toEqual({
    status: "conflict",
  });
  await env.DB.prepare(
    "UPDATE ledger_entries SET eligible=1,kind='refund'",
  ).run();
  expect(await s.service.createUserSeries(context, input)).toEqual({
    status: "conflict",
  });
  await env.DB.prepare("UPDATE ledger_entries SET kind='payment'").run();
  await env.DB.prepare("UPDATE purchases SET record_status='excluded'").run();
  expect(await s.service.createUserSeries(context, input)).toEqual({
    status: "conflict",
  });
  await env.DB.prepare(
    "UPDATE purchases SET record_status='active',payment_state='partially_paid'",
  ).run();
  expect(await s.service.createUserSeries(context, input)).toEqual({
    status: "invalid_evidence",
    reason: "installment_or_multiple_payments",
  });
});
it("RECUR-05: D1 batch failure rolls back the series and evidence links together", async () => {
  const s = metered();
  await env.DB.prepare(
    "CREATE TRIGGER recurring_abort BEFORE INSERT ON recurring_entries BEGIN SELECT RAISE(ABORT,'synthetic-recurring-failure'); END",
  ).run();
  await expect(s.service.createUserSeries(context, input)).rejects.toThrow(
    "RECURRING_SERVICE_UNAVAILABLE",
  );
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM recurring_series",
    ).first(),
  ).toEqual({ total: 0 });
});
it("RECUR-01: impossible calendar input and duplicated selection fail validation before writes", async () => {
  const s = metered();
  await expect(
    s.service.createUserSeries(context, { ...input, anchorDate: "2026-02-30" }),
  ).rejects.toThrow("INVALID_RECURRING_INPUT");
  await expect(
    s.service.createUserSeries(context, {
      ...input,
      entries: [...input.entries, ...input.entries],
    }),
  ).rejects.toThrow("INVALID_RECURRING_INPUT");
  expect(s.meter.executedStatements()).toEqual(0);
});
it("RECUR-05: owner-deleted payment membership suppresses forecasts from incomplete history", async () => {
  await env.DB.prepare(
    "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('purchase-new',?,'Synthetic','synthetic','2026-02-28',1200,'EUR','paid')",
  )
    .bind(context.userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO ledger_entries(id,user_id,purchase_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('payment-new',?,'purchase-new','payment-new','payment',1200,'EUR','2026-02-28','user-confirmed-date',1,'user-confirmed')",
  )
    .bind(context.userId)
    .run();
  const s = metered();
  expect(
    await s.service.createUserSeries(context, {
      ...input,
      entries: [
        ...input.entries,
        { entryId: "payment-new", expectedVersion: 1 },
      ],
    }),
  ).toEqual({ status: "stored", version: 1 });
  await env.DB.prepare(
    "DELETE FROM ledger_entries WHERE user_id=? AND id='payment-new'",
  )
    .bind(context.userId)
    .run();
  expect(await s.service.read(context, "series")).toMatchObject({
    status: "stale",
    reason: "evidence_changed",
    entryIds: ["payment"],
  });
  expect(
    await s.service.decide(context, "series", {
      expectedVersion: 1,
      state: "confirmed",
    }),
  ).toEqual({ status: "conflict" });
});
