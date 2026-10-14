// Explicit populated historical-upgrade fixture; old SQL is never an active deployment migration.

import { env } from "cloudflare:workers";
import type { ApprovedAiConfig, JobLease, TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import {
  type AiBudgetPolicy,
  type AiPriceSnapshot,
  createAiProbeUsageStore,
  createAiUsageStore,
  readAiAllowance,
} from "../../../packages/adapters/src/ai/budget";
import { createInvocationDatabase } from "../src/invocation-database";
import { useCurrentSchema } from "./support/db";
const db = env.DB;

const now = Date.UTC(2026, 9, 12);
const tenant = { userId: "budget-a", authority: "job" } as TenantContext;
const policy: AiBudgetPolicy = {
  dailyDocuments: 1,
  monthlyDocuments: 10,
  dailyUnits: 10000,
  monthlyUnits: 100000,
  globalDailyUsdMicros: "100000",
  globalMonthlyUsdMicros: "1000000",
};
const price: AiPriceSnapshot = {
  destinationId: "processor",
  modelId: "small",
  configVersion: "config-v1",
  policyVersion: 1,
  configurationDigest: "b".repeat(64),
  version: "price-v1",
  approved: true,
  currency: "USD",
  source: "https://example.invalid/pricing",
  checkedAt: "2026-10-12T00:00:00Z",
  inputUsdMicrosPerMillion: "1000000",
  outputUsdMicrosPerMillion: "2000000",
  otherUsdMicrosPerMillion: "2000000",
};
let config: ApprovedAiConfig;
let upgradedVault: {
  encrypted_key: string;
  key_version: number;
  generation: number;
  credential_version: number;
} | null;
async function hash(value: unknown) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function lease(id: string): JobLease {
  return {
    context: tenant,
    jobId: id,
    connectionId: "budget-c",
    consentId: "budget-consent",
    generation: 1,
    syncStateId: null,
    type: "source-extract",
    leaseId: `lease-${id}`,
    fence: 1,
    expiresAt: now + 300000,
    attempt: 1,
  };
}
beforeAll(async () => {
  await useCurrentSchema(db);
  await useCurrentSchema(db);
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
    )
    .bind(tenant.userId, "Synthetic", "budget@example.invalid")
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO ai_settings(user_id,encrypted_key,key_version,generation,credential_version) VALUES(?,'synthetic-opaque-envelope',1,5,3)",
    )
    .bind(tenant.userId)
    .run();

  upgradedVault = await db
    .prepare(
      "SELECT encrypted_key,key_version,generation,credential_version FROM ai_settings WHERE user_id=?",
    )
    .bind(tenant.userId)
    .first();
  await db
    .prepare(
      "UPDATE ai_settings SET mode='hosted',provider_id='processor',model_id='small',config_version='config-v1',revision=1,consent_version=1 WHERE user_id=?",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state) VALUES('budget-c',?,'mailbox','gmail','synthetic','synthetic@example.invalid','active')",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES('budget-consent',?,'budget-c',1,'processor','local',1,?,1)",
    )
    .bind(tenant.userId, now)
    .run();
  config = {
    destinationId: "processor",
    modelId: "small",
    mode: "hosted",
    settingsRevision: 1,
    consentId: "budget-consent",
    fingerprint: await hash([
      "hosted",
      "b".repeat(64),
      1,
      1,
      0,
      1,
      "budget-consent",
      "invoice-extraction-v1",
      1,
    ]),
    promptVersion: "invoice-extraction-v1",
    schemaVersion: 1,
    maxInputBytes: 10000,
    maxOutputBytes: 64000,
    maxOutputTokens: 1000,
    maxAttempts: 2,
    reservationUnits: 1000,
  };
  for (const id of ["one", "two"]) {
    await db
      .prepare(
        "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,lease_id,lease_expires_at,fence) VALUES(?,?,'budget-c','budget-consent',1,'source-extract',?,'leased',?,?,?,1)",
      )
      .bind(id, tenant.userId, id, now, `lease-${id}`, now + 300000)
      .run();
    await db
      .prepare(
        "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,'budget-c',?, ?,1)",
      )
      .bind(`source-${id}`, tenant.userId, id, now)
      .run();
    await db
      .prepare(
        "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES(?,?,?,'body',?,'text/plain',10)",
      )
      .bind(`doc-${id}`, tenant.userId, `source-${id}`, "a".repeat(64))
      .run();
    await db
      .prepare(
        "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id) VALUES(?,?,?)",
      )
      .bind(tenant.userId, id, `source-${id}`)
      .run();
  }
});
beforeEach(async () => {
  for (const table of [
    "usage_events",
    "ai_extractions",
    "usage_buckets",
    "hosted_ai_cooldowns",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
  await db
    .prepare(
      "UPDATE ai_settings SET generation=1,credential_version=0,revision=1,status='active' WHERE user_id=?",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "UPDATE jobs SET status='leased',fence=1,lease_expires_at=? WHERE user_id=?",
    )
    .bind(now + 300000, tenant.userId)
    .run();
});
async function attempt(id = "one", number = 1, configuration = config) {
  const identity = {
    documentId: `doc-${id}`,
    contentHash: "a".repeat(64),
    extractionVersion: "v1",
  };
  return {
    tenant,
    config: configuration,
    identity,
    attemptNumber: number,
    attemptId: `${await hash([tenant.userId, identity.documentId, identity.contentHash, identity.extractionVersion, configuration.fingerprint])}:${number}`,
  };
}
function store(id = "one", limits = policy, database = db) {
  return createAiUsageStore(database, {
    lease: lease(id),
    policy: limits,
    pricing: new Map([[config.fingerprint, price]]),
    clock: () => now,
  });
}
it("AI-05: concurrent last document allowance has one winner and no prefix charge", async () => {
  const results = await Promise.all(
    ["one", "two"].map(async (id) => {
      const store = createAiUsageStore(db, {
        lease: lease(id),
        policy,
        pricing: new Map([[config.fingerprint, price]]),
        clock: () => now,
      });
      const checkpoint = {
        tenant,
        config,
        identity: {
          documentId: `doc-${id}`,
          contentHash: "a".repeat(64),
          extractionVersion: "v1",
        },
      };
      expect(await store.checkpoint(checkpoint)).toEqual({ status: "ready" });
      return store.reserve({
        ...checkpoint,
        attemptId: `${await hash([
          tenant.userId,
          checkpoint.identity.documentId,
          checkpoint.identity.contentHash,
          "v1",
          config.fingerprint,
        ])}:1`,
        attemptNumber: 1,
      });
    }),
  );
  expect(results.sort()).toEqual(["budget", "reserved"]);
  expect(
    await db
      .prepare(
        "SELECT documents FROM usage_buckets WHERE scope='tenant' AND owner_key=? AND period_kind='day'",
      )
      .bind(tenant.userId)
      .first("documents"),
  ).toBe(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM usage_events")
      .first("count"),
  ).toBe(1);
});

it("AI-06: known usage reconciles exact micros once and repair charges one document", async () => {
  const guarded = createInvocationDatabase(env.DB, 40);
  const usage = store("one", { ...policy, dailyDocuments: 2 }, guarded.db);
  const first = await attempt();
  expect(await usage.reserve(first)).toBe("reserved");
  expect(await usage.authorize(first)).toBe(true);
  expect(await usage.authorize(first)).toBe(false);
  await usage.settle(first, {
    state: "known",
    usage: { input: 10, output: 3, other: 2, source: "reported" },
  });
  await usage.settle(first, {
    state: "known",
    usage: { input: 10, output: 3, other: 2, source: "reported" },
  });
  const second = await attempt("one", 2);
  expect(await usage.reserve(second)).toBe("reserved");
  expect(
    await db
      .prepare(
        "SELECT documents FROM usage_buckets WHERE scope='tenant' AND period_kind='day'",
      )
      .first("documents"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT spent_usd_micros FROM usage_buckets WHERE scope='global' AND period_kind='day'",
      )
      .first("spent_usd_micros"),
  ).toBe(20);
  expect(await usage.authorize(second)).toBe(true);
  await usage.settle(second, {
    state: "known",
    usage: { input: 0, output: 1, other: 0, source: "reported" },
  });
  expect(
    await usage.complete(first, { status: "needs-review", reason: "schema" }),
  ).toBe(true);
  expect(await usage.checkpoint(first)).toEqual({
    status: "completed",
    result: { status: "needs-review", reason: "schema" },
  });
  expect(guarded.executedStatements()).toBeLessThanOrEqual(40);
});
it("AI-06: ambiguous sent attempt remains charged and sticky across UTC periods", async () => {
  const usage = store();
  const input = await attempt();
  expect(await usage.reserve(input)).toBe("reserved");
  expect(await usage.authorize(input)).toBe(true);
  await usage.settle(input, { state: "uncertain", usage: null });
  expect(await usage.reserve(input)).toBe("existing");
  expect(await usage.reserve(await attempt("one", 2))).toBe("budget");
  await db
    .prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?")
    .bind(now + 86400000 + 300000, "one")
    .run();
  const later = createAiUsageStore(db, {
    lease: lease("one"),
    policy,
    pricing: new Map([[config.fingerprint, price]]),
    clock: () => now + 86400000,
  });
  expect(await later.reserve(input)).toBe("existing");
  expect(
    await db
      .prepare(
        "SELECT reserved_usd_micros FROM usage_buckets WHERE scope='global' AND period_kind='day'",
      )
      .first("reserved_usd_micros"),
  ).toBe(2000);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM usage_events")
      .first("count"),
  ).toBe(1);
});
it("AI-05: stale settings and lease prevent authorization and cache writes", async () => {
  const usage = store();
  const input = await attempt();
  expect(await usage.reserve(input)).toBe("reserved");
  await db
    .prepare("UPDATE ai_settings SET generation=2 WHERE user_id=?")
    .bind(tenant.userId)
    .run();
  expect(await usage.authorize(input)).toBe(false);
  expect(
    await usage.complete(input, { status: "needs-review", reason: "schema" }),
  ).toBe(false);
  expect(
    await db
      .prepare("SELECT state FROM usage_events WHERE user_id=?")
      .bind(tenant.userId)
      .first("state"),
  ).toBe("reserved");
});
it("AI-05: persisted cooldown blocks another run and allowance reports retained usage", async () => {
  const usage = store("one", { ...policy, dailyDocuments: 3 });
  const input = await attempt();
  expect(await usage.reserve(input)).toBe("reserved");
  expect(await usage.authorize(input)).toBe(true);
  await usage.settle(input, {
    state: "uncertain",
    usage: null,
    retryAfterMs: 60000,
  });
  expect(
    await store("two", { ...policy, dailyDocuments: 3 }).reserve(
      await attempt("two"),
    ),
  ).toBe("budget");
  expect(
    await readAiAllowance(db, tenant, policy, {
      destinationId: "processor",
      modelId: "small",
      clock: () => now,
    }),
  ).toEqual({
    dailyDocumentsRemaining: 0,
    monthlyDocumentsRemaining: 9,
    dailyUnitsRemaining: 9000,
    monthlyUnitsRemaining: 99000,
    hostedFundingAvailable: true,
    cooldownActive: true,
  });
});
it("AI-05: populated upgrade preserves vault metadata and composite ownership/indexes", async () => {
  expect(upgradedVault).toEqual({
    encrypted_key: "synthetic-opaque-envelope",
    key_version: 1,
    generation: 5,
    credential_version: 3,
  });
  expect(
    await db
      .prepare("SELECT generation FROM ai_settings WHERE user_id=?")
      .bind(tenant.userId)
      .first("generation"),
  ).toBe(1);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  const plan = (
    await db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT 1 FROM usage_events WHERE user_id=? AND destination_id=? AND model_id=? AND cooldown_until>?",
      )
      .bind(tenant.userId, "processor", "small", now)
      .all<{ detail: string }>()
  ).results;
  expect(plan.map((row) => row.detail).join(" ")).toContain(
    "ai_events_tenant_cooldown",
  );
  await expect(
    db
      .prepare(
        "INSERT INTO ai_extractions(user_id,run_key,purpose,document_id,content_hash,extraction_version,config_fingerprint,mode,destination_id,model_id,config_version,settings_revision,generation,credential_version,reservation_nonce,created_at) VALUES(?,'foreign','extraction','foreign-document','a','v1','b','hosted','processor','small','config-v1',1,1,0,'nonce',0)",
      )
      .bind(tenant.userId)
      .run(),
  ).rejects.toThrow();
});
it("AI-05: fixed synthetic probe has real session fence and safe cached result", async () => {
  await db
    .prepare(
      'INSERT INTO "session"(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)',
    )
    .bind(
      "budget-session",
      now + 300000,
      "synthetic-session-token",
      now,
      now,
      tenant.userId,
    )
    .run();
  const probeConfig = {
    ...config,
    consentId: "synthetic-test",
    fingerprint: await hash([
      "hosted",
      "b".repeat(64),
      1,
      1,
      0,
      1,
      "synthetic-test",
      "invoice-extraction-v1",
      1,
    ]),
  };
  const guarded = createInvocationDatabase(env.DB, 40);
  const probe = createAiProbeUsageStore(guarded.db, {
    session: {
      tenant: { userId: tenant.userId, authority: "session" } as TenantContext,
      sessionId: "budget-session",
    },
    policy,
    pricing: new Map([[probeConfig.fingerprint, price]]),
    clock: () => now,
  });
  const input = { config: probeConfig };
  expect(await probe.checkpoint(input)).toEqual({ status: "ready" });
  expect(await probe.reserve(input)).toBe("reserved");
  expect(await probe.authorize(input)).toBe(true);
  await probe.settle(input, {
    state: "known",
    usage: { input: 1, output: 1, other: 0, source: "reported" },
  });
  expect(await probe.complete(input, { status: "passed" })).toBe(true);
  expect(await probe.checkpoint(input)).toEqual({
    status: "completed",
    result: { status: "passed" },
  });
  expect(await probe.reserve(input)).toBe("existing");
  expect(guarded.executedStatements()).toBeLessThanOrEqual(40);
  await db
    .prepare('DELETE FROM "session" WHERE id=?')
    .bind("budget-session")
    .run();
  expect(await probe.authorize(input)).toBe(false);
});
it("AI-06: extraordinary reported overrun stores exact decimal totals and stays blocked next period", async () => {
  const usage = store();
  const input = await attempt();
  expect(await usage.reserve(input)).toBe("reserved");
  expect(await usage.authorize(input)).toBe(true);
  await usage.settle(input, {
    state: "uncertain",
    usage: {
      input: Number.MAX_SAFE_INTEGER,
      output: Number.MAX_SAFE_INTEGER,
      other: 0,
      source: "reported",
    },
  });
  expect(
    await db
      .prepare("SELECT actual_usd_micros FROM usage_events WHERE user_id=?")
      .bind(tenant.userId)
      .first("actual_usd_micros"),
  ).toBe("27021597764222973");
  expect(
    await db
      .prepare("SELECT state FROM usage_events WHERE user_id=?")
      .bind(tenant.userId)
      .first("state"),
  ).toBe("overrun");
  await db
    .prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?")
    .bind(now + 86400000 + 300000, "two")
    .run();
  const later = createAiUsageStore(db, {
    lease: lease("two"),
    policy,
    pricing: new Map([[config.fingerprint, price]]),
    clock: () => now + 86400000,
  });
  expect(await later.reserve(await attempt("two"))).toBe("budget");
  expect(
    (
      await readAiAllowance(db, tenant, policy, {
        clock: () => now + 86400000,
      })
    ).dailyUnitsRemaining,
  ).toBe(0);
});
it("AI-05: unrepresentable reservation cost is rejected before attempt or counters", async () => {
  const costly = {
    ...price,
    inputUsdMicrosPerMillion: "9000000000000",
    outputUsdMicrosPerMillion: "9000000000000",
  };
  const enormous = { ...config, reservationUnits: 9000000000000 };
  const usage = createAiUsageStore(db, {
    lease: lease("one"),
    policy: {
      ...policy,
      dailyUnits: 9000000000000,
      monthlyUnits: 9000000000000,
    },
    pricing: new Map([[config.fingerprint, costly]]),
    clock: () => now,
  });
  expect(await usage.reserve(await attempt("one", 1, enormous))).toBe("budget");
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM usage_events")
      .first("count"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM usage_buckets")
      .first("count"),
  ).toBe(0);
});
it("AI-05: unexpected driver failures expose only a constant safe budget error", async () => {
  const failing = {
    prepare() {
      throw new Error("synthetic-driver-private-value");
    },
  } as unknown as D1Database;
  const usage = store("one", policy, failing);
  await expect(usage.checkpoint(await attempt())).rejects.toThrow(
    "AI_BUDGET_UNAVAILABLE",
  );
});

it("AI-05: zero hosted operator caps disable even explicitly zero-priced calls", async () => {
  const free = {
    ...price,
    inputUsdMicrosPerMillion: "0",
    outputUsdMicrosPerMillion: "0",
    otherUsdMicrosPerMillion: "0",
  };
  const usage = createAiUsageStore(db, {
    lease: lease("one"),
    policy: { ...policy, globalDailyUsdMicros: "0" },
    pricing: new Map([[config.fingerprint, free]]),
    clock: () => now,
  });
  expect(await usage.reserve(await attempt())).toBe("budget");
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM usage_events")
      .first("count"),
  ).toBe(0);
});
it("AI-06: cumulative overrun persists exact event while retaining bounded counters and permanent hosted pause", async () => {
  const guarded = createInvocationDatabase(env.DB, 40);
  const maximum = {
    ...policy,
    dailyUnits: 9000000000000,
    monthlyUnits: 9000000000000,
    globalDailyUsdMicros: "9000000000000",
    globalMonthlyUsdMicros: "9000000000000",
  };
  const usage = store("one", maximum, guarded.db);
  const input = await attempt();
  expect(await usage.reserve(input)).toBe("reserved");
  expect(await usage.authorize(input)).toBe(true);
  await db
    .prepare(
      "UPDATE usage_buckets SET spent_units=CASE WHEN scope='tenant' THEN 8999999999000 ELSE 0 END,spent_usd_micros=CASE WHEN scope='global' THEN 8999999998000 ELSE 0 END",
    )
    .run();
  const reported = {
    state: "uncertain" as const,
    usage: { input: 0, output: 2500, other: 0, source: "reported" as const },
  };
  await usage.settle(input, reported);
  await usage.settle(input, reported);
  expect(
    await db
      .prepare("SELECT actual_usd_micros FROM usage_events WHERE user_id=?")
      .bind(tenant.userId)
      .first("actual_usd_micros"),
  ).toBe("5000");
  expect(
    await db
      .prepare("SELECT state FROM usage_events WHERE user_id=?")
      .bind(tenant.userId)
      .first("state"),
  ).toBe("overrun");
  const tenantBucket = await db
    .prepare(
      "SELECT spent_units,reserved_units,blocked FROM usage_buckets WHERE scope='tenant' AND period_kind='day'",
    )
    .first();
  expect(tenantBucket).toEqual({
    spent_units: 8999999999000,
    reserved_units: 1000,
    blocked: 1,
  });
  expect(
    await db
      .prepare(
        "SELECT spent_usd_micros,reserved_usd_micros,blocked FROM usage_buckets WHERE scope='global' AND period_kind='day'",
      )
      .first(),
  ).toEqual({
    spent_usd_micros: 8999999998000,
    reserved_usd_micros: 2000,
    blocked: 1,
  });
  expect(guarded.executedStatements()).toBeLessThanOrEqual(40);
  await db
    .prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?")
    .bind(now + 86400000 + 300000, "two")
    .run();
  const later = createAiUsageStore(db, {
    lease: lease("two"),
    policy: maximum,
    pricing: new Map([[config.fingerprint, price]]),
    clock: () => now + 86400000,
  });
  expect(await later.reserve(await attempt("two"))).toBe("budget");
  await db
    .prepare("DELETE FROM usage_events WHERE user_id=?")
    .bind(tenant.userId)
    .run();
  await db
    .prepare("DELETE FROM ai_extractions WHERE user_id=?")
    .bind(tenant.userId)
    .run();
  expect(await later.reserve(await attempt("two"))).toBe("budget");
  expect(
    (
      await readAiAllowance(db, tenant, maximum, {
        clock: () => now + 86400000,
      })
    ).hostedFundingAvailable,
  ).toBe(false);
});
it("AI-05: shared hosted cooldown blocks a different trusted tenant and survives tenant event deletion", async () => {
  const other = {
    userId: "budget-shared-other",
    authority: "session",
  } as TenantContext;
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
    )
    .bind(other.userId, "Synthetic", "other-budget@example.invalid")
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind(other.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO ai_settings(user_id,mode,provider_id,model_id,config_version,revision,consent_version) VALUES(?,'hosted','processor','small','config-v1',1,1)",
    )
    .bind(other.userId)
    .run();
  await db
    .prepare(
      'INSERT INTO "session"(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)',
    )
    .bind(
      "shared-other-session",
      now + 300000,
      "shared-synthetic-session",
      now,
      now,
      other.userId,
    )
    .run();
  const probeConfig = {
    ...config,
    consentId: "synthetic-test",
    fingerprint: await hash([
      "hosted",
      "b".repeat(64),
      1,
      1,
      0,
      1,
      "synthetic-test",
      "invoice-extraction-v1",
      1,
    ]),
  };
  const guarded = createInvocationDatabase(env.DB, 40);
  const probe = createAiProbeUsageStore(guarded.db, {
    session: { tenant: other, sessionId: "shared-other-session" },
    policy,
    pricing: new Map([[probeConfig.fingerprint, price]]),
    clock: () => now,
  });
  expect(await probe.reserve({ config: probeConfig })).toBe("reserved");
  const usage = store();
  const input = await attempt();
  expect(await usage.reserve(input)).toBe("reserved");
  expect(await usage.authorize(input)).toBe(true);
  await usage.settle(input, {
    state: "uncertain",
    usage: null,
    retryAfterMs: 120000,
  });
  expect(await probe.authorize({ config: probeConfig })).toBe(false);
  expect(
    (
      await readAiAllowance(db, other, policy, {
        destinationId: "processor",
        modelId: "small",
        clock: () => now,
      })
    ).cooldownActive,
  ).toBe(true);
  await db
    .prepare("DELETE FROM usage_events WHERE user_id=?")
    .bind(tenant.userId)
    .run();
  await db
    .prepare("DELETE FROM ai_extractions WHERE user_id=?")
    .bind(tenant.userId)
    .run();
  expect(await probe.authorize({ config: probeConfig })).toBe(false);
  await db
    .prepare(
      "UPDATE ai_settings SET mode='byok',encrypted_key='synthetic-opaque-byok',key_version=1,revision=2,generation=2,credential_version=1 WHERE user_id=?",
    )
    .bind(other.userId)
    .run();
  const byokConfig = {
    ...probeConfig,
    mode: "byok" as const,
    settingsRevision: 2,
    fingerprint: await hash([
      "byok",
      "b".repeat(64),
      2,
      2,
      1,
      1,
      "synthetic-test",
      "invoice-extraction-v1",
      1,
    ]),
  };
  const byok = createAiProbeUsageStore(db, {
    session: { tenant: other, sessionId: "shared-other-session" },
    policy: { ...policy, dailyDocuments: 2 },
    pricing: new Map([[byokConfig.fingerprint, price]]),
    clock: () => now,
  });
  expect(await byok.reserve({ config: byokConfig })).toBe("reserved");
  expect(await byok.authorize({ config: byokConfig })).toBe(true);
  await byok.settle(
    { config: byokConfig },
    { state: "uncertain", usage: null, retryAfterMs: 600000 },
  );
  expect(
    await db
      .prepare(
        "SELECT cooldown_until FROM hosted_ai_cooldowns WHERE destination_id='processor' AND model_id='small'",
      )
      .first("cooldown_until"),
  ).toBe(now + 120000);
  expect(guarded.executedStatements()).toBeLessThanOrEqual(40);
});
