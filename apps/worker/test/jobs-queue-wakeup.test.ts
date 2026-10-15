import { env } from "cloudflare:workers";
import type { JobHandler, JobPolicy } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { createInvocationDatabase } from "../src/invocation-database";
import { createJobRuntime } from "../src/job-runtime";

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
const wakeup = { schemaVersion: 1, dispatch: true };
let sequence = 0;
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
async function seed() {
  const user = `wakeup-${++sequence}`;
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
  await env.DB.prepare(
    "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES(?,?,?,?,1,'source-extract',?,'ready',0)",
  )
    .bind(
      `job-${user}`,
      user,
      `connection-${user}`,
      `consent-${user}`,
      `job-${user}`,
    )
    .run();
  return user;
}
function delivery(body: unknown) {
  const ack = vi.fn(),
    retry = vi.fn();
  return {
    batch: {
      messages: [{ body, ack, retry }],
    } as unknown as MessageBatch<unknown>,
    ack,
    retry,
  };
}
function invocation(sent: unknown[], handler?: JobHandler, failWakeup = false) {
  const meter = createInvocationDatabase(env.DB, 40);
  const store = createJobStore(meter.db, {
    processingReview: null,
    policy,
    clock: () => 1000,
  });
  const recover = vi.fn(() => store.recover()),
    scheduleDue = vi.fn(() => store.scheduleDue());
  const runtime = createJobRuntime({
    store: { ...store, recover, scheduleDue },
    queue: {
      async send(body) {
        sent.push(body);
      },
      async wakeDispatch() {
        if (failWakeup) throw new Error("Synthetic queue outage");
        sent.push(wakeup);
      },
    },
    ...(handler ? { handler } : {}),
    clock: () => 1000,
  });
  return { runtime, meter, recover, scheduleDue, store };
}
it("settled work wakes a fresh bounded dispatch invocation and delivers durable follow-up before Cron", async () => {
  const user = await seed(),
    sent: unknown[] = [];
  let handlerDb = env.DB;
  const current = invocation(sent, {
    async run(lease) {
      await handlerDb
        .prepare(
          "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES(?,?,?,?,1,'source-extract',?,'ready',0)",
        )
        .bind(
          `follow-${user}`,
          user,
          lease.connectionId,
          lease.consentId,
          `follow-${user}`,
        )
        .run();
      return { kind: "completed" };
    },
  });
  handlerDb = current.meter.db;
  const first = delivery({ schemaVersion: 1, jobId: `job-${user}` });
  await current.runtime.queue(first.batch);
  expect(first.ack).toHaveBeenCalledOnce();
  expect(sent).toEqual([wakeup]);
  expect(current.meter.executedStatements()).toBeLessThanOrEqual(40);
  const fresh = invocation(sent),
    dispatch = delivery(wakeup);
  await fresh.runtime.queue(dispatch.batch);
  expect(dispatch.ack).toHaveBeenCalledOnce();
  expect(sent).toEqual([wakeup, { schemaVersion: 1, jobId: `follow-${user}` }]);
  expect(fresh.recover).not.toHaveBeenCalled();
  expect(fresh.scheduleDue).not.toHaveBeenCalled();
  expect(fresh.meter.executedStatements()).toBeLessThanOrEqual(40);
  await invocation(sent).runtime.queue(delivery(wakeup).batch);
  expect(sent).toEqual([wakeup, { schemaVersion: 1, jobId: `follow-${user}` }]);
});
it("duplicate completed deliveries and malformed dispatch messages do not amplify wakeups", async () => {
  const user = await seed(),
    sent: unknown[] = [];
  const first = invocation(sent, {
    async run() {
      return { kind: "completed" };
    },
  });
  await first.runtime.queue(
    delivery({ schemaVersion: 1, jobId: `job-${user}` }).batch,
  );
  const second = invocation(sent);
  await second.runtime.queue(
    delivery({ schemaVersion: 1, jobId: `job-${user}` }).batch,
  );
  for (const malformed of [
    { schemaVersion: 1, dispatch: true, extra: 1 },
    { schemaVersion: 1, dispatch: false },
    { schemaVersion: 2, dispatch: true },
  ])
    await invocation(sent).runtime.queue(delivery(malformed).batch);
  expect(sent).toEqual([wakeup]);
});
it("wake send failure leaves committed work and Cron-recoverable durable follow-up intact", async () => {
  const user = await seed(),
    sent: unknown[] = [];
  await env.DB.prepare(
    "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES(?,?,?,?,1,'source-extract',?,'ready',0)",
  )
    .bind(
      `follow-${user}`,
      user,
      `connection-${user}`,
      `consent-${user}`,
      `follow-${user}`,
    )
    .run();
  const current = invocation(
    sent,
    {
      async run() {
        return { kind: "completed" };
      },
    },
    true,
  );
  const first = delivery({ schemaVersion: 1, jobId: `job-${user}` });
  await current.runtime.queue(first.batch);
  expect(first.ack).toHaveBeenCalledOnce();
  expect(first.retry).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare("SELECT status FROM jobs WHERE id=?")
      .bind(`job-${user}`)
      .first("status"),
  ).toBe("completed");
  expect(sent).toEqual([]);
  await invocation(sent).runtime.scheduled();
  expect(sent).toEqual([{ schemaVersion: 1, jobId: `follow-${user}` }]);
});
it("unsettled retries and lease contention never trigger dispatch wakeups", async () => {
  const user = await seed(),
    sent: unknown[] = [];
  const retry = invocation(sent, {
    async run() {
      return { kind: "retry", code: "transient" };
    },
  });
  const first = delivery({ schemaVersion: 1, jobId: `job-${user}` });
  await retry.runtime.queue(first.batch);
  expect(first.retry).toHaveBeenCalledOnce();
  expect(sent).toEqual([]);
  const lease = await invocation(sent).store.claim(`job-${user}`);
  expect(lease).toBeNull();
  await invocation(sent).runtime.queue(
    delivery({ schemaVersion: 1, jobId: `job-${user}` }).batch,
  );
  expect(sent).toEqual([]);
});
it("a duplicate delivery cannot wake dispatch while another invocation holds its lease", async () => {
  const user = await seed(),
    sent: unknown[] = [];
  const held = await invocation(sent).store.claim(`job-${user}`);
  expect(held).not.toBeNull();
  const duplicate = delivery({ schemaVersion: 1, jobId: `job-${user}` });
  await invocation(sent).runtime.queue(duplicate.batch);
  expect(duplicate.retry).toHaveBeenCalledOnce();
  expect(duplicate.ack).not.toHaveBeenCalled();
  expect(sent).toEqual([]);
});
