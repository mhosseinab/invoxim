// Explicit populated historical-upgrade fixture; old SQL is never an active deployment migration.

import { env } from "cloudflare:workers";
import { sumFxConversions, type TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { createFxValuationRepository } from "../../../packages/adapters/src/fx/repository";
import { createInvocationDatabase } from "../src/invocation-database";
import { useCurrentSchema } from "./support/db";
const db = env.DB;

const tenant = { userId: "fx-a", authority: "session" } as TenantContext;
const policy = { source: "synthetic-public-reference", maxPriorAgeDays: 2 };
beforeAll(async () => {
  await useCurrentSchema(db);
  for (const id of ["fx-a", "fx-b"]) {
    await db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
      )
      .bind(id, "Synthetic", `${id}@example.invalid`)
      .run();
    await db
      .prepare(
        "INSERT INTO profiles(user_id,reporting_currency,created_at,updated_at) VALUES(?,'USD',0,0)",
      )
      .bind(id)
      .run();
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address) VALUES('mail',?,'mailbox','gmail','synthetic','synthetic@example.invalid')",
      )
      .bind(id)
      .run();
    await db
      .prepare(
        "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('source',?,'mail','synthetic',0,1)",
      )
      .bind(id)
      .run();
    await db
      .prepare(
        "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('doc',?,'source','body','synthetic','text/plain',1)",
      )
      .bind(id)
      .run();
    await db
      .prepare(
        "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('obs',?,'doc',0,'synthetic',1,'explicitly-paid',?,'accepted')",
      )
      .bind(id, JSON.stringify({ schemaVersion: 1 }))
      .run();
    await db
      .prepare(
        "INSERT INTO ledger_entries(id,user_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES('entry',?,'obs','synthetic','payment',1,'EUR','2026-10-11','document-date',1)",
      )
      .bind(id)
      .run();
  }
  await useCurrentSchema(db);
});
beforeEach(async () => {
  await db.prepare("DELETE FROM entry_valuations").run();
  await db.prepare("DELETE FROM fx_rates").run();
  await db
    .prepare(
      "UPDATE profiles SET status='active',reporting_currency='USD',version=1",
    )
    .run();
  await db
    .prepare(
      "UPDATE ledger_entries SET kind='payment',amount_minor=1,currency='EUR',event_date='2026-10-11',eligible=1,version=1",
    )
    .run();
});
const write = {
  entryId: "entry",
  expectedProfileVersion: 1,
  expectedEntryVersion: 1,
  expectedValuationVersion: 0,
  reportingCurrency: "USD",
  quote: {
    fromCurrency: "EUR",
    toCurrency: "USD",
    requestedDate: "2026-10-11",
    effectiveDate: "2026-10-09",
    rate: "0.5",
    source: policy.source,
    version: "snapshot-v1",
    retrievedAt: 1000,
  },
};
it("FX-01/03: real owned ledger gets exact weekend per-entry valuation and shared immutable quote", async () => {
  const repository = createFxValuationRepository(db, {
    policy,
    clock: () => 2000,
  });
  const result = await repository.put(tenant, write);
  expect(result).toMatchObject({
    status: "stored",
    valuationVersion: 1,
    result: { status: "converted", signedMinor: "1", quote: write.quote },
  });
  expect(await repository.get(tenant, write)).toMatchObject({
    status: "valued",
    valuationVersion: 1,
    result: { signedMinor: "1" },
  });
});

it("FX-01: exact replay uses first stored retrieval timestamp and conflicting source version cannot overwrite", async () => {
  const repository = createFxValuationRepository(db, { policy });
  expect((await repository.put(tenant, write)).status).toBe("stored");
  const replay = await repository.put(tenant, {
    ...write,
    expectedValuationVersion: 1,
    quote: { ...write.quote, retrievedAt: 99999 },
  });
  expect(replay).toMatchObject({
    status: "stored",
    valuationVersion: 2,
    result: { quote: { retrievedAt: 1000, rate: "0.5" } },
  });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM fx_rates").first("count"),
  ).toBe(1);
  expect(
    await repository.put(tenant, {
      ...write,
      expectedValuationVersion: 2,
      quote: { ...write.quote, rate: "0.6" },
    }),
  ).toEqual({ status: "conflict" });
  expect(await repository.get(tenant, write)).toMatchObject({
    status: "valued",
    valuationVersion: 2,
    result: { signedMinor: "1", quote: { rate: "0.5" } },
  });
  expect(
    await repository.put(tenant, {
      ...write,
      expectedValuationVersion: 2,
      quote: { ...write.quote, rate: "2", version: "snapshot-v2" },
    }),
  ).toMatchObject({
    status: "stored",
    valuationVersion: 3,
    result: { signedMinor: "2" },
  });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM fx_rates").first("count"),
  ).toBe(2);
});
it("FX-02: explicit unconverted reason persists and requires CAS for later rate recovery", async () => {
  const repository = createFxValuationRepository(db, { policy });
  expect(await repository.put(tenant, { ...write, quote: null })).toMatchObject(
    {
      status: "stored",
      result: { status: "unconverted", reason: "rate_missing" },
    },
  );
  expect(await repository.get(tenant, write)).toMatchObject({
    status: "valued",
    result: { status: "unconverted", reason: "rate_missing" },
  });
  expect(await repository.put(tenant, write)).toEqual({ status: "conflict" });
  expect(
    await repository.put(tenant, { ...write, expectedValuationVersion: 1 }),
  ).toMatchObject({ status: "stored", result: { signedMinor: "1" } });
});
it.each([
  ["rate_future", { ...write.quote, effectiveDate: "2026-10-12" }],
  ["rate_stale", { ...write.quote, effectiveDate: "2026-10-08" }],
  ["source_mismatch", { ...write.quote, source: "wrong-public-source" }],
  ["quote_mismatch", { ...write.quote, toCurrency: "GBP" }],
  ["invalid_quote", { ...write.quote, rate: "0" }],
])(
  "FX-02: %s remains closed unconverted outcome without default conversion",
  async (reason, quote) => {
    const repository = createFxValuationRepository(db, { policy });
    expect(await repository.put(tenant, { ...write, quote })).toMatchObject({
      status: "stored",
      result: { status: "unconverted", reason },
    });
    expect(await repository.get(tenant, write)).toMatchObject({
      status: "valued",
      result: { status: "unconverted", reason },
    });
  },
);
it("FX-05: changed ledger/profile snapshots become pending and stale CAS has no quote write", async () => {
  const repository = createFxValuationRepository(db, { policy });
  expect((await repository.put(tenant, write)).status).toBe("stored");
  await db
    .prepare(
      "UPDATE ledger_entries SET amount_minor=2,version=2 WHERE user_id=?",
    )
    .bind(tenant.userId)
    .run();
  expect(await repository.get(tenant, write)).toEqual({ status: "pending" });
  expect(
    await repository.put(tenant, {
      ...write,
      quote: { ...write.quote, version: "not-stored" },
    }),
  ).toEqual({ status: "stale" });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM fx_rates").first("count"),
  ).toBe(1);
  await db
    .prepare(
      "UPDATE profiles SET version=2,reporting_currency='EUR' WHERE user_id=?",
    )
    .bind(tenant.userId)
    .run();
  expect(await repository.get(tenant, write)).toEqual({ status: "pending" });
  expect(
    await repository.get(tenant, {
      ...write,
      expectedProfileVersion: 2,
      reportingCurrency: "EUR",
    }),
  ).toEqual({ status: "pending" });
  expect(
    await repository.put(tenant, {
      ...write,
      expectedProfileVersion: 2,
      expectedEntryVersion: 2,
      reportingCurrency: "EUR",
      quote: null,
    }),
  ).toMatchObject({
    status: "stored",
    result: { basis: "identity", signedMinor: "2" },
  });
  expect(
    await db
      .prepare(
        "SELECT CAST(amount_minor AS TEXT) AS minor,currency,event_date,version FROM ledger_entries WHERE user_id=?",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual({
    minor: "2",
    currency: "EUR",
    event_date: "2026-10-11",
    version: 2,
  });
});
it("FX-01: native batch rollback leaves neither public snapshot nor signed valuation prefix", async () => {
  const failing = {
    prepare: (sql: string) => db.prepare(sql),
    batch: (statements: D1PreparedStatement[]) =>
      db.batch([
        ...statements,
        db.prepare(
          "INSERT INTO fx_rates(id,source,from_currency,to_currency,requested_date,effective_date,rate,retrieved_at,source_version) VALUES('invalid','synthetic','EUR','USD','2026-10-11','2026-10-09','1',0,'v1')",
        ),
      ]),
  } as unknown as D1Database;
  await expect(
    createFxValuationRepository(failing, { policy }).put(tenant, write),
  ).rejects.toThrow("FX_STORAGE_UNAVAILABLE");
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM fx_rates").first("count"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM entry_valuations")
      .first("count"),
  ).toBe(0);
});
it("FX-01/03/04: tenant ownership, DB composite FK, refund date and separate rounding stay exact", async () => {
  const guarded = createInvocationDatabase(env.DB, 40);
  const repository = createFxValuationRepository(guarded.db, { policy });
  expect(await repository.put(tenant, write)).toMatchObject({
    status: "stored",
    result: { signedMinor: "1" },
  });
  const other = { userId: "fx-b", authority: "session" } as TenantContext;
  expect(await repository.get(other, write)).toEqual({ status: "pending" });
  await db
    .prepare(
      "UPDATE ledger_entries SET kind='refund',amount_minor=1,event_date='2026-10-12' WHERE user_id=?",
    )
    .bind(other.userId)
    .run();
  const refund = await repository.put(other, {
    ...write,
    quote: {
      ...write.quote,
      requestedDate: "2026-10-12",
      effectiveDate: "2026-10-12",
    },
  });
  expect(refund).toMatchObject({
    status: "stored",
    result: { signedMinor: "-1", quote: { requestedDate: "2026-10-12" } },
  });
  const paid = await repository.get(tenant, write);
  if (paid.status !== "valued" || refund.status !== "stored")
    throw new Error("MISSING_SYNTHETIC_VALUATION");
  expect(
    sumFxConversions("USD", [
      paid.result,
      { ...refund.result, entry: { ...refund.result.entry, id: "refund" } },
    ]).signedMinor,
  ).toBe("0");
  const absent = {
    userId: "fx-foreign",
    authority: "session",
  } as TenantContext;
  expect(await repository.get(absent, write)).toEqual({ status: "missing" });
  expect(await repository.put(absent, write)).toEqual({ status: "stale" });
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES('only-b','fx-b','obs','only-b','payment',1,'EUR','2026-10-11','document-date',1)",
    )
    .run();
  await expect(
    db
      .prepare(
        "UPDATE entry_valuations SET entry_id='only-b' WHERE user_id='fx-a'",
      )
      .run(),
  ).rejects.toThrow();
  expect(guarded.executedStatements()).toBeLessThanOrEqual(40);
});
it("FX-05: deleting profile/ineligible entry and a stale valuation CAS are barriers", async () => {
  const repository = createFxValuationRepository(db, { policy });
  expect((await repository.put(tenant, write)).status).toBe("stored");
  expect(
    await repository.put(tenant, { ...write, expectedValuationVersion: 0 }),
  ).toEqual({ status: "conflict" });
  await db
    .prepare("UPDATE ledger_entries SET eligible=0 WHERE user_id=?")
    .bind(tenant.userId)
    .run();
  expect(await repository.get(tenant, write)).toEqual({ status: "missing" });
  expect(
    await repository.put(tenant, { ...write, expectedValuationVersion: 1 }),
  ).toEqual({ status: "stale" });
  await db
    .prepare("UPDATE ledger_entries SET eligible=1 WHERE user_id=?")
    .bind(tenant.userId)
    .run();
  await db
    .prepare("UPDATE profiles SET status='deleting' WHERE user_id=?")
    .bind(tenant.userId)
    .run();
  expect(await repository.get(tenant, write)).toEqual({ status: "missing" });
  expect(
    await repository.put(tenant, { ...write, expectedValuationVersion: 1 }),
  ).toEqual({ status: "stale" });
});
it("FX-01: migration preserves populated money and scoped public/current read indexes", async () => {
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  const publicPlan = (
    await db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM fx_rates WHERE source=? AND from_currency=? AND to_currency=? AND effective_date<=? ORDER BY effective_date DESC LIMIT 1",
      )
      .bind(policy.source, "EUR", "USD", "2026-10-11")
      .all<{ detail: string }>()
  ).results;
  expect(publicPlan.map((row) => row.detail).join(" ")).toContain(
    "fx_rates_public_lookup",
  );
  const privatePlan = (
    await db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT signed_minor FROM entry_valuations WHERE user_id=? AND entry_id=? AND profile_version=? AND entry_version=? AND reporting_currency=? AND calculation_version=? AND policy_hash=?",
      )
      .bind(tenant.userId, "entry", 1, 1, "USD", "fx-v1", "a".repeat(64))
      .all<{ detail: string }>()
  ).results;
  expect(privatePlan.map((row) => row.detail).join(" ")).toContain("INDEX");
  expect(
    await db
      .prepare(
        "SELECT CAST(amount_minor AS TEXT) AS minor,currency FROM ledger_entries WHERE user_id=?",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual({ minor: "1", currency: "EUR" });
});

it("FX-05: changed preference between read and batch fences all writes including public quote", async () => {
  const changing = {
    prepare: (sql: string) => db.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      await db
        .prepare("UPDATE profiles SET version=2 WHERE user_id=?")
        .bind(tenant.userId)
        .run();
      return db.batch(statements);
    },
  } as unknown as D1Database;
  expect(
    await createFxValuationRepository(changing, { policy }).put(tenant, write),
  ).toEqual({ status: "stale" });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM fx_rates").first("count"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM entry_valuations")
      .first("count"),
  ).toBe(0);
});
it("FX-01: concurrent CAS has one valuation winner and no duplicate public snapshot", async () => {
  const repository = createFxValuationRepository(db, { policy });
  const results = await Promise.all([
    repository.put(tenant, write),
    repository.put(tenant, {
      ...write,
      quote: { ...write.quote, retrievedAt: 3000 },
    }),
  ]);
  expect(results.filter((result) => result.status === "stored")).toHaveLength(
    1,
  );
  expect(
    results.filter(
      (result) => result.status === "conflict" || result.status === "stale",
    ),
  ).toHaveLength(1);
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM fx_rates").first("count"),
  ).toBe(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM entry_valuations")
      .first("count"),
  ).toBe(1);
});
it("FX-02: unsupported currency and converted magnitude overflow remain unconverted original facts", async () => {
  const repository = createFxValuationRepository(db, { policy });
  await db
    .prepare("UPDATE ledger_entries SET currency='XYZ' WHERE user_id=?")
    .bind(tenant.userId)
    .run();
  expect(await repository.put(tenant, write)).toMatchObject({
    status: "stored",
    result: {
      status: "unconverted",
      reason: "currency_unsupported",
      entry: { currency: "XYZ", amountMinor: "1" },
    },
  });
  await db
    .prepare(
      "UPDATE ledger_entries SET currency='EUR',amount_minor=9000000000000,version=2 WHERE user_id=?",
    )
    .bind(tenant.userId)
    .run();
  expect(
    await repository.put(tenant, {
      ...write,
      expectedEntryVersion: 2,
      quote: { ...write.quote, rate: "999999999999", version: "overflow" },
    }),
  ).toMatchObject({
    status: "stored",
    result: {
      status: "unconverted",
      reason: "magnitude_overflow",
      entry: { amountMinor: "9000000000000" },
    },
  });
});
it("FX-03: native stored converted strings sum exactly beyond SQLite integer and JavaScript precision", async () => {
  const repository = createFxValuationRepository(db, { policy });
  const results = [];
  for (const id of ["large-a", "large-b"]) {
    await db
      .prepare(
        "INSERT INTO ledger_entries(id,user_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES(?,?,'obs',?,'payment',9000000000000,'EUR','2026-10-11','document-date',1)",
      )
      .bind(id, tenant.userId, id)
      .run();
    const value = await repository.put(tenant, {
      ...write,
      entryId: id,
      quote: { ...write.quote, rate: "1000000", version: "large" },
    });
    expect(value).toMatchObject({
      status: "stored",
      result: { signedMinor: "9000000000000000000" },
    });
    if (value.status !== "stored") throw new Error("MISSING_LARGE_FX_FIXTURE");
    results.push(value.result);
  }
  expect(sumFxConversions("USD", results).signedMinor).toBe(
    "18000000000000000000",
  );
  expect(
    await db
      .prepare(
        "SELECT typeof(signed_minor) AS kind FROM entry_valuations WHERE user_id=? AND entry_id='large-a'",
      )
      .bind(tenant.userId)
      .first("kind"),
  ).toBe("text");
  await db
    .prepare(
      "DELETE FROM ledger_entries WHERE user_id=? AND id IN ('large-a','large-b')",
    )
    .bind(tenant.userId)
    .run();
});
