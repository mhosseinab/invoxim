import { env } from "cloudflare:workers";
import {
  createJobEngine,
  OnboardingError,
  type OnboardingSession,
} from "@invoxim/core";
import { expect, it } from "vitest";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { createProcessingReviewResolver } from "../../../packages/adapters/src/onboarding/processing-readiness";
import worker from "../src/index";
import { createInvocationDatabase } from "../src/invocation-database";
import { syntheticClassificationBindings } from "./classification-fixture";
import {
  configuredAi,
  installOnboardingQaHooks,
  now,
  owner,
  query,
  runtime,
  startBody,
} from "./onboarding-qa-fixture";

installOnboardingQaHooks();

const db = env.DB;

it("ONBOARD-04/06 preStart review discloses selected B and exact DST interval without consent/jobs/provider access", async () => {
  const session = await owner("qa-onboard-before"),
    run = runtime();
  const disclosure = await run.usecases.disclosure(session, query);
  expect(disclosure).toMatchObject({
    mailboxAddress: "selected-b@example.invalid",
    loginEmail: session.loginEmail,
    startAt: "2025-03-29T23:00:00.000Z",
    cutoffAt: "2026-03-29T22:00:00.000Z",
    timezone: "Europe/Vienna",
    reportingCurrency: "EUR",
    canStartImport: true,
  });
  expect(run.opens()).toBe(0);
  for (const table of [
    "processing_consents",
    "import_runs",
    "jobs",
    "sync_states",
  ])
    expect(
      await db
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`)
        .bind(session.tenant.userId)
        .first("n"),
    ).toBe(0);
  expect(run.meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("ONBOARD-09 unchanged provider/model labels cannot approve a changed endpoint/retention recipient", async () => {
  const session = await owner("qa-onboard-recipient"),
    initial = runtime();
  const shown = await initial.usecases.disclosure(session, query);
  const changed = runtime(
    undefined,
    configuredAi(
      "https://changed-recipient.example.invalid/v1/chat/completions",
      "qa-retention-b",
    ),
  );
  await expect(
    changed.usecases.start(session, startBody(shown), "qa-stale-recipient-key"),
  ).rejects.toThrow("PROCESSING_REVIEW_REQUIRED");
  expect(changed.opens()).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM processing_consents WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(0);
});
it("ONBOARD-07 two keys and replay never create another durable parent consent or hourly schedule", async () => {
  const session = await owner("qa-onboard-double"),
    review = await runtime().usecases.disclosure(session, query),
    body = startBody(review);
  const first = await runtime().usecases.start(
    session,
    body,
    "qa-first-start-key",
  );
  expect(
    (await runtime().usecases.start(session, body, "qa-first-start-key"))
      .importRunId,
  ).toBe(first.importRunId);
  try {
    expect(
      (await runtime().usecases.start(session, body, "qa-second-start-key"))
        .importRunId,
    ).toBe(first.importRunId);
  } catch (cause) {
    if (!(cause instanceof OnboardingError) || cause.code !== "CONFLICT")
      throw cause;
  }
  for (const table of ["processing_consents", "import_runs"])
    expect(
      await db
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`)
        .bind(session.tenant.userId)
        .first("n"),
    ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM sync_states WHERE user_id=? AND sync_kind='incremental'",
      )
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM sync_states WHERE user_id=? AND sync_kind='backfill'",
      )
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(2);
  await expect(
    runtime().usecases.start(
      session,
      { ...body, reportingCurrency: "USD" },
      "qa-first-start-key",
    ),
  ).rejects.toThrow("CONFLICT");
});
it("ONBOARD-07 native failed run insert rolls back consent, hosted initialization, commands and schedule", async () => {
  const session = await owner("qa-onboard-rollback"),
    review = await runtime().usecases.disclosure(session, query);
  await db
    .prepare(
      "CREATE TRIGGER qa_abort_onboard BEFORE INSERT ON import_runs WHEN NEW.user_id='qa-onboard-rollback' BEGIN SELECT RAISE(ABORT,'synthetic run failure'); END",
    )
    .run();
  await expect(
    runtime().usecases.start(
      session,
      startBody(review),
      "qa-rollback-start-key",
    ),
  ).rejects.toThrow();
  for (const table of [
    "processing_consents",
    "import_runs",
    "sync_states",
    "jobs",
    "onboarding_commands",
    "ai_settings",
  ])
    expect(
      await db
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`)
        .bind(session.tenant.userId)
        .first("n"),
    ).toBe(0);
  expect(
    await db
      .prepare("SELECT scheduling_state FROM connections WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("scheduling_state"),
  ).toBe("awaiting_import");
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  await db.prepare("DROP TRIGGER qa_abort_onboard").run();
  // A valid, unrelated native batch must still commit after a rejected batch.
  // This separates transaction recovery from onboarding's token/lease guards.
  await db.batch([
    db.prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('qa-after-abort','QA recovery','qa-after-abort@example.invalid',1,0,0)",
    ),
    db.prepare(
      "INSERT INTO profiles(user_id,timezone,reporting_currency,created_at,updated_at) VALUES('qa-after-abort','UTC','EUR',0,0)",
    ),
  ]);
  expect(
    await db
      .prepare("SELECT timezone FROM profiles WHERE user_id='qa-after-abort'")
      .first("timezone"),
  ).toBe("UTC");
  const recovered = await owner(
      "qa-onboard-after-abort",
      "qa-recovered-mailbox",
    ),
    freshReview = await runtime().usecases.disclosure(recovered, {
      ...query,
      connectionId: "qa-recovered-mailbox",
    });
  expect(
    (
      await runtime().usecases.start(
        recovered,
        startBody(freshReview),
        "qa-recovered-start-key",
      )
    ).importRunId,
  ).toBeTruthy();
});

it("ONBOARD-04/09 old A review token cannot authorize B with colliding mailbox ID and generation", async () => {
  const a = await owner("qa-onboard-token-a"),
    b = await owner("qa-onboard-token-b");
  const old = await runtime().usecases.disclosure(a, query),
    fresh = await runtime().usecases.disclosure(b, query);
  const wrong = runtime();
  await expect(
    wrong.usecases.start(b, startBody(old), "qa-cross-workspace-key"),
  ).rejects.toThrow("PROCESSING_REVIEW_REQUIRED");
  expect(wrong.opens()).toBe(0);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  expect(
    (
      await runtime().usecases.start(
        b,
        startBody(fresh),
        "qa-own-workspace-key",
      )
    ).importRunId,
  ).toBeTruthy();
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM import_runs WHERE user_id=?")
      .bind(a.tenant.userId)
      .first("n"),
  ).toBe(0);
});

it("RECENT-05 metadata anchor delay records the exact recovery gap without dropping the frozen full range", async () => {
  const session = await owner("qa-onboard-anchor-gap");
  let observedClock = now;
  const review = await runtime(
    undefined,
    configuredAi(),
    () => observedClock,
  ).usecases.disclosure(session, { ...query, endDate: "2026-03-30" });
  expect(review.cutoffAt).toBe("2026-03-30T12:00:00.000Z");
  const start = runtime(
    undefined,
    configuredAi(),
    () => observedClock,
    async () => {
      observedClock = now + 60000;
      return "98765";
    },
  );
  const result = await start.usecases.start(
    session,
    startBody(review),
    "qa-delayed-anchor-key",
  );
  expect(start.meter.executedStatements()).toBeLessThanOrEqual(40);
  expect(start.opens()).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT frozen_start,frozen_cutoff,recovery_anchor,stage FROM sync_states WHERE user_id=? AND sync_kind='incremental'",
      )
      .bind(session.tenant.userId)
      .first(),
  ).toEqual({
    frozen_start: "2026-03-30T12:00:00.000Z",
    frozen_cutoff: "2026-03-30T12:01:00.000Z",
    recovery_anchor: "98765",
    stage: "recovering",
  });
  expect(
    await db
      .prepare(
        "SELECT frozen_start,frozen_cutoff FROM import_runs WHERE user_id=? AND id=?",
      )
      .bind(session.tenant.userId, result.importRunId)
      .first(),
  ).toEqual({
    frozen_start: "2025-03-29T23:00:00.000Z",
    frozen_cutoff: "2026-03-30T12:00:00.000Z",
  });
});

it("ONBOARD-09 same policy ID cannot hide changed readable retention terms or privacy URL", async () => {
  const session = await owner("qa-onboard-readable-policy"),
    shown = await runtime().usecases.disclosure(session, query);
  const changed = runtime(
    undefined,
    configuredAi(
      "https://qa-onboard-model.example.invalid/v1/chat/completions",
      "qa-retention-a",
      "Synthetic retention policy B",
      "https://policies.example.invalid/synthetic-b",
    ),
  );
  await expect(
    changed.usecases.start(session, startBody(shown), "qa-readable-policy-key"),
  ).rejects.toThrow("PROCESSING_REVIEW_REQUIRED");
  expect(changed.opens()).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM processing_consents WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(0);
});

it("ONBOARD-07 signed read works but every Start POST requires exact Origin before parsing", async () => {
  const session = await owner("qa-onboard-origin"),
    origin = "https://qa-onboarding.example.invalid",
    secret = "synthetic-onboarding-auth-secret-never-live-123";
  const token = `synthetic-${session.tenant.userId}`,
    key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
  const app = worker,
    bindings = {
      DB: env.DB,
      AUTH_ENABLED: "true",
      AUTH_ORIGIN: origin,
      AUTH_SECRET: secret,
      AUTH_GOOGLE_CLIENT_ID: "synthetic",
      AUTH_GOOGLE_CLIENT_SECRET: "synthetic",
      AUTH_ALLOWED_EMAILS: JSON.stringify([session.loginEmail]),
    };
  const read = await app.fetch(
    new Request(`${origin}/api/onboarding`, { headers: { Cookie: cookie } }),
    bindings,
  );
  expect(read.status).toBe(200);
  expect(read.headers.get("Cache-Control")).toBe("no-store");
  async function post(originHeader?: string) {
    return app.fetch(
      new Request(`${origin}/api/onboarding/start-import`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          "Idempotency-Key": "qa-missing-origin-key",
          ...(originHeader ? { Origin: originHeader } : {}),
        },
        body: "{}",
      }),
      bindings,
    );
  }
  expect((await post()).status).toBe(403);
  expect((await post("https://hostile.example.invalid")).status).toBe(403);
  expect((await post(origin)).status).toBe(400);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM processing_consents WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(0);
});

it("ONBOARD-09 AI settings reject old A workspace token with current B session despite identical versions", async () => {
  const a = await owner("qa-ai-settings-a", "qa-ai-mailbox-a"),
    b = await owner("qa-ai-settings-b", "qa-ai-mailbox-b"),
    origin = "https://qa-ai-settings.example.invalid",
    secret = "synthetic-qa-ai-settings-auth-secret-never-live-123";
  for (const session of [a, b])
    await db
      .prepare("UPDATE session SET createdAt=?,updatedAt=? WHERE id=?")
      .bind(Date.now(), Date.now(), session.sessionId)
      .run();
  const configuration = configuredAi();
  const bindings = {
    ...syntheticClassificationBindings,
    DB: env.DB,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: origin,
    AUTH_SECRET: secret,
    AUTH_GOOGLE_CLIENT_ID: "synthetic",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic",
    AUTH_ALLOWED_EMAILS: JSON.stringify([a.loginEmail, b.loginEmail]),
    AI_ENABLED: "true",
    AI_REGISTRY_JSON: JSON.stringify(configuration.destinations),
    AI_HOSTED_DESTINATION: "qa-onboard-provider",
    AI_HOSTED_MODEL: "qa-small",
    AI_HOSTED_KEY: "synthetic-hosted-key-never-live",
    AI_BUDGET_JSON: JSON.stringify(configuration.budget),
    CREDENTIAL_KEYRING: JSON.stringify({
      activeVersion: 1,
      keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    }),
  };
  async function request(session: OnboardingSession, workspaceToken?: string) {
    const token = `synthetic-${session.tenant.userId}`,
      key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(token),
    );
    const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
    return worker.fetch(
      new Request(`${origin}/api/ai/settings`, {
        method: workspaceToken ? "PUT" : "GET",
        headers: {
          Cookie: cookie,
          ...(workspaceToken
            ? {
                Origin: origin,
                "Content-Type": "application/json",
                "X-Workspace-Token": workspaceToken,
              }
            : {}),
        },
        ...(workspaceToken
          ? {
              body: JSON.stringify({
                version: 0,
                mode: "hosted",
                providerId: "qa-onboard-provider",
                modelId: "qa-small",
                acceptedPolicyVersion: 1,
              }),
            }
          : {}),
      }),
      bindings,
    );
  }
  const old = await request(a),
    fresh = await request(b);
  expect(old.status).toBe(200);
  expect(fresh.status).toBe(200);
  const oldState = await old.json<{ mutationToken: string; version: number }>(),
    currentState = await fresh.json<{
      mutationToken: string;
      version: number;
    }>();
  expect(oldState.version).toBe(0);
  expect(currentState.version).toBe(0);
  expect(typeof oldState.mutationToken).toBe("string");
  expect(typeof currentState.mutationToken).toBe("string");
  expect((await request(b, oldState.mutationToken)).status).toBe(403);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM ai_settings WHERE user_id=?")
      .bind(b.tenant.userId)
      .first("n"),
  ).toBe(0);
  expect((await request(b, currentState.mutationToken)).status).toBe(200);
  expect(
    await db
      .prepare("SELECT revision FROM ai_settings WHERE user_id=?")
      .bind(b.tenant.userId)
      .first("revision"),
  ).toBe(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM ai_settings WHERE user_id=?")
      .bind(a.tenant.userId)
      .first("n"),
  ).toBe(0);
});

it("ONBOARD-04/07 second tenant Start preserves first tenant's immutable command result and replay", async () => {
  const a = await owner("qa-command-owner-a"),
    b = await owner("qa-command-owner-b"),
    shownA = await runtime().usecases.disclosure(a, query),
    bodyA = startBody(shownA),
    startedA = await runtime().usecases.start(
      a,
      bodyA,
      "qa-preserved-command-a",
    );
  const original = await db
    .prepare(
      "SELECT key_hash,body_hash,result_json,import_run_id FROM onboarding_commands WHERE user_id=?",
    )
    .bind(a.tenant.userId)
    .first();
  expect(original).not.toBeNull();
  const shownB = await runtime().usecases.disclosure(b, query),
    startedB = await runtime().usecases.start(
      b,
      startBody(shownB),
      "qa-preserved-command-b",
    );
  expect(startedB.importRunId).not.toBe(startedA.importRunId);
  expect(
    await db
      .prepare(
        "SELECT key_hash,body_hash,result_json,import_run_id FROM onboarding_commands WHERE user_id=?",
      )
      .bind(a.tenant.userId)
      .first(),
  ).toEqual(original);
  expect(
    await runtime().usecases.start(a, bodyA, "qa-preserved-command-a"),
  ).toEqual({ importRunId: startedA.importRunId, reused: true });
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

async function completedNoMatch(userId: string) {
  await db
    .prepare(
      "UPDATE sync_states SET stage='discovery_complete' WHERE user_id=? AND sync_kind='backfill'",
    )
    .bind(userId)
    .run();
  await db
    .prepare(
      "UPDATE sync_states SET stage='idle',recovery_anchor=NULL,frozen_start=NULL,frozen_cutoff=NULL WHERE user_id=? AND sync_kind='incremental'",
    )
    .bind(userId)
    .run();
  await db
    .prepare("UPDATE jobs SET status='completed' WHERE user_id=?")
    .bind(userId)
    .run();
}

it("ONBOARD-11 completed no-match history permits an explicitly reviewed changed range", async () => {
  const session = await owner(
      "qa-onboard-completed-range",
      "qa-completed-inbox",
    ),
    selection = { ...query, connectionId: "qa-completed-inbox" },
    initial = await runtime().usecases.disclosure(session, selection),
    first = await runtime().usecases.start(
      session,
      startBody(initial),
      "qa-completed-first-key",
    );
  await completedNoMatch(session.tenant.userId);
  const view = await runtime().usecases.view(session, {
    connectionId: selection.connectionId,
  });
  expect(view.view.historyComplete).toBe(true);
  const changed = await runtime().usecases.disclosure(session, {
    ...selection,
    startDate: "2025-04-01",
  });
  expect(changed.startDate).toBe("2025-04-01");
  const next = await runtime().usecases.start(
    session,
    startBody(changed),
    "qa-completed-new-range",
  );
  expect(next.importRunId).not.toBe(first.importRunId);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM import_runs WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(2);
});

it("RECENT-07 completed parent coverage excludes unrelated ready live hourly work", async () => {
  const session = await owner("qa-onboard-completed-live", "qa-live-inbox"),
    shown = await runtime().usecases.disclosure(session, {
      ...query,
      connectionId: "qa-live-inbox",
    });
  await runtime().usecases.start(
    session,
    startBody(shown),
    "qa-live-completed-key",
  );
  await completedNoMatch(session.tenant.userId);
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at) SELECT 'qa-live-hourly',user_id,connection_id,consent_id,connection_generation,(SELECT id FROM sync_states WHERE user_id=import_runs.user_id AND sync_kind='incremental'),'sync','qa-live-hourly','ready',0 FROM import_runs WHERE user_id=?",
    )
    .bind(session.tenant.userId)
    .run();
  const view = await runtime().usecases.view(session, {
    connectionId: "qa-live-inbox",
  });
  expect(view).toMatchObject({
    view: { historyComplete: true, state: "no_matches" },
    progress: { pendingJobs: 0, pausedJobs: 0, historyComplete: true },
  });
  expect(
    await db
      .prepare(
        "SELECT status FROM jobs WHERE user_id=? AND id='qa-live-hourly'",
      )
      .bind(session.tenant.userId)
      .first("status"),
  ).toBe("ready");
});

it("RECENT-05/07 ready counts exclude merged/deleting records and include an unpaid manually completed source record", async () => {
  const session = await owner(
      "qa-onboard-visible-manual",
      "qa-visible-mailbox",
    ),
    shown = await runtime().usecases.disclosure(session, {
      ...query,
      connectionId: "qa-visible-mailbox",
    }),
    started = await runtime().usecases.start(
      session,
      startBody(shown),
      "qa-visible-manual-start",
    );
  for (const name of ["visible", "merged", "deleting"]) {
    await db
      .prepare(
        "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation,processing_status) VALUES(?,?,'qa-visible-mailbox',?,0,1,'processed')",
      )
      .bind(
        `qa-count-source-${name}`,
        session.tenant.userId,
        `qa-provider-${name}`,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length,parse_state) VALUES(?,?,?,'0',?,'text/plain',10,'ready')",
      )
      .bind(
        `qa-count-doc-${name}`,
        session.tenant.userId,
        `qa-count-source-${name}`,
        "a".repeat(64),
      )
      .run();
    await db
      .prepare(
        "INSERT INTO discovery_run_sources(user_id,import_run_id,source_message_id,candidate_kind) VALUES(?,?,?,'matched')",
      )
      .bind(
        session.tenant.userId,
        started.importRunId,
        `qa-count-source-${name}`,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state,origin,record_status,lifecycle_delete_connection_id) VALUES(?,?,'QA supplied record','qa supplied record','2026-03-29',1000,'EUR','unpaid','user-supplied',?,?)",
      )
      .bind(
        `qa-count-record-${name}`,
        session.tenant.userId,
        name === "merged" ? "merged" : "active",
        name === "deleting" ? "qa-visible-mailbox" : null,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO manual_purchase_evidence(user_id,purchase_id,document_id) VALUES(?,?,?)",
      )
      .bind(
        session.tenant.userId,
        `qa-count-record-${name}`,
        `qa-count-doc-${name}`,
      )
      .run();
  }
  const view = await runtime().usecases.view(session, {
    connectionId: "qa-visible-mailbox",
  });
  expect(view.view.readyRecordCount).toBe(1);
  expect(view.progress?.readyRecordCount).toBe(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM observations WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM ledger_entries WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(0);
});

it("ONBOARD-09 actual disconnect and reviewed generation recovery preserve old lease fences and rebind at most two of 1005 sources per invocation", async () => {
  const session = await owner(
      "00-qa-generation-recovery",
      "qa-generation-mailbox",
    ),
    selected = configuredAi(),
    initial = runtime(undefined, selected),
    disclosure = await initial.usecases.disclosure(session, {
      ...query,
      connectionId: "qa-generation-mailbox",
    }),
    accepted = await initial.usecases.start(
      session,
      startBody(disclosure),
      "qa-generation-initial-key",
    );
  const policy = {
    dispatchLimit: 1,
    scheduleLimit: 1,
    tenantConcurrency: 1,
    globalConcurrency: 2,
    maxAttempts: 3,
    leaseMs: 300000,
    redeliveryMs: 1000,
  };
  await db
    .prepare(
      "WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<1007) INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation,available) SELECT printf('qa-generation-source-%04d',x),?,?,printf('qa-generation-message-%04d',x),?,1,CASE WHEN x=1007 THEN 0 ELSE 1 END FROM n",
    )
    .bind(session.tenant.userId, disclosure.connectionId, now)
    .run();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,outcome_code) SELECT '00-'||s.id,s.user_id,s.connection_id,r.consent_id,1,'source-extract','00-'||s.id,CASE WHEN s.id='qa-generation-source-1005' THEN 'canceled' WHEN s.id='qa-generation-source-1006' THEN 'completed' ELSE 'ready' END,?,CASE WHEN s.id='qa-generation-source-1005' THEN 'manual-cancellation' ELSE NULL END FROM source_messages s JOIN import_runs r ON r.user_id=s.user_id AND r.id=? WHERE s.user_id=?",
    )
    .bind(now, accepted.importRunId, session.tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id) SELECT user_id,'00-'||id,id FROM source_messages WHERE user_id=?",
    )
    .bind(session.tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO discovery_run_sources(user_id,import_run_id,source_message_id,candidate_kind) SELECT user_id,?,id,'matched' FROM source_messages WHERE user_id=?",
    )
    .bind(accepted.importRunId, session.tenant.userId)
    .run();
  const oldJob = "00-qa-generation-source-0000",
    oldStore = createJobStore(db, { policy, clock: () => now }),
    oldLease = await oldStore.claim(oldJob);
  if (!oldLease) throw new Error("Synthetic source lease not claimed");
  await db
    .prepare(
      "UPDATE sync_states SET page_token='qa-preserved-page' WHERE user_id=? AND import_run_id=? AND slice_key='recent'",
    )
    .bind(session.tenant.userId, accepted.importRunId)
    .run();
  const lifecycleOrigin = "https://qa-generation-lifecycle.example.invalid",
    lifecycleSecret =
      "synthetic-generation-lifecycle-auth-secret-never-live-123",
    sessionToken = `synthetic-${session.tenant.userId}`;
  await db
    .prepare(
      "UPDATE session SET createdAt=?,updatedAt=? WHERE id=? AND userId=?",
    )
    .bind(Date.now(), Date.now(), session.sessionId, session.tenant.userId)
    .run();
  const signingKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(lifecycleSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    new TextEncoder().encode(sessionToken),
  );
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${sessionToken}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
  const lifecycleBindings = {
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: lifecycleOrigin,
    AUTH_SECRET: lifecycleSecret,
    AUTH_GOOGLE_CLIENT_ID: "synthetic",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic",
    AUTH_ALLOWED_EMAILS: JSON.stringify([session.loginEmail]),
    LIFECYCLE_ENABLED: "true",
  };
  const capabilitiesMeter = createInvocationDatabase(env.DB, 40);
  const capabilities = await worker.fetch(
    new Request(`${lifecycleOrigin}/api/lifecycle/capabilities`, {
      headers: { Cookie: cookie },
    }),
    { ...lifecycleBindings, DB: capabilitiesMeter.db },
  );
  expect(capabilities.status).toBe(200);
  expect(capabilities.headers.get("cache-control")).toBe("no-store");
  expect(capabilitiesMeter.executedStatements()).toBeLessThanOrEqual(40);
  const capabilityBody = (await capabilities.json()) as {
    mutationToken?: unknown;
  };
  if (typeof capabilityBody.mutationToken !== "string")
    throw new Error("Lifecycle read-issued mutation token missing");
  const lifecycleMeter = createInvocationDatabase(env.DB, 40);
  const disconnected = await worker.fetch(
    new Request(
      `${lifecycleOrigin}/api/connections/${encodeURIComponent(disclosure.connectionId)}`,
      {
        method: "DELETE",
        headers: {
          Cookie: cookie,
          Origin: lifecycleOrigin,
          "Content-Type": "application/json",
          "Idempotency-Key": "qa-generation-disconnect-key",
          "X-Workspace-Token": capabilityBody.mutationToken,
        },
        body: JSON.stringify({
          confirmed: true,
          generation: 1,
          credentialVersion: 1,
        }),
      },
    ),
    { ...lifecycleBindings, DB: lifecycleMeter.db },
  );
  expect(disconnected.status).toBe(200);
  expect(disconnected.headers.get("cache-control")).toBe("no-store");
  expect(await disconnected.json()).toMatchObject({
    generation: 2,
    recordsRetained: true,
    localCredentialsRemoved: true,
    remoteRevocation: "not_attempted",
  });
  expect(lifecycleMeter.executedStatements()).toBeLessThanOrEqual(40);
  expect(await oldStore.checkpoint(oldLease)).toBe(false);
  // Synthetic trusted callback completion retains the same provider subject.
  // The writer separately tests the actual one-use OAuth callback transport.
  await db
    .prepare(
      "UPDATE connections SET state='connected',credential_ciphertext='synthetic-reconnected-token',credential_key_version=1 WHERE user_id=? AND id=?",
    )
    .bind(session.tenant.userId, disclosure.connectionId)
    .run();
  expect(await oldStore.claim(oldJob)).toBeNull();
  const refreshed = runtime(undefined, selected),
    fresh = await refreshed.usecases.disclosure(session, {
      connectionId: disclosure.connectionId,
    }),
    resumed = runtime(undefined, selected);
  expect(fresh.connectionGeneration).toBe(2);
  expect(
    await resumed.usecases.start(
      session,
      startBody(fresh),
      "qa-generation-resume-key",
    ),
  ).toEqual({ importRunId: accepted.importRunId, reused: true });
  expect(resumed.opens()).toBe(0);
  expect(resumed.meter.executedStatements()).toBeLessThanOrEqual(40);
  expect(await oldStore.checkpoint(oldLease)).toBe(false);
  expect(
    await db
      .prepare(
        "SELECT page_token FROM sync_states WHERE user_id=? AND import_run_id=? AND slice_key='recent'",
      )
      .bind(session.tenant.userId, accepted.importRunId)
      .first("page_token"),
  ).toBe("qa-preserved-page");
  let priorJobs = 0,
    priorSources = 0;
  for (let step = 0; step < 8; step++) {
    const meter = createInvocationDatabase(env.DB, 40);
    await createJobStore(meter.db, {
      policy,
      clock: () => now,
      processingReview: createProcessingReviewResolver(selected),
    }).recover();
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
    const jobs = await db
        .prepare(
          "SELECT COUNT(*) n FROM jobs j JOIN discovery_source_jobs d ON d.user_id=j.user_id AND d.job_id=j.id WHERE j.user_id=? AND j.connection_generation=2",
        )
        .bind(session.tenant.userId)
        .first<number>("n"),
      sources = await db
        .prepare(
          "SELECT COUNT(*) n FROM source_messages WHERE user_id=? AND generation=2",
        )
        .bind(session.tenant.userId)
        .first<number>("n");
    if (jobs === null || sources === null)
      throw new Error("Native counts absent");
    expect(jobs - priorJobs).toBeLessThanOrEqual(2);
    expect(sources - priorSources).toBeLessThanOrEqual(2);
    expect(jobs).toBe(sources);
    priorJobs = jobs;
    priorSources = sources;
  }
  expect(priorJobs).toBeGreaterThan(0);
  expect(priorJobs).toBeLessThan(1005);
  expect(await oldStore.checkpoint(oldLease)).toBe(false);
  for (const [suffix, status, code] of [
    ["1005", "canceled", "manual-cancellation"],
    ["1006", "completed", null],
    ["1007", "canceled", "mailbox_disconnected"],
  ] as const) {
    expect(
      await db
        .prepare(
          "SELECT status,outcome_code,connection_generation FROM jobs WHERE user_id=? AND id=?",
        )
        .bind(session.tenant.userId, `00-qa-generation-source-${suffix}`)
        .first(),
    ).toMatchObject({ status, outcome_code: code, connection_generation: 1 });
    expect(
      await db
        .prepare(
          "SELECT generation FROM source_messages WHERE user_id=? AND id=?",
        )
        .bind(session.tenant.userId, `qa-generation-source-${suffix}`)
        .first("generation"),
    ).toBe(1);
  }
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM import_runs WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM ai_extractions WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(0);
});

it("ONBOARD-06/09 revoked hourly work outside a newly reviewed narrower range stays fenced while in-range and post-cutoff gap sources recover", async () => {
  const session = await owner("00-qa-recovery-range", "qa-range-mailbox"),
    selected = configuredAi(),
    first = runtime(undefined, selected),
    shown = await first.usecases.disclosure(session, {
      ...query,
      connectionId: "qa-range-mailbox",
    }),
    old = await first.usecases.start(
      session,
      startBody(shown),
      "qa-range-old-parent-key",
    );
  const oldConsent = await db
    .prepare("SELECT consent_id FROM import_runs WHERE user_id=? AND id=?")
    .bind(session.tenant.userId, old.importRunId)
    .first<string>("consent_id");
  if (!oldConsent) throw new Error("Accepted prior consent absent");
  await db
    .prepare("UPDATE import_runs SET completed_at=? WHERE user_id=? AND id=?")
    .bind(now, session.tenant.userId, old.importRunId)
    .run();
  await db
    .prepare(
      "UPDATE sync_states SET stage='discovery_complete' WHERE user_id=?",
    )
    .bind(session.tenant.userId)
    .run();
  await db
    .prepare("UPDATE jobs SET status='completed' WHERE user_id=?")
    .bind(session.tenant.userId)
    .run();
  await db
    .prepare(
      "UPDATE processing_consents SET revoked_at=? WHERE user_id=? AND id=?",
    )
    .bind(now, session.tenant.userId, oldConsent)
    .run();
  for (const [name, received] of [
    ["before", Date.parse("2026-03-28T23:00:00.499Z")],
    ["in-range", Date.parse("2026-03-28T23:00:00.500Z")],
    ["gap", Date.parse("2026-03-31T12:00:00Z")],
  ] as const) {
    const source = `qa-range-${name}`,
      job = `00-${source}`;
    await db
      .prepare(
        "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,?,?,?,1)",
      )
      .bind(source, session.tenant.userId, shown.connectionId, source, received)
      .run();
    await db
      .prepare(
        "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,outcome_code) VALUES(?,?,?,?,1,'source-extract',?,'canceled',?,'authorization-changed')",
      )
      .bind(
        job,
        session.tenant.userId,
        shown.connectionId,
        oldConsent,
        job,
        now,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id) VALUES(?,?,?)",
      )
      .bind(session.tenant.userId, job, source)
      .run();
  }
  const freshRuntime = runtime(undefined, selected),
    fresh = await freshRuntime.usecases.disclosure(session, {
      ...query,
      connectionId: shown.connectionId,
      startDate: "2026-03-29",
      endDate: "2026-03-30",
    }),
    started = await freshRuntime.usecases.start(
      session,
      startBody(fresh),
      "qa-range-new-parent-key",
    );
  expect(started.importRunId).not.toBe(old.importRunId);
  const currentConsent = await db
    .prepare("SELECT consent_id FROM import_runs WHERE user_id=? AND id=?")
    .bind(session.tenant.userId, started.importRunId)
    .first("consent_id");
  expect(fresh.startAt).toBe("2026-03-28T23:00:00.000Z");
  // Stage the canonical persisted millisecond boundary directly; this explicit
  // date fixture emits .000, while recovery must honor exact stored bounds.
  await db
    .prepare(
      "UPDATE import_runs SET frozen_start='2026-03-28T23:00:00.500Z' WHERE user_id=? AND id=?",
    )
    .bind(session.tenant.userId, started.importRunId)
    .run();

  const policy = {
    dispatchLimit: 1,
    scheduleLimit: 1,
    tenantConcurrency: 1,
    globalConcurrency: 2,
    maxAttempts: 3,
    leaseMs: 300000,
    redeliveryMs: 1000,
  };
  const profileCount = await db
      .prepare("SELECT COUNT(*) n FROM profiles")
      .first<number>("n"),
    ownedJobCount = await db
      .prepare("SELECT COUNT(*) n FROM jobs WHERE user_id=?")
      .bind(session.tenant.userId)
      .first<number>("n");
  if (!profileCount || !ownedJobCount)
    throw new Error("Recovery fixture counts absent");
  const maxUnits = profileCount * (Math.ceil(ownedJobCount / 2) + 1);
  let recovered = false,
    priorReady = 0;
  // Each tenant page examines two jobs. Allow each observed owner a turn for
  // every required job page, while preserving the same per-invocation bounds.
  for (let step = 0; step < maxUnits; step++) {
    const meter = createInvocationDatabase(env.DB, 40);
    await createJobStore(meter.db, {
      policy,
      clock: () => now,
      processingReview: createProcessingReviewResolver(selected),
    }).recover();
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
    expect(
      await db
        .prepare(
          "SELECT consent_id,status FROM jobs WHERE user_id=? AND id='00-qa-range-before'",
        )
        .bind(session.tenant.userId)
        .first(),
    ).toMatchObject({ consent_id: oldConsent, status: "canceled" });
    const ready = await db
      .prepare(
        "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND id IN ('00-qa-range-in-range','00-qa-range-gap') AND consent_id=? AND status='ready'",
      )
      .bind(session.tenant.userId, currentConsent)
      .first("n");
    if (typeof ready !== "number")
      throw new Error("Recovery readiness count absent");
    expect(ready - priorReady).toBeLessThanOrEqual(2);
    priorReady = ready;
    if (ready === 2) {
      recovered = true;
      break;
    }
  }
  expect(recovered).toBe(true);
  for (const name of ["in-range", "gap"]) {
    expect(
      await db
        .prepare("SELECT consent_id,status FROM jobs WHERE user_id=? AND id=?")
        .bind(session.tenant.userId, `00-qa-range-${name}`)
        .first(),
    ).toMatchObject({ consent_id: currentConsent, status: "ready" });
  }
  expect(
    await db
      .prepare(
        "SELECT consent_id,status FROM jobs WHERE user_id=? AND id='00-qa-range-before'",
      )
      .bind(session.tenant.userId)
      .first(),
  ).toMatchObject({ consent_id: oldConsent, status: "canceled" });
  expect(
    await createJobStore(db, { policy, clock: () => now }).claim(
      "00-qa-range-before",
    ),
  ).toBeNull();
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM discovery_run_sources WHERE user_id=? AND import_run_id=?",
      )
      .bind(session.tenant.userId, started.importRunId)
      .first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM ai_extractions WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(0);
});

it("ONBOARD-08 operator-disabled processing pauses as service unavailable without quota use", async () => {
  const session = await owner("qa-handler-unavailable", "qa-disabled-mailbox"),
    selected = configuredAi(),
    ready = runtime(undefined, selected),
    disclosure = await ready.usecases.disclosure(session, {
      ...query,
      connectionId: "qa-disabled-mailbox",
    }),
    accepted = await ready.usecases.start(
      session,
      startBody(disclosure),
      "qa-disabled-initial-key",
    );
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('qa-disabled-source',?,?,'synthetic-unread',?,1)",
    )
    .bind(session.tenant.userId, disclosure.connectionId, now)
    .run();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) SELECT 'qa-disabled-job',user_id,connection_id,consent_id,connection_generation,'source-extract','qa-disabled-job','ready',? FROM import_runs WHERE user_id=? AND id=?",
    )
    .bind(now, session.tenant.userId, accepted.importRunId)
    .run();
  await db
    .prepare(
      "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id) VALUES(?,'qa-disabled-job','qa-disabled-source')",
    )
    .bind(session.tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO discovery_run_sources(user_id,import_run_id,source_message_id,candidate_kind) VALUES(?,?,'qa-disabled-source','matched')",
    )
    .bind(session.tenant.userId, accepted.importRunId)
    .run();
  const meter = createInvocationDatabase(env.DB, 40),
    store = createJobStore(meter.db, {
      policy: {
        dispatchLimit: 1,
        scheduleLimit: 1,
        tenantConcurrency: 1,
        globalConcurrency: 2,
        maxAttempts: 3,
        leaseMs: 300000,
        redeliveryMs: 1000,
      },
      clock: () => now,
    });
  let sent = 0;
  expect(
    await createJobEngine({
      store,
      queue: {
        send: async () => {
          sent++;
        },
      },
      clock: () => now,
    }).consume({ schemaVersion: 1, jobId: "qa-disabled-job" }),
  ).toBe("ack");
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  expect(sent).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT status,outcome_code FROM jobs WHERE user_id=? AND id='qa-disabled-job'",
      )
      .bind(session.tenant.userId)
      .first(),
  ).toMatchObject({
    status: "paused_budget",
    outcome_code: "handler-unavailable",
  });
  for (const table of [
    "ai_extractions",
    "usage_events",
    "purchases",
    "documents",
  ])
    expect(
      await db
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`)
        .bind(session.tenant.userId)
        .first("n"),
    ).toBe(0);
  const response = await runtime(undefined, selected).usecases.view(session, {
    connectionId: disclosure.connectionId,
  });
  expect(response.view.state).toBe("processing_unavailable");
  expect(response.view.headlineKey).toBe("import.paused.service");
  await db
    .prepare(
      "UPDATE jobs SET status='ready',outcome_code=NULL,dispatch_at=? WHERE user_id=? AND id='qa-disabled-job'",
    )
    .bind(now, session.tenant.userId)
    .run();
  const quotaMeter = createInvocationDatabase(env.DB, 40),
    quotaStore = createJobStore(quotaMeter.db, {
      policy: {
        dispatchLimit: 1,
        scheduleLimit: 1,
        tenantConcurrency: 1,
        globalConcurrency: 2,
        maxAttempts: 3,
        leaseMs: 300000,
        redeliveryMs: 1000,
      },
      clock: () => now,
    });
  let calls = 0;
  expect(
    await createJobEngine({
      store: quotaStore,
      queue: {
        send: async () => {
          sent++;
        },
      },
      admission: { allow: async () => false },
      handler: {
        run: async () => {
          calls++;
          return { kind: "completed" };
        },
      },
      clock: () => now,
    }).consume({ schemaVersion: 1, jobId: "qa-disabled-job" }),
  ).toBe("ack");
  expect(quotaMeter.executedStatements()).toBeLessThanOrEqual(40);
  expect(calls).toBe(0);
  const quotaView = await runtime(undefined, selected).usecases.view(session, {
    connectionId: disclosure.connectionId,
  });
  expect(quotaView.view.state).toBe("paused_budget");
  expect(quotaView.view.headlineKey).toBe("import.paused.budget");
  expect(
    await db
      .prepare(
        "SELECT outcome_code FROM jobs WHERE user_id=? AND id='qa-disabled-job'",
      )
      .bind(session.tenant.userId)
      .first("outcome_code"),
  ).toBe("budget");
});
