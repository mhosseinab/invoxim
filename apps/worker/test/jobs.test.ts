// Explicit populated historical-upgrade fixture; old SQL is never an active deployment migration.

import { env } from "cloudflare:workers";
import type { JobPolicy, TenantContext } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { createJobEngine } from "../../../packages/core/src/jobs/engine";
import { useCurrentSchema } from "./support/db";

const db = env.DB;

const policy: JobPolicy = {
  dispatchLimit: 20,
  scheduleLimit: 20,
  tenantConcurrency: 2,
  globalConcurrency: 20,
  maxAttempts: 3,
  leaseMs: 300000,
  redeliveryMs: 60000,
};
beforeAll(async () => {
  await useCurrentSchema(db);
  await db
    .prepare(
      "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES('job-a','Synthetic','job-a@example.invalid',1,0,0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES('job-a',0,0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state) VALUES('conn-a','job-a','mailbox','gmail','subject-a','job-a@example.invalid','active')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES('consent-a','job-a','conn-a',1,'synthetic','synthetic',1,0,1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES('duplicate-claim','job-a','conn-a','consent-a',1,'extract','duplicate-claim','ready',0)",
    )
    .run();
  await useCurrentSchema(db);
});
it("JOBS-01: concurrent duplicate delivery yields one valid leased owner", async () => {
  const store = createJobStore(db, { policy, clock: () => 1000 });
  const results = await Promise.all([
    store.claim("duplicate-claim"),
    store.claim("duplicate-claim"),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  if (results[0]) await store.finish(results[0], { kind: "completed" });
  else if (results[1]) await store.finish(results[1], { kind: "completed" });
});

it("JOBS-02: missing-handler delivery cannot ACK when durable pause lost its lease fence", async () => {
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES('ack-fence','job-a','conn-a','consent-a',1,'extract','ack-fence','ready',0)",
    )
    .run();
  const store = createJobStore(db, { policy, clock: () => 1000 });
  const fencedStore = {
    ...store,
    async finish(
      lease: Parameters<typeof store.finish>[0],
      outcome: Parameters<typeof store.finish>[1],
    ) {
      await db
        .prepare(
          "UPDATE jobs SET fence=fence+1,lease_id='replacement-owner' WHERE id='ack-fence'",
        )
        .run();
      return store.finish(lease, outcome);
    },
  };
  const engine = createJobEngine({
    store: fencedStore,
    queue: { async send() {} },
  });
  expect(await engine.consume({ schemaVersion: 1, jobId: "ack-fence" })).toBe(
    "retry",
  );
});

it("JOBS-03: populated upgrade preserves pending jobs and uses lease/tenant indexes", async () => {
  expect(
    await db
      .prepare(
        "SELECT connection_generation FROM jobs WHERE id='duplicate-claim'",
      )
      .first("connection_generation"),
  ).toBe(1);
  const plans = await Promise.all([
    db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM jobs WHERE user_id=? AND status=? AND priority=? AND dispatch_at<=? ORDER BY dispatch_at,id LIMIT 2",
      )
      .bind("job-a", "ready", 1, 1000)
      .all<{ detail: string }>(),
    db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM jobs WHERE status='leased' AND lease_expires_at<=? ORDER BY lease_expires_at,id LIMIT 2",
      )
      .bind(1000)
      .all<{ detail: string }>(),
  ]);
  expect(
    plans[0]?.results.some((row) => row.detail.includes("jobs_tenant_ready")),
  ).toBe(true);
  expect(
    plans[1]?.results.some((row) => row.detail.includes("jobs_global_leases")),
  ).toBe(true);
});

it("JOBS-03 / ONBOARD-13: active manual sync returns durable ID, coalesces and enforces cooldown", async () => {
  const { userId, authority } = { userId: "job-a", authority: "job" as const };
  const context = {
    userId,
    authority,
  } as TenantContext;
  const store = createJobStore(db, { policy, clock: () => 1000 });
  const first = await store.manualSync(context, "conn-a");
  expect(first.kind).toBe("queued");
  if (first.kind !== "queued")
    throw new Error("expected queued synthetic sync");
  expect(
    await db
      .prepare("SELECT type FROM jobs WHERE id=?")
      .bind(first.jobId)
      .first("type"),
  ).toBe("sync");
  expect(await store.manualSync(context, "conn-a")).toEqual({
    kind: "cooldown",
  });
  await db
    .prepare(
      "UPDATE connections SET scheduling_state='awaiting_import' WHERE id='conn-a'",
    )
    .run();
  expect(await store.manualSync(context, "conn-a")).toEqual({
    kind: "review-required",
  });
});

it("JOBS-02: an uncooperative handler cannot hold the queue beyond the lease deadline", async () => {
  await db
    .prepare(
      "UPDATE connections SET scheduling_state='active' WHERE id='conn-a'",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES('timeout-job','job-a','conn-a','consent-a',1,'extract','timeout-job','ready',0)",
    )
    .run();
  const at = Date.now();
  const store = createJobStore(db, {
    policy: { ...policy, leaseMs: 10 },
    clock: () => at,
  });
  const engine = createJobEngine({
    store,
    clock: () => at,
    queue: { async send() {} },
    handler: {
      async run() {
        return new Promise<never>(() => {});
      },
    },
  });
  expect(await engine.consume({ schemaVersion: 1, jobId: "timeout-job" })).toBe(
    "retry",
  );
  expect(
    await db
      .prepare("SELECT outcome_code FROM jobs WHERE id='timeout-job'")
      .first("outcome_code"),
  ).toBe("timeout");
});

it("JOBS-03: new periodic scheduling commits its job and advances the processed tenant cursor", async () => {
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state) VALUES('conn-periodic','job-a','mailbox','gmail','subject-periodic','periodic@example.invalid','active')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES('consent-periodic','job-a','conn-periodic',1,'synthetic','synthetic',1,0,1)",
    )
    .run();
  await db
    .prepare(
      "UPDATE scheduler_cursors SET last_user_id='job-0' WHERE kind='schedule'",
    )
    .run();
  const store = createJobStore(db, { policy, clock: () => 1000 });
  expect(await store.scheduleDue()).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE connection_id='conn-periodic' AND type='sync'",
      )
      .first("count"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT last_user_id FROM scheduler_cursors WHERE kind='schedule'",
      )
      .first("last_user_id"),
  ).toBe("job-a");
  expect(
    await db
      .prepare("SELECT next_sync_at FROM connections WHERE id='conn-periodic'")
      .first<number>("next_sync_at"),
  ).toBeGreaterThanOrEqual(3601000);
});

it("JOBS-06: an existing due sync cannot consume cursor headroom and starve the next tenant", async () => {
  await db
    .prepare(
      "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES('job-b','Synthetic','job-b@example.invalid',1,0,0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES('job-b',0,0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state) VALUES('conn-cold','job-b','mailbox','gmail','subject-cold','cold@example.invalid','active')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES('consent-cold','job-b','conn-cold',1,'synthetic','synthetic',1,0,1)",
    )
    .run();
  await db
    .prepare("UPDATE connections SET next_sync_at=0 WHERE id='conn-periodic'")
    .run();
  await db
    .prepare(
      "UPDATE scheduler_cursors SET last_user_id='job-0' WHERE kind='schedule'",
    )
    .run();
  await createJobStore(db, { policy, clock: () => 1000 }).scheduleDue();
  expect(
    await db
      .prepare(
        "SELECT last_user_id FROM scheduler_cursors WHERE kind='schedule'",
      )
      .first("last_user_id"),
  ).toBe("job-a");
  expect(
    await createJobStore(db, { policy, clock: () => 1000 }).scheduleDue(),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) FROM jobs WHERE connection_id='conn-cold' AND type='sync'",
      )
      .first("COUNT(*)"),
  ).toBe(1);
});

it("JOBS-05/06: minimum production budget cancels stale work and dispatches while recovering expired leases", async () => {
  await db
    .prepare(
      "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES('job-c','Synthetic','job-c@example.invalid',1,0,0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES('job-c',0,0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state,generation) VALUES('conn-budget','job-c','mailbox','gmail','subject-budget','budget@example.invalid','active',2)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES('consent-budget','job-c','conn-budget',1,'synthetic','synthetic',1,0,1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES('a-budget-stale','job-c','conn-budget','consent-budget',1,'extract','budget-stale','ready',0),('z-budget-ready','job-c','conn-budget','consent-budget',2,'extract','budget-ready','ready',0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,retry_count,lease_id,lease_expires_at,fence) VALUES('expired-budget','job-c','conn-budget','consent-budget',2,'extract','expired-budget','leased',0,3,'expired-owner',0,1)",
    )
    .run();
  for (const kind of ["schedule", "recovery", "dispatch"])
    await db
      .prepare("UPDATE scheduler_cursors SET last_user_id='job-b' WHERE kind=?")
      .bind(kind)
      .run();
  const store = createJobStore(db, {
    policy: { ...policy, queryLimit: 24 },
    clock: () => 1000,
  });
  const delivered: string[] = [];
  const engine = createJobEngine({
    store,
    clock: () => 1000,
    queue: {
      async send(body) {
        delivered.push(body.jobId);
      },
    },
  });
  await engine.dispatch();
  expect(
    await db
      .prepare("SELECT status FROM jobs WHERE id='a-budget-stale'")
      .first("status"),
  ).toBe("canceled");
  expect(
    await db
      .prepare("SELECT status FROM jobs WHERE id='expired-budget'")
      .first("status"),
  ).toBe("terminal");
  expect(delivered).toContain("z-budget-ready");
});
