import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AuthBindings, LoginConfiguration } from "@invoxim/adapters";
import { createLoginAuth } from "@invoxim/adapters";
import type { JobPolicy, TenantContext } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import {
  classifyManualSync,
  createJobStore,
} from "../../../packages/adapters/src/jobs/store";
import worker from "../src/index";
import { createJobRuntime } from "../src/job-runtime";
import { faultingDatabase, statementCounter } from "./support/faults";

const db = env.DB;

const configuration: LoginConfiguration = {
  origin: "https://synthetic.example",
  secret: "synthetic-jobs-qa-secret-never-production-12345",
  googleClientId: "synthetic-client",
  googleClientSecret: "synthetic-client-secret",
  allowedEmails: ["jobs-a@example.invalid", "jobs-b@example.invalid"],
};
const bindings: AuthBindings = {
  DB: env.DB,
  AUTH_ENABLED: "true",
  AUTH_ORIGIN: configuration.origin,
  AUTH_SECRET: configuration.secret,
  AUTH_GOOGLE_CLIENT_ID: configuration.googleClientId,
  AUTH_GOOGLE_CLIENT_SECRET: configuration.googleClientSecret,
  AUTH_ALLOWED_EMAILS: JSON.stringify(configuration.allowedEmails),
};
let cookie: string;
beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
  for (const id of ["jobs-a", "jobs-b"]) {
    await db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
      )
      .bind(id, id, `${id}@example.invalid`)
      .run();
    await db
      .prepare(
        "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
      )
      .bind(id)
      .run();
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,credential_ciphertext,credential_key_version) VALUES(?,?,'mailbox','gmail',?,?,'synthetic-envelope',1)",
      )
      .bind(
        `connection-${id}`,
        id,
        `mailbox-${id}`,
        `${id}-mailbox@example.invalid`,
      )
      .run();
  }
  // SQL-seeded synthetic users exercise actual library session verification, not a live login.
  const context = await createLoginAuth(db, configuration).$context;
  const session = await context.internalAdapter.createSession("jobs-a", false);
  if (!session) throw new Error("Synthetic session unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(configuration.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(session.token),
  );
  cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
});

it.each([
  ["connection-jobs-a", {}, 409, "review_required"],
  ["connection-jobs-b", {}, 404, "not_found"],
  ["connection-jobs-a", { userId: "jobs-b" }, 400, "invalid_request"],
] as const)(
  "manual sync %s respects explicit review and tenant authority",
  async (id, body, status, code) => {
    const response = await worker.fetch(
      new Request(`${configuration.origin}/api/connections/${id}/sync`, {
        method: "POST",
        headers: {
          cookie,
          origin: configuration.origin,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      bindings,
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(
      await db.prepare("SELECT COUNT(*) AS count FROM jobs").first("count"),
    ).toBe(0);
  },
);

const syntheticQueue: Queue<{ schemaVersion: 1; jobId: string }> = {
  async send() {
    throw new Error("Unexpected queue send from the manual sync route");
  },
  async sendBatch() {
    throw new Error("Unexpected synthetic batch send");
  },
  async metrics() {
    throw new Error("Unexpected synthetic queue metrics");
  },
};
const jobBindings = {
  ...bindings,
  JOBS_ENABLED: "true",
  JOBS: syntheticQueue,
};
async function manualSyncRoute(id: string, routeBindings: object) {
  return worker.fetch(
    new Request(`${configuration.origin}/api/connections/${id}/sync`, {
      method: "POST",
      headers: {
        cookie,
        origin: configuration.origin,
        "content-type": "application/json",
      },
      body: "{}",
    }),
    routeBindings,
  );
}
/** A jobs-a mailbox with live background consent; only the given states vary. */
async function jobsAMailbox(
  id: string,
  schedulingState: "awaiting_import" | "active" | "paused",
  state = "connected",
) {
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state,scheduling_state,credential_ciphertext,credential_key_version) VALUES(?,'jobs-a','mailbox','gmail',?,?,?,?,'synthetic-envelope',1)",
    )
    .bind(id, `subject-${id}`, `${id}@example.invalid`, state, schedulingState)
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES(?,'jobs-a',?,1,'synthetic','synthetic',1,0,1)",
    )
    .bind(`consent-${id}`, id)
    .run();
}

it.each([
  ["w14-paused", "paused", "connected"],
  ["w14-awaiting", "awaiting_import", "connected"],
  ["w14-disconnected", "active", "disconnected"],
] as const)(
  "W14: manual sync of %s with live consent is review-required with or without jobs configured",
  async (id, schedulingState, state) => {
    await jobsAMailbox(id, schedulingState, state);
    for (const routeBindings of [bindings, jobBindings]) {
      const response = await manualSyncRoute(id, routeBindings);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "review_required" },
      });
    }
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM jobs WHERE connection_id=?")
        .bind(id)
        .first("count"),
    ).toBe(0);
  },
);

it("W14: a configured manual sync reads connection ownership and eligibility once", async () => {
  await jobsAMailbox("w14-live", "active");
  const reads = faultingDatabase(db, [
    {
      match: (sql) => /^SELECT\b/.test(sql) && /\bFROM connections\b/.test(sql),
      on: "first",
      once: false,
      fire: ({ proceed }) => proceed(),
    },
  ]);
  const response = await manualSyncRoute("w14-live", {
    ...jobBindings,
    DB: reads.db,
  });
  expect(response.status).toBe(202);
  expect(reads.fireCounts[0]).toBe(1);
});

it("W14: store.manualSync classifies missing, foreign and non-live mailboxes in one statement", async () => {
  const ctx = await tenant("w14-store");
  await db
    .prepare("UPDATE connections SET scheduling_state='paused' WHERE id=?")
    .bind(`conn-${ctx.userId}`)
    .run();
  for (const [id, kind] of [
    [`conn-${ctx.userId}`, "review-required"],
    ["conn-w14-missing", "not-found"],
    ["connection-jobs-b", "not-found"],
  ] as const) {
    const { db: measured, count } = statementCounter(db);
    expect(
      await createJobStore(measured, {
        policy,
        clock: () => instant,
      }).manualSync(ctx, id),
    ).toEqual({ kind });
    expect(count()).toBe(1);
  }
});

it("W14: an empty ownership read fails closed instead of reporting eligible", async () => {
  const empty = {
    prepare: () => ({ bind: () => ({ first: async () => null }) }),
  } as unknown as D1Database;
  expect(
    await classifyManualSync(empty, "jobs-a", "connection-jobs-a"),
  ).toEqual({ kind: "not-found" });
  expect(
    await createJobStore(empty, { policy }).manualSync(
      { userId: "jobs-a", authority: "session" } as TenantContext,
      "connection-jobs-a",
    ),
  ).toEqual({ kind: "not-found" });
});

const policy: JobPolicy = {
  dispatchLimit: 2,
  scheduleLimit: 2,
  tenantConcurrency: 1,
  globalConcurrency: 2,
  maxAttempts: 3,
  leaseMs: 1000,
  redeliveryMs: 2000,
};
let instant = Date.now();
const store = () => createJobStore(db, { policy, clock: () => instant });
async function tenant(name: string) {
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
    )
    .bind(name, name, `${name}@example.invalid`)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind(name)
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state,credential_ciphertext,credential_key_version) VALUES(?,?,'mailbox','gmail',?,?,'active','synthetic-envelope',1)",
    )
    .bind(
      `conn-${name}`,
      name,
      `subject-${name}`,
      `${name}-mailbox@example.invalid`,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES(?,?,?,1,'synthetic','synthetic',1,0,1)",
    )
    .bind(`consent-${name}`, name, `conn-${name}`)
    .run();
  return { userId: name, authority: "session" } as TenantContext;
}
async function enqueue(context: TenantContext, id: string) {
  return store().enqueue(context, {
    id,
    connectionId: `conn-${context.userId}`,
    consentId: `consent-${context.userId}`,
    generation: 1,
    dedupeKey: id,
    type: "synthetic",
    priority: 1,
  });
}

it("parallel distinct jobs respect atomic tenant and global lease caps", async () => {
  const a = await tenant("caps-a"),
    b = await tenant("caps-b"),
    c = await tenant("caps-c");
  for (const [ctx, id] of [
    [a, "caps-a-1"],
    [a, "caps-a-2"],
    [b, "caps-b-1"],
    [c, "caps-c-1"],
  ] as const)
    await enqueue(ctx, id);
  const leases = await Promise.all(
    ["caps-a-1", "caps-a-2", "caps-b-1", "caps-c-1"].map((id) =>
      store().claim(id),
    ),
  );
  expect(leases.filter(Boolean)).toHaveLength(2);
  expect(
    leases.filter((lease) => lease?.context.userId === a.userId),
  ).toHaveLength(1);
  for (const lease of leases)
    if (lease)
      expect(await store().finish(lease, { kind: "completed" })).toBe(true);
});

it("expired reassigned ownership rejects every old checkpoint and completion", async () => {
  const ctx = await tenant("fence-a");
  await enqueue(ctx, "fence-job");
  const old = await store().claim("fence-job");
  expect(old).not.toBeNull();
  if (!old) throw new Error("No lease");
  instant += 1001;
  const fresh = await store().claim("fence-job");
  expect(fresh).not.toBeNull();
  if (!fresh) throw new Error("No reassigned lease");
  expect(fresh.fence).toBe(old.fence + 1);
  expect(await store().checkpoint(old)).toBe(false);
  expect(await store().finish(old, { kind: "completed" })).toBe(false);
  expect(await store().checkpoint(fresh)).toBe(true);
  expect(await store().finish(fresh, { kind: "completed" })).toBe(true);
});

it("lost queue delivery becomes a D1 dispatch candidate again after its deadline", async () => {
  const ctx = await tenant("lost-a");
  await enqueue(ctx, "lost-job");
  // Isolate the candidate page from other tests' intentionally pending jobs.
  await db
    .prepare(
      "UPDATE scheduler_cursors SET last_user_id='lost-0' WHERE kind='dispatch'",
    )
    .run();
  const candidate = (await store().candidates()).find(
    (row) => row.jobId === "lost-job",
  );
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("No candidate");
  expect(await store().dispatched(candidate)).toBe(true);
  await db
    .prepare(
      "UPDATE scheduler_cursors SET last_user_id='lost-0' WHERE kind='dispatch'",
    )
    .run();
  expect(
    (await store().candidates()).some((row) => row.jobId === "lost-job"),
  ).toBe(false);
  instant += 2001;
  await db
    .prepare(
      "UPDATE scheduler_cursors SET last_user_id='lost-0' WHERE kind='dispatch'",
    )
    .run();
  expect(
    (await store().candidates()).some((row) => row.jobId === "lost-job"),
  ).toBe(true);
});

it("hot tenant backlog cannot consume the cold tenant's dispatch slot", async () => {
  const hot = await tenant("fair-a"),
    cold = await tenant("fair-b");
  for (let i = 0; i < 3; i++) await enqueue(hot, `fair-hot-${i}`);
  await enqueue(cold, "fair-cold");
  await db
    .prepare(
      "UPDATE scheduler_cursors SET last_user_id='fair-0' WHERE kind='dispatch'",
    )
    .run();
  const candidates = await store().candidates();
  expect(candidates.map((row) => row.context.userId).sort()).toEqual([
    hot.userId,
    cold.userId,
  ]);
  expect(candidates).toHaveLength(2);
});

it("disconnect generation changes invalidate in-flight authority and cancel durable work", async () => {
  const ctx = await tenant("disconnect-a");
  await enqueue(ctx, "disconnect-job");
  const lease = await store().claim("disconnect-job");
  if (!lease) throw new Error("No lease");
  await db
    .prepare(
      "UPDATE connections SET generation=generation+1,state='disconnected' WHERE user_id=?",
    )
    .bind(ctx.userId)
    .run();
  expect(await store().checkpoint(lease)).toBe(false);
  expect(await store().finish(lease, { kind: "completed" })).toBe(false);
  await db
    .prepare(
      "UPDATE scheduler_cursors SET last_user_id='disconnect-0' WHERE kind='recovery'",
    )
    .run();
  await store().recover();
  expect(
    await db
      .prepare("SELECT status FROM jobs WHERE id='disconnect-job'")
      .first("status"),
  ).toBe("canceled");
});

it("retry attempt exhaustion yields one terminal row and cannot be reclaimed", async () => {
  const ctx = await tenant("terminal-a");
  await enqueue(ctx, "terminal-job");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const lease = await store().claim("terminal-job");
    if (!lease) throw new Error("No lease");
    expect(lease.attempt).toBe(attempt);
    expect(
      await store().finish(lease, { kind: "retry", code: "transient" }),
    ).toBe(true);
    instant += 5000;
  }
  expect(await store().claim("terminal-job")).toBeNull();
  expect(
    await db
      .prepare(
        "SELECT status,outcome_code,retry_count FROM jobs WHERE id='terminal-job'",
      )
      .first(),
  ).toMatchObject({
    status: "terminal",
    outcome_code: "attempts-exhausted",
    retry_count: 3,
  });
});

it("a foreign connection or revoked consent cannot enqueue or acquire job authority", async () => {
  const a = await tenant("ownership-a"),
    b = await tenant("ownership-b");
  expect(
    await store().enqueue(a, {
      id: "foreign-job",
      connectionId: `conn-${b.userId}`,
      consentId: `consent-${b.userId}`,
      generation: 1,
      dedupeKey: "foreign-job",
      type: "synthetic",
    }),
  ).toBe(false);
  await enqueue(a, "revoked-job");
  await db
    .prepare("UPDATE processing_consents SET revoked_at=? WHERE user_id=?")
    .bind(instant, a.userId)
    .run();
  expect(await store().claim("revoked-job")).toBeNull();
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE id='foreign-job'")
      .first("count"),
  ).toBe(0);
});

function batch(jobId: string, messageId: string) {
  return createMessageBatch("synthetic-jobs", [
    {
      id: messageId,
      timestamp: new Date(),
      attempts: 1,
      body: { schemaVersion: 1, jobId },
    },
  ]);
}
it("disabled queue ACK preserves the D1 outbox for later enabled dispatch", async () => {
  const ctx = await tenant("disabled-a");
  await enqueue(ctx, "disabled-job");
  const delivery = batch("disabled-job", "disabled-message");
  await worker.queue(delivery, { JOBS_ENABLED: "false" });
  const result = await getQueueResult(delivery, createExecutionContext());
  expect(result.ackAll).toBe(true);
  expect(
    await db
      .prepare("SELECT status,retry_count FROM jobs WHERE id='disabled-job'")
      .first(),
  ).toMatchObject({ status: "ready", retry_count: 0 });
  await db
    .prepare(
      "UPDATE scheduler_cursors SET last_user_id='disabled-0' WHERE kind='dispatch'",
    )
    .run();
  const deliveries: unknown[] = [];
  await createJobRuntime({
    store: store(),
    queue: {
      async send(body) {
        deliveries.push(body);
      },
    },
  }).scheduled();
  expect(deliveries).toContainEqual({
    schemaVersion: 1,
    jobId: "disabled-job",
  });
});

it("no-handler lease expiry before durable finish retries delivery instead of ACK", async () => {
  const ctx = await tenant("pause-a");
  await enqueue(ctx, "pause-job");
  const durable = store();
  const runtime = createJobRuntime({
    store: {
      ...durable,
      async finish(lease, outcome) {
        instant += 1001;
        return durable.finish(lease, outcome);
      },
    },
    queue: { async send() {} },
  });
  const delivery = batch("pause-job", "pause-message");
  await runtime.queue(delivery);
  const result = await getQueueResult(delivery, createExecutionContext());
  expect(result.explicitAcks).toEqual([]);
  expect(result.retryMessages).toHaveLength(1);
  expect(
    await db
      .prepare("SELECT status FROM jobs WHERE id='pause-job'")
      .first("status"),
  ).toBe("leased");
});

it("crash after atomic accepted-source commit ACKs replay without duplicating money", async () => {
  const ctx = await tenant("commit-a");
  await enqueue(ctx, "commit-job");
  const runtime = createJobRuntime({
    store: store(),
    queue: { async send() {} },
    handler: {
      async run(lease) {
        // Simulate an atomic financial batch: one ledger entry per delivery.
        const existing = await db
          .prepare(
            "SELECT COUNT(*) AS count FROM ledger_entries WHERE user_id=? AND business_event_key='commit-event'",
          )
          .bind(lease.context.userId)
          .first<number>("count");
        if (!existing) {
          await db
            .prepare(
              "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('commit-purchase',?,'Synthetic merchant','synthetic merchant','2026-10-01',1200,'EUR','paid')",
            )
            .bind(lease.context.userId)
            .run();
          await db
            .prepare(
              "INSERT INTO ledger_entries(id,user_id,purchase_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('commit-entry',?,'commit-purchase','commit-event','payment',1200,'EUR','2026-10-01','document-date',1,'user-confirmed')",
            )
            .bind(lease.context.userId)
            .run();
        }
        await db
          .prepare(
            "UPDATE jobs SET status='completed',outcome_code='committed' WHERE user_id=? AND id=? AND lease_id=? AND fence=?",
          )
          .bind(lease.context.userId, lease.jobId, lease.leaseId, lease.fence)
          .run();
        throw new Error("Synthetic crash after committed financial batch");
      },
    },
  });
  for (const messageId of ["commit-first", "commit-replay"]) {
    const delivery = batch("commit-job", messageId);
    await runtime.queue(delivery);
    const result = await getQueueResult(delivery, createExecutionContext());
    expect(result.explicitAcks).toEqual([messageId]);
    expect(result.retryMessages).toEqual([]);
  }
  expect(
    await db
      .prepare("SELECT status,retry_count FROM jobs WHERE id='commit-job'")
      .first(),
  ).toMatchObject({ status: "completed", retry_count: 1 });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE user_id=?")
      .bind(ctx.userId)
      .first("count"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT CAST(amount_minor AS TEXT) AS minor FROM ledger_entries WHERE user_id=?",
      )
      .bind(ctx.userId)
      .first("minor"),
  ).toBe("1200");
});

it("one Cron invocation stays within its D1 query cap and later invocations visit the remaining tenants", async () => {
  const owners = [];
  for (const suffix of ["a", "b", "c", "d"]) {
    const ctx = await tenant(`budget-${suffix}`);
    owners.push(ctx);
    await enqueue(ctx, `budget-job-${suffix}`);
  }
  await db
    .prepare(
      "UPDATE scheduler_cursors SET last_user_id='budget-0' WHERE kind='dispatch'",
    )
    .run();
  const sent: string[] = [];
  for (let invocation = 0; invocation < 6; invocation++) {
    const { db: measured, count } = statementCounter(db);
    await createJobRuntime({
      store: createJobStore(measured, {
        policy: {
          ...policy,
          dispatchLimit: 50,
          scheduleLimit: 50,
          queryLimit: 16,
        },
        clock: () => instant,
      }),
      queue: {
        async send(body) {
          sent.push(body.jobId);
        },
      },
      clock: () => instant,
    }).scheduled();
    expect(count()).toBeLessThanOrEqual(16);
  }
  for (const owner of owners)
    expect(sent).toContain(`budget-job-${owner.userId.at(-1)}`);
});
it("valid ready rows cannot hide an expired exhausted lease from recovery", async () => {
  const ctx = await tenant("prefix-a");
  for (const id of ["prefix-0", "prefix-1", "prefix-2", "prefix-zzz"])
    await enqueue(ctx, id);
  await db
    .prepare(
      "UPDATE jobs SET status='leased',retry_count=3,lease_id='synthetic-expired-owner',lease_expires_at=? WHERE id='prefix-zzz'",
    )
    .bind(instant - 1)
    .run();
  await store().recover();
  expect(
    await db
      .prepare("SELECT status,outcome_code FROM jobs WHERE id='prefix-zzz'")
      .first(),
  ).toMatchObject({ status: "terminal", outcome_code: "attempts-exhausted" });
});
it("concurrent manual sync calls create only one pending incremental job", async () => {
  const ctx = await tenant("manual-a");
  const results = await Promise.all([
    store().manualSync(ctx, `conn-${ctx.userId}`),
    store().manualSync(ctx, `conn-${ctx.userId}`),
  ]);
  expect(results.some((result) => result.kind === "queued")).toBe(true);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE user_id=? AND type='sync' AND status IN ('ready','leased','retry_wait')",
      )
      .bind(ctx.userId)
      .first("count"),
  ).toBe(1);
});

it("new hourly sync reports its committed job and advances the scheduling cursor within budget", async () => {
  const owner = await tenant("schedule-a");
  await db
    .prepare(
      "UPDATE scheduler_cursors SET last_user_id='schedule-0' WHERE kind='schedule'",
    )
    .run();
  const scheduled = await store().scheduleDue();
  const committed = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE user_id=? AND type='sync'",
    )
    .bind(owner.userId)
    .first<number>("count");
  expect(committed).toBe(1);
  expect(scheduled).toBe(committed);
  expect(
    await db
      .prepare(
        "SELECT last_user_id FROM scheduler_cursors WHERE kind='schedule'",
      )
      .first("last_user_id"),
  ).toBe(owner.userId);
});

it("a due connection with existing pending sync does not stall the scheduling cursor", async () => {
  const owner = await tenant("pending-a");
  await store().manualSync(owner, `conn-${owner.userId}`);
  await db
    .prepare("UPDATE connections SET next_sync_at=0 WHERE user_id=?")
    .bind(owner.userId)
    .run();
  await db
    .prepare(
      "UPDATE scheduler_cursors SET last_user_id='pending-0' WHERE kind='schedule'",
    )
    .run();
  await store().scheduleDue();
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE user_id=? AND type='sync'",
      )
      .bind(owner.userId)
      .first("count"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT last_user_id FROM scheduler_cursors WHERE kind='schedule'",
      )
      .first("last_user_id"),
  ).toBe(owner.userId);
});
