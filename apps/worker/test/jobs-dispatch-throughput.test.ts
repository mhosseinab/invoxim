import { env } from "cloudflare:workers";
import type { JobPolicy } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { createJobEngine } from "../../../packages/core/src/jobs/engine";
import { createInvocationDatabase } from "../src/invocation-database";

const policy: JobPolicy = {
  dispatchLimit: 5,
  scheduleLimit: 1,
  tenantConcurrency: 1,
  globalConcurrency: 1,
  maxAttempts: 3,
  leaseMs: 300000,
  redeliveryMs: 60000,
  queryLimit: 40,
};
beforeAll(async () => {
  for (const statement of baseline.split(";").filter((value) => value.trim()))
    await env.DB.prepare(statement).run();
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE profiles SET status='deleting'").run();
  await env.DB.prepare(
    "UPDATE scheduler_cursors SET last_user_id='',version=version+1",
  ).run();
});
async function seed(user: string, priorities = [0, 1, 1, 1, 2]) {
  await env.DB.prepare(
    "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)",
  )
    .bind(user, "Synthetic", `${user}@example.invalid`)
    .run();
  await env.DB.prepare(
    "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
  )
    .bind(user)
    .run();
  await env.DB.prepare(
    "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state,next_sync_at,credential_ciphertext,credential_key_version) VALUES(?,?,'mailbox','gmail',?,?,'active',9999999999999,'synthetic-envelope',1)",
  )
    .bind(`connection-${user}`, user, user, `${user}@example.invalid`)
    .run();
  await env.DB.prepare(
    "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES(?,?,?,1,'synthetic','local',0,0,1)",
  )
    .bind(`consent-${user}`, user, `connection-${user}`)
    .run();
  for (const [index, priority] of priorities.entries())
    await env.DB.prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,priority) VALUES(?,?,?,?,1,'source-extract',?,'ready',0,?)",
    )
      .bind(
        `${user}-${index}`,
        user,
        `connection-${user}`,
        `consent-${user}`,
        `${user}-${index}`,
        priority,
      )
      .run();
}
async function dispatch(activePolicy = policy, reviewed = false) {
  const meter = createInvocationDatabase(env.DB, activePolicy.queryLimit ?? 40);
  const queued: string[] = [];
  const jobs = createJobStore(meter.db, {
    policy: activePolicy,
    clock: () => 1000,
    ...(reviewed ? { processingReview: async () => "a".repeat(64) } : {}),
  });
  const result = await createJobEngine({
    store: jobs,
    queue: {
      async send(body) {
        queued.push(body.jobId);
      },
    },
    clock: () => 1000,
  }).dispatch();
  expect(meter.executedStatements()).toBeLessThanOrEqual(
    activePolicy.queryLimit ?? 40,
  );
  expect(result.sent).toBe(queued.length);
  return queued;
}

it("Five ready jobs enter the queue in one Cron tick while only one lease can be held and consumption remains sequential", async () => {
  const user = "throughput-single";
  await seed(user);
  const queued = await dispatch();
  expect(queued).toEqual(
    Array.from({ length: 5 }, (_, index) => `${user}-${index}`),
  );
  const first = queued[0];
  if (!first) throw new Error("Expected queued job");
  const meter = createInvocationDatabase(env.DB, 40);
  const store = createJobStore(meter.db, { policy, clock: () => 1000 });
  const lease = await store.claim(first);
  if (!lease) throw new Error("First dispatched job did not acquire lease");
  for (const job of queued.slice(1)) expect(await store.claim(job)).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE status='leased'",
    ).first("n"),
  ).toBe(1);
  expect(await store.finish(lease, { kind: "completed" })).toBe(true);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  const consumed: string[] = [];
  for (const job of queued.slice(1)) {
    const invocation = createInvocationDatabase(env.DB, 40);
    const currentStore = createJobStore(invocation.db, {
      policy,
      clock: () => 1000,
    });
    const engine = createJobEngine({
      store: currentStore,
      queue: { async send() {} },
      handler: {
        async run(current) {
          consumed.push(current.jobId);
          expect(
            await env.DB.prepare(
              "SELECT COUNT(*) n FROM jobs WHERE status='leased'",
            ).first("n"),
          ).toBe(1);
          return { kind: "completed" };
        },
      },
      clock: () => 1000,
    });
    expect(await engine.consume({ schemaVersion: 1, jobId: job })).toBe("ack");
    expect(invocation.executedStatements()).toBeLessThanOrEqual(40);
  }
  expect(consumed).toEqual(queued.slice(1));
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND status='completed'",
    )
      .bind(user)
      .first("n"),
  ).toBe(5);
});

it("Queue dispatch interleaves two workspaces fairly while preserving the global five-job cap", async () => {
  await seed("throughput-fair-a", [1, 1, 1, 1, 1]);
  await seed("throughput-fair-b", [1, 1, 1, 1, 1]);
  expect(await dispatch()).toEqual([
    "throughput-fair-a-0",
    "throughput-fair-b-0",
    "throughput-fair-a-1",
    "throughput-fair-b-1",
    "throughput-fair-a-2",
  ]);
});

it("Processing-review enabled 24-statement invocation dispatches only its two reserved jobs", async () => {
  await seed("throughput-reviewed");
  expect(await dispatch({ ...policy, queryLimit: 24 }, true)).toEqual([
    "throughput-reviewed-0",
    "throughput-reviewed-1",
  ]);
});
