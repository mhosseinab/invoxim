import { env } from "cloudflare:workers";
import type { JobPolicy } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { createJobEngine } from "../../../packages/core/src/jobs/engine";
import { createInvocationDatabase } from "../src/invocation-database";

const policy: JobPolicy = {
  dispatchLimit: 1,
  scheduleLimit: 1,
  tenantConcurrency: 2,
  globalConcurrency: 20,
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
async function workspace(
  id: string,
  jobs: readonly { id: string; type: string; priority: number }[],
) {
  await env.DB.prepare(
    "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)",
  )
    .bind(id, "Synthetic", `${id}@example.invalid`)
    .run();
  await env.DB.prepare(
    "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
  )
    .bind(id)
    .run();
  await env.DB.prepare(
    "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state,next_sync_at,credential_ciphertext,credential_key_version) VALUES(?,?,'mailbox','gmail',?,?,'active',9999999999999,'synthetic-envelope',1)",
  )
    .bind(`connection-${id}`, id, id, `${id}@example.invalid`)
    .run();
  await env.DB.prepare(
    "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES(?,?,?,1,'synthetic','local',0,0,1)",
  )
    .bind(`consent-${id}`, id, `connection-${id}`)
    .run();
  for (const job of jobs)
    await env.DB.prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,priority) VALUES(?,?,?,?,1,?,?,'ready',0,?)",
    )
      .bind(
        job.id,
        id,
        `connection-${id}`,
        `consent-${id}`,
        job.type,
        job.id,
        job.priority,
      )
      .run();
}
async function tick(at: number) {
  const meter = createInvocationDatabase(env.DB, 40);
  const sent: string[] = [];
  const engine = createJobEngine({
    store: createJobStore(meter.db, {
      processingReview: null,
      policy,
      clock: () => at,
    }),
    queue: {
      async send(body) {
        sent.push(body.jobId);
      },
    },
    clock: () => at,
  });
  const result = await engine.dispatch();
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  expect(result.sent).toBe(sent.length);
  return sent;
}

it("Single active workspace dispatches discovery then source extraction on consecutive Cron ticks without an idle wrap", async () => {
  await workspace("cursor-single", [
    { id: "cursor-discovery", type: "discover", priority: 0 },
    { id: "cursor-extraction", type: "source-extract", priority: 1 },
  ]);
  expect(await tick(1000)).toEqual(["cursor-discovery"]);
  const before = await env.DB.prepare(
    "SELECT version FROM scheduler_cursors WHERE kind='dispatch'",
  ).first<number>("version");
  expect(await tick(2000)).toEqual(["cursor-extraction"]);
  expect(
    await env.DB.prepare(
      "SELECT last_user_id,version FROM scheduler_cursors WHERE kind='dispatch'",
    ).first(),
  ).toEqual({ last_user_id: "cursor-single", version: (before ?? 0) + 1 });
});

it("Dispatch cursor wraps fairly through active workspaces without revisiting a workspace twice in one bounded page", async () => {
  for (const suffix of ["a", "b", "c"])
    await workspace(`cursor-fair-${suffix}`, [
      { id: `cursor-fair-job-${suffix}`, type: "source-extract", priority: 1 },
    ]);
  await workspace("cursor-fair-inactive", [
    { id: "cursor-fair-inactive-job", type: "discover", priority: 0 },
  ]);
  await env.DB.prepare(
    "UPDATE profiles SET status='deleting' WHERE user_id='cursor-fair-inactive'",
  ).run();
  const sent: string[] = [];
  for (let invocation = 0; invocation < 6; invocation++) {
    const current = await tick(1000 + invocation * 60001);
    expect(current).toHaveLength(1);
    sent.push(...current);
  }
  expect(sent).toEqual([
    "cursor-fair-job-a",
    "cursor-fair-job-b",
    "cursor-fair-job-c",
    "cursor-fair-job-a",
    "cursor-fair-job-b",
    "cursor-fair-job-c",
  ]);
});

it("A page crossing the end returns the remaining workspace and wrapped workspace once each within the same tick", async () => {
  for (const suffix of ["a", "b", "c"])
    await workspace(`cursor-page-${suffix}`, [
      { id: `cursor-page-job-${suffix}`, type: "discover", priority: 0 },
    ]);
  await env.DB.prepare(
    "UPDATE scheduler_cursors SET last_user_id='cursor-page-b' WHERE kind='dispatch'",
  ).run();
  const meter = createInvocationDatabase(env.DB, 40);
  const store = createJobStore(meter.db, {
    processingReview: null,
    policy: { ...policy, dispatchLimit: 2 },
    clock: () => 1000,
  });
  const candidates = await store.candidates();
  expect(candidates.map((candidate) => candidate.jobId)).toEqual([
    "cursor-page-job-c",
    "cursor-page-job-a",
  ]);
  expect(
    new Set(candidates.map((candidate) => candidate.context.userId)).size,
  ).toBe(2);
  expect(meter.executedStatements()).toBeLessThanOrEqual(6);
});
