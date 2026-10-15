import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { createInvocationDatabase } from "../src/invocation-database";
import { createJobRuntime } from "../src/job-runtime";
import configuration from "../wrangler.jsonc?raw";

const policy = {
  dispatchLimit: 5,
  scheduleLimit: 1,
  tenantConcurrency: Number(
    /"JOBS_TENANT_CONCURRENCY": "(\d+)"/.exec(configuration)?.[1],
  ),
  globalConcurrency: Number(
    /"JOBS_GLOBAL_CONCURRENCY": "(\d+)"/.exec(configuration)?.[1],
  ),
  maxAttempts: 3,
  leaseMs: 300000,
  redeliveryMs: 300000,
  queryLimit: 40,
};
let at = 1000;
beforeAll(async () => {
  for (const sql of baseline.split(";").filter((statement) => statement.trim()))
    await env.DB.prepare(sql).run();
  await env.DB.prepare(
    "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('parallel','Synthetic','parallel@example.invalid',1,0,0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO profiles(user_id,created_at,updated_at) VALUES('parallel',0,0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state,credential_ciphertext,credential_key_version) VALUES('c','parallel','mailbox','gmail','subject','parallel@example.invalid','active','synthetic-envelope',1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES('consent','parallel','c',1,'synthetic','local',0,0,1)",
  ).run();
});
beforeEach(async () => {
  at = 1000;
  await env.DB.prepare("DELETE FROM jobs WHERE user_id='parallel'").run();
  for (const id of ["first", "second", "third"])
    await env.DB.prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,dispatched_at) VALUES(?,'parallel','c','consent',1,'source-extract',?,'ready',0,1)",
    )
      .bind(id, id)
      .run();
});
function delivery(jobId: string) {
  return { body: { schemaVersion: 1, jobId }, ack: vi.fn(), retry: vi.fn() };
}
function batch(messages: ReturnType<typeof delivery>[]) {
  return { messages } as unknown as MessageBatch<unknown>;
}
function invocation() {
  const meter = createInvocationDatabase(env.DB, 40);
  const store = createJobStore(meter.db, {
    processingReview: null,
    policy,
    clock: () => at,
  });
  return { meter, store };
}
it("configured two independent consumer invocations overlap one workspace while retaining forty statements each and rejecting a third lease", async () => {
  expect(configuration).toMatch(/"max_batch_size": 1/);
  let releaseFirst = () => {};
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const first = invocation(),
    second = invocation();
  let active = 0,
    peak = 0;
  const one = delivery("first"),
    two = delivery("second");
  const firstRun = createJobRuntime({
    store: first.store,
    queue: { async send() {} },
    clock: () => at,
    handler: {
      async run() {
        active++;
        peak = Math.max(peak, active);
        firstEntered();
        await firstMayFinish;
        for (let count = 0; count < 24; count++)
          await first.meter.db.prepare("SELECT 1").first();
        active--;
        return { kind: "completed" };
      },
    },
  }).queue(batch([one]));
  await firstStarted;
  try {
    await createJobRuntime({
      store: second.store,
      queue: { async send() {} },
      clock: () => at,
      handler: {
        async run() {
          active++;
          peak = Math.max(peak, active);
          expect(await invocation().store.claim("third")).toBeNull();
          for (let count = 0; count < 24; count++)
            await second.meter.db.prepare("SELECT 1").first();
          active--;
          return { kind: "completed" };
        },
      },
    }).queue(batch([two]));
    expect(two.ack).toHaveBeenCalledOnce();
    expect(two.retry).not.toHaveBeenCalled();
    expect(peak).toBe(2);
  } finally {
    releaseFirst();
    await firstRun;
  }
  expect(configuration).toMatch(/"max_concurrency": 2/);
  expect(one.ack).toHaveBeenCalledOnce();
  for (const current of [first, second]) {
    expect(current.meter.executedStatements()).toBeGreaterThan(24);
    expect(current.meter.executedStatements()).toBeLessThanOrEqual(40);
  }
});
it("legacy multi-item deliveries preserve extra work and immediately redeliver it into a fresh invocation", async () => {
  const one = delivery("first"),
    two = delivery("second");
  const current = invocation();
  const handler = {
    async run() {
      return { kind: "completed" as const };
    },
  };
  await createJobRuntime({
    store: current.store,
    queue: { async send() {} },
    clock: () => at,
    handler,
  }).queue(batch([one, two]));
  expect(one.ack).toHaveBeenCalledOnce();
  expect(two.ack).not.toHaveBeenCalled();
  expect(two.retry).toHaveBeenCalledWith({ delaySeconds: 0 });
  expect(
    await env.DB.prepare(
      "SELECT retry_count FROM jobs WHERE id='second'",
    ).first("retry_count"),
  ).toBe(0);
  const fresh = invocation();
  await createJobRuntime({
    store: fresh.store,
    queue: { async send() {} },
    clock: () => at,
    handler,
  }).queue(batch([two]));
  expect(two.ack).toHaveBeenCalledOnce();
});
it("genuine processing failures retain thirty-second transport retry", async () => {
  const one = delivery("first"),
    current = invocation();
  await createJobRuntime({
    store: current.store,
    queue: { async send() {} },
    clock: () => at,
    handler: {
      async run() {
        return { kind: "retry", code: "transient" };
      },
    },
  }).queue(batch([one]));
  expect(one.ack).not.toHaveBeenCalled();
  expect(one.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
});
it.each([500, 120000])(
  "durable Retry-After %i preserves the larger exponential floor and defeats early dispatched-marker redelivery",
  async (floor) => {
    const store = invocation().store;
    const lease = await store.claim("first");
    if (!lease) throw new Error("Expected lease");
    expect(
      await store.finish(lease, {
        kind: "retry",
        code: "transient",
        retryAfterMs: floor,
      }),
    ).toBe(true);
    const dueAt = 1000 + Math.max(1000, floor);
    expect(
      await env.DB.prepare(
        "SELECT dispatch_at,dispatched_at FROM jobs WHERE id='first'",
      ).first(),
    ).toEqual({ dispatch_at: dueAt, dispatched_at: null });
    at = dueAt - 1;
    expect(await invocation().store.claim("first")).toBeNull();
    at = dueAt;
    const next = invocation().store;
    const candidates = await next.candidates();
    const candidate = candidates.find((value) => value.jobId === "first");
    if (!candidate) throw new Error("Missing due retry");
    expect(await next.dispatched(candidate)).toBe(true);
    expect(await invocation().store.claim("first")).not.toBeNull();
  },
);
it.each([-1, NaN, Infinity, 86400001, 0.5])(
  "invalid cooldown %s cannot weaken the store boundary",
  async (retryAfterMs) => {
    const store = invocation().store,
      lease = await store.claim("first");
    if (!lease) throw new Error("Expected lease");
    await expect(
      store.finish(lease, { kind: "retry", code: "transient", retryAfterMs }),
    ).rejects.toThrow("JOB_STORAGE_UNAVAILABLE");
    expect(
      await env.DB.prepare("SELECT status FROM jobs WHERE id='first'").first(
        "status",
      ),
    ).toBe("leased");
  },
);
it("a cooldown cannot overflow a durable timestamp or overwrite a reassigned lease", async () => {
  const store = invocation().store,
    lease = await store.claim("first");
  if (!lease) throw new Error("Expected lease");
  at = Number.MAX_SAFE_INTEGER - 500;
  await expect(
    store.finish(lease, {
      kind: "retry",
      code: "transient",
      retryAfterMs: 1000,
    }),
  ).rejects.toThrow("JOB_STORAGE_UNAVAILABLE");
  at = 1000;
  await env.DB.prepare(
    "UPDATE jobs SET fence=fence+1,lease_id='new-owner' WHERE id='first'",
  ).run();
  expect(
    await store.finish(lease, {
      kind: "retry",
      code: "transient",
      retryAfterMs: 120000,
    }),
  ).toBe(false);
  expect(
    await env.DB.prepare(
      "SELECT lease_id,dispatch_at FROM jobs WHERE id='first'",
    ).first(),
  ).toEqual({ lease_id: "new-owner", dispatch_at: 0 });
});
