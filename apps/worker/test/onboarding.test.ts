import { env } from "cloudflare:workers";
import type { DiscoveryProviderPort, TenantContext } from "@invoxim/core";
import { createOnboardingUsecases } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { aiConfiguration } from "../../../packages/adapters/src/ai/configuration";
import { createOnboardingRepository } from "../../../packages/adapters/src/onboarding/repository";

const session = {
  tenant: { userId: "onboard-login-a", authority: "session" } as TenantContext,
  sessionId: "onboard-session",
  loginEmail: "login-a@example.invalid",
};
const options = {
  ai: null,
  ready: false,
  signingSecret: "synthetic-onboarding-secret-never-live-123",
  mailboxLimit: 3,
  remainingStatements: () => 40,
};
beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
    )
    .bind(session.tenant.userId, "Synthetic", session.loginEmail)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind(session.tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes) VALUES('mailbox-b',?,'mailbox','gmail','provider-b','mailbox-b@example.invalid',?)",
    )
    .bind(
      session.tenant.userId,
      JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
    )
    .run();
});
it("ONBOARD-04 login A and owned mailbox B remain distinct and read-only before explicit Start", async () => {
  const usecases = createOnboardingUsecases({
    repository: createOnboardingRepository(db, options),
    preparation: {
      prepare: async () => {
        throw new Error("pre-Start provider must not open");
      },
    },
  });
  const view = await usecases.view(session);
  expect(view.login.email).toBe("login-a@example.invalid");
  expect(view.connections).toMatchObject([
    {
      id: "mailbox-b",
      address: "mailbox-b@example.invalid",
      schedulingState: "awaiting_import",
    },
  ]);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM processing_consents WHERE user_id=?",
      )
      .bind(session.tenant.userId)
      .first("count"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("count"),
  ).toBe(0);
});

const at = Date.parse("2026-10-01T12:00:00Z");
function inference() {
  const value = aiConfiguration({
    AI_ENABLED: "true",
    AI_REGISTRY_JSON: JSON.stringify([
      {
        id: "owned-synthetic",
        endpoint: "https://model.example.invalid/v1/chat/completions",
        configVersion: "v1",
        policyVersion: 1,
        noticeRefs: ["synthetic-policy"],
        notices: [
          {
            id: "synthetic-policy",
            displayName: "Synthetic processor",
            dataUseSummary: "Synthetic evaluation only; no live user content.",
            retentionSummary:
              "Synthetic test fixture; no provider policy claim.",
            privacyUrl: "https://policy.example.invalid/synthetic",
          },
        ],
        timeoutMs: 100,
        maxInputBytes: 8192,
        maxOutputBytes: 8192,
        maxOutputTokens: 256,
        models: [
          {
            id: "m",
            capabilities: {
              jsonSchema: false,
              jsonObject: true,
              outputLimit: "max_tokens",
              usage: true,
              idempotency: false,
            },
            pricing: {
              version: "v1",
              approved: true,
              currency: "USD",
              source: "https://prices.example.invalid/synthetic",
              checkedAt: "2026-10-01T00:00:00Z",
              inputUsdMicrosPerMillion: "100",
              outputUsdMicrosPerMillion: "100",
              otherUsdMicrosPerMillion: "100",
            },
          },
        ],
      },
    ]),
    AI_HOSTED_DESTINATION: "owned-synthetic",
    AI_HOSTED_MODEL: "m",
    AI_HOSTED_KEY: "synthetic-key",
    CREDENTIAL_KEYRING: JSON.stringify({
      activeVersion: 1,
      keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    }),
    AI_BUDGET_JSON: JSON.stringify({
      dailyDocuments: 100,
      monthlyDocuments: 1000,
      dailyUnits: 1000000,
      monthlyUnits: 10000000,
      globalDailyUsdMicros: "1000000",
      globalMonthlyUsdMicros: "10000000",
    }),
  });
  if (!value) throw new Error("Synthetic config invalid");
  return value;
}
it("explicit Start keeps reviewed cutoff and seeds the delayed anchor gap without reading bodies", async () => {
  await db
    .prepare(
      "INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,9999999999999,?,0,0,?)",
    )
    .bind(
      session.sessionId,
      "synthetic-signed-session-fixture",
      session.tenant.userId,
    )
    .run();
  await db
    .prepare(
      "UPDATE connections SET credential_ciphertext='synthetic-envelope',credential_key_version=1,credential_version=1 WHERE user_id=? AND id='mailbox-b'",
    )
    .bind(session.tenant.userId)
    .run();
  let clock = at,
    opens = 0;
  const usecases = createOnboardingUsecases({
    repository: createOnboardingRepository(db, {
      ...options,
      ai: inference(),
      ready: true,
      clock: () => clock,
    }),
    preparation: {
      prepare: async () => {
        opens++;
        clock += 60000;
        return { provider: "gmail", historyAnchor: "998877" };
      },
    },
  });
  const disclosure = await usecases.disclosure(session, {
    connectionId: "mailbox-b",
    timezone: "Europe/Vienna",
    reportingCurrency: "EUR",
  });
  expect(opens).toBe(0);
  expect(disclosure.canStartImport).toBe(true);
  const input = {
    connectionId: disclosure.connectionId,
    expectedConnectionGeneration: disclosure.connectionGeneration,
    expectedAiSettingsRevision: disclosure.aiSettingsRevision,
    expectedProfileVersion: disclosure.profileVersion,
    acceptedDisclosureVersion: disclosure.disclosureVersion,
    reviewToken: disclosure.reviewToken,
    startDate: disclosure.startDate,
    endDate: disclosure.endDate,
    timezone: disclosure.timezone,
    reportingCurrency: disclosure.reportingCurrency,
    authorizeHourlySync: true,
  };
  const result = await usecases.start(session, input, "owned-start");
  expect(opens).toBe(1);
  expect(
    await db
      .prepare("SELECT frozen_cutoff FROM import_runs WHERE user_id=? AND id=?")
      .bind(session.tenant.userId, result.importRunId)
      .first("frozen_cutoff"),
  ).toBe("2026-10-01T12:00:00.000Z");
  expect(
    await db
      .prepare(
        "SELECT stage,frozen_start,frozen_cutoff,recovery_anchor FROM sync_states WHERE user_id=? AND slice_key='live'",
      )
      .bind(session.tenant.userId)
      .first(),
  ).toEqual({
    stage: "recovering",
    frozen_start: "2026-10-01T12:00:00.000Z",
    frozen_cutoff: "2026-10-01T12:01:00.000Z",
    recovery_anchor: "998877",
  });
  expect(await usecases.start(session, input, "owned-start")).toEqual({
    importRunId: result.importRunId,
    reused: true,
  });
  expect(opens).toBe(1);
});

import { createDiscoveryService } from "../../../packages/adapters/src/discovery/service";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { createInvocationDatabase } from "../src/invocation-database";

it("the existing recovering page enumerates a source between review cutoff and anchor once, including later history overlap", async () => {
  const live = await db
    .prepare(
      "SELECT s.id,r.consent_id FROM sync_states s JOIN import_runs r ON r.user_id=s.user_id AND r.connection_id=s.connection_id WHERE s.user_id=? AND s.slice_key='live'",
    )
    .bind(session.tenant.userId)
    .first<{ id: string; consent_id: string }>();
  if (!live) throw new Error("Missing accepted live state");
  const policy = {
    dispatchLimit: 50,
    scheduleLimit: 50,
    tenantConcurrency: 2,
    globalConcurrency: 20,
    maxAttempts: 3,
    leaseMs: 300000,
    redeliveryMs: 60000,
    queryLimit: 40,
  };
  const provider: DiscoveryProviderPort = {
    anchor: async () => "998877",
    list: async (input: { range: { startMs: number; cutoffMs: number } }) => {
      expect(input.range.startMs).toBe(at);
      expect(input.range.cutoffMs).toBe(at + 60000);
      return { ids: ["between-review-and-anchor"] };
    },
    metadata: async (id: string) => ({
      id,
      receivedAtMs: at + 30000,
      available: true,
      excluded: false,
      candidate: "matched" as const,
    }),
    history: async () => ({ ids: [], historyId: "998877" }),
  };
  for (const [index, clock] of [at + 60000, at + 120000].entries()) {
    provider.history = async () => ({
      ids: clock > at + 60000 ? ["between-review-and-anchor"] : [],
      historyId: "998878",
    });
    const meter = createInvocationDatabase(env.DB, 40),
      store = createJobStore(meter.db, { policy, clock: () => clock }),
      jobId = `owned-gap-live-${index}`;
    expect(
      await createJobStore(db, { policy, clock: () => clock }).enqueue(
        session.tenant,
        {
          id: jobId,
          connectionId: "mailbox-b",
          consentId: live.consent_id,
          generation: 1,
          syncStateId: live.id,
          type: "sync",
          dedupeKey: jobId,
          priority: 0,
        },
      ),
    ).toBe(true);
    const lease = await store.claim(jobId);
    if (!lease) throw new Error("Missing native lease");
    const service = createDiscoveryService(meter.db, {
      providers: { open: async () => provider },
      readiness: { allow: async () => true },
      remainingStatements: meter.remainingStatements,
      clock: () => clock,
    });
    const outcome = await service.runPage(lease, {
      signal: new AbortController().signal,
      checkpoint: () => store.checkpoint(lease),
    });
    expect(outcome).toEqual({ kind: "completed" });
    expect(
      await db
        .prepare("SELECT status FROM jobs WHERE user_id=? AND id=?")
        .bind(session.tenant.userId, jobId)
        .first("status"),
    ).toBe("completed");
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  }
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM source_messages WHERE user_id=? AND provider_message_id='between-review-and-anchor'",
      )
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND type='source-extract'",
      )
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(1);
});

import { createLoginAuth } from "@invoxim/adapters";
import { vi } from "vitest";
import { handleLoginRequest } from "../../../packages/adapters/src/auth/http";

it("login defaults returning users to Home and new users to review setup, preserving only legacy root override", async () => {
  const auth = createLoginAuth(db, {
    origin: "https://synthetic.example",
    secret: "synthetic-auth-onboard-secret-never-live-123",
    googleClientId: "synthetic",
    googleClientSecret: "synthetic",
    allowedEmails: [session.loginEmail],
  });
  const handler = vi
    .spyOn(auth, "handler")
    .mockImplementation(async (request) =>
      Response.json(JSON.parse(await request.text())),
    );
  try {
    for (const body of [
      { provider: "google" },
      { provider: "google", callbackURL: "/" },
    ]) {
      const response = await handleLoginRequest(
        auth,
        new Request("https://synthetic.example/api/auth/sign-in/social", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(await response.json()).toMatchObject({
        callbackURL: "callbackURL" in body ? "/" : "/home",
        newUserCallbackURL: "/onboarding",
        errorCallbackURL: "/",
      });
    }
    await expect(
      handleLoginRequest(
        auth,
        new Request("https://synthetic.example/api/auth/sign-in/social", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "google",
            callbackURL: "https://elsewhere.example.invalid",
          }),
        }),
      ),
    ).rejects.toThrow();
  } finally {
    handler.mockRestore();
  }
});

import { createAiProviderFactory } from "../../../packages/adapters/src/ai/provider-factory";

it("strict runtime rejects same provider/model with changed endpoint after reviewed Start before resolving an extractor", async () => {
  const selected = inference(),
    destination = selected.destinations[0];
  if (!destination) throw new Error("Missing synthetic destination");
  destination.endpoint =
    "https://changed-model.example.invalid/v1/chat/completions";
  const consentId = await db
    .prepare(
      "SELECT id FROM processing_consents WHERE user_id=? ORDER BY accepted_at DESC LIMIT 1",
    )
    .bind(session.tenant.userId)
    .first<string>("id");
  if (!consentId) throw new Error("Missing accepted consent");
  await expect(
    createAiProviderFactory(db, selected, {
      requireReviewedConfiguration: true,
    }).open(session.tenant, {
      settingsRevision: 1,
      consentId,
      parts: [{ id: "synthetic", text: "synthetic invoice fixture" }],
    }),
  ).rejects.toThrow("CONFLICT");
});
it("fresh explicit review after recipient drift resumes the same frozen scan and job IDs without anchoring or reimport", async () => {
  const priorCommands = (
    await db
      .prepare(
        "SELECT key_hash,body_hash,result_json,import_run_id FROM onboarding_commands WHERE user_id=? ORDER BY key_hash",
      )
      .bind(session.tenant.userId)
      .all<{
        key_hash: string;
        body_hash: string;
        result_json: string;
        import_run_id: string;
      }>()
  ).results;
  const before = await db
    .prepare(
      "SELECT id,frozen_start,frozen_cutoff,consent_id FROM import_runs WHERE user_id=?",
    )
    .bind(session.tenant.userId)
    .first<{
      id: string;
      frozen_start: string;
      frozen_cutoff: string;
      consent_id: string;
    }>();
  if (!before) throw new Error("Missing actual accepted run");
  const jobs = (
    await db
      .prepare("SELECT id FROM jobs WHERE user_id=? ORDER BY id")
      .bind(session.tenant.userId)
      .all<{ id: string }>()
  ).results;
  const selected = inference(),
    destination = selected.destinations[0];
  if (!destination) throw new Error("Missing configured processor");
  destination.endpoint =
    "https://fresh-reviewed.example.invalid/v1/chat/completions";
  const usecases = createOnboardingUsecases({
    repository: createOnboardingRepository(db, {
      ...options,
      ai: selected,
      ready: true,
      clock: () => at + 7200000,
    }),
    preparation: {
      prepare: async () => {
        throw new Error("Resume must preserve existing anchor");
      },
    },
  });
  const fresh = await usecases.disclosure(session, {
    connectionId: "mailbox-b",
  });
  expect(fresh.cutoffAt).toBe(before.frozen_cutoff);
  const body = {
    connectionId: fresh.connectionId,
    expectedConnectionGeneration: fresh.connectionGeneration,
    expectedAiSettingsRevision: fresh.aiSettingsRevision,
    expectedProfileVersion: fresh.profileVersion,
    acceptedDisclosureVersion: fresh.disclosureVersion,
    reviewToken: fresh.reviewToken,
    startDate: fresh.startDate,
    endDate: fresh.endDate,
    timezone: fresh.timezone,
    reportingCurrency: fresh.reportingCurrency,
    authorizeHourlySync: true,
  };
  expect(await usecases.start(session, body, "owned-fresh-resume")).toEqual({
    importRunId: before.id,
    reused: true,
  });
  for (const original of priorCommands) {
    expect(
      await db
        .prepare(
          "SELECT key_hash,body_hash,result_json,import_run_id FROM onboarding_commands WHERE user_id=? AND key_hash=?",
        )
        .bind(session.tenant.userId, original.key_hash)
        .first(),
    ).toEqual(original);
  }
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM import_runs WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT frozen_start,frozen_cutoff FROM import_runs WHERE user_id=? AND id=?",
      )
      .bind(session.tenant.userId, before.id)
      .first(),
  ).toEqual({
    frozen_start: before.frozen_start,
    frozen_cutoff: before.frozen_cutoff,
  });
  expect(
    (
      await db
        .prepare("SELECT id FROM jobs WHERE user_id=? ORDER BY id")
        .bind(session.tenant.userId)
        .all<{ id: string }>()
    ).results,
  ).toEqual(jobs);
  expect(
    await db
      .prepare(
        "SELECT revoked_at FROM processing_consents WHERE user_id=? AND id=?",
      )
      .bind(session.tenant.userId, before.consent_id)
      .first("revoked_at"),
  ).toBe(at + 7200000);
});

import type { MailboxAuthorizationPort } from "@invoxim/core";
import {
  GMAIL_AUTHORIZATION_SCOPES,
  type GmailConfiguration,
} from "../../../packages/adapters/src/mailbox/configuration";
import { createGmailAuthorization } from "../../../packages/adapters/src/mailbox/gmail";
import { createMailboxService } from "../../../packages/adapters/src/mailbox/service";
import { createProcessingReviewResolver } from "../../../packages/adapters/src/onboarding/processing-readiness";

const db = env.DB;

it("actual invalid_grant and canceled auth work resume after same-subject reconnect and fresh unchanged-config review", async () => {
  const now = Date.now();
  const selected = inference();
  const destination = selected.destinations[0];
  if (!destination) throw new Error("Missing processor");
  destination.endpoint =
    "https://fresh-reviewed.example.invalid/v1/chat/completions";
  const configuration: GmailConfiguration = {
    provider: "gmail",
    oauthProvider: "google",
    scopes: GMAIL_AUTHORIZATION_SCOPES,
    login: {
      origin: "https://synthetic.example",
      secret: options.signingSecret,
      googleClientId: "login",
      googleClientSecret: "synthetic-login",
      allowedEmails: [session.loginEmail],
    },
    clientId: "synthetic-mail",
    clientSecret: "synthetic-secret",
    limit: 3,
    cipher: selected.cipher,
    callback: "https://synthetic.example/api/oauth/mailbox/gmail/callback",
  };
  const credentials = {
    accessToken: "synthetic-access",
    refreshToken: "synthetic-refresh",
    expiresAt: now - 1,
  };
  const envelope = await configuration.cipher.seal(
    session.tenant,
    { entityId: "mailbox-b", purpose: "mailbox-credentials" },
    credentials,
  );
  await db
    .prepare(
      "UPDATE connections SET credential_ciphertext=?,credential_key_version=1,scheduling_state='active' WHERE user_id=? AND id='mailbox-b'",
    )
    .bind(envelope, session.tenant.userId)
    .run();
  await db
    .prepare("UPDATE session SET createdAt=? WHERE userId=? AND id=?")
    .bind(now, session.tenant.userId, session.sessionId)
    .run();
  const parent = await db
    .prepare("SELECT id,frozen_cutoff FROM import_runs WHERE user_id=?")
    .bind(session.tenant.userId)
    .first<{ id: string; frozen_cutoff: string }>();
  if (!parent) throw new Error("Missing actual run");
  const policy = {
    dispatchLimit: 50,
    scheduleLimit: 50,
    tenantConcurrency: 2,
    globalConcurrency: 20,
    maxAttempts: 3,
    leaseMs: 300000,
    redeliveryMs: 60000,
    queryLimit: 40,
  };
  for (let step = 0; step < 10; step++)
    await createJobStore(db, {
      policy,
      clock: () => now,
      processingReview: createProcessingReviewResolver(selected),
    }).recover();
  const jobId = await db
    .prepare(
      "SELECT j.id FROM jobs j JOIN sync_states s ON s.user_id=j.user_id AND s.id=j.sync_state_id WHERE j.user_id=? AND s.import_run_id=? AND j.status='ready' LIMIT 1",
    )
    .bind(session.tenant.userId, parent.id)
    .first<string>("id");
  if (!jobId) throw new Error("Missing actual unfinished job");
  const oldLease = await createJobStore(db, {
    policy,
    clock: () => now,
  }).claim(jobId);
  if (!oldLease) throw new Error("Missing actual lease");
  const google = createGmailAuthorization(configuration);
  const provider: MailboxAuthorizationPort = {
    authorize: async ({ state }) =>
      `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    exchange: async () => ({
      identity: { subject: "provider-b", address: "mailbox-b@example.invalid" },
      credentials: { ...credentials, expiresAt: Date.now() + 300000 },
      canReadMessages: true,
    }),
    refresh: google.refresh,
  };
  const mailboxService = createMailboxService(db, configuration, provider);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }),
  );
  try {
    await expect(
      mailboxService.refresh(session.tenant, "mailbox-b", 1),
    ).rejects.toThrow("RECONNECT_REQUIRED");
  } finally {
    fetch.mockRestore();
  }
  expect(
    await db
      .prepare(
        "SELECT state,generation,scheduling_state FROM connections WHERE user_id=? AND id='mailbox-b'",
      )
      .bind(session.tenant.userId)
      .first(),
  ).toEqual({
    state: "needs_reconnect",
    generation: 1,
    scheduling_state: "paused",
  });
  await createJobStore(db, { policy, clock: () => now + 300001 }).recover();
  expect(
    await db
      .prepare("SELECT status,outcome_code FROM jobs WHERE user_id=? AND id=?")
      .bind(session.tenant.userId, jobId)
      .first(),
  ).toEqual({ status: "canceled", outcome_code: "authorization-changed" });
  const mailSession = { ...session, createdAtMs: now };
  const started = await mailboxService.start(mailSession, "mailbox-b");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("Missing real one-use state");
  await mailboxService.complete(mailSession, {
    state,
    code: "synthetic-verified-code",
  });
  expect(
    await createJobStore(db, { policy, clock: () => now + 300002 }).claim(
      jobId,
    ),
  ).toBeNull();
  const usecases = createOnboardingUsecases({
    repository: createOnboardingRepository(db, {
      ...options,
      ai: selected,
      ready: true,
      clock: () => now + 300002,
    }),
    preparation: {
      prepare: async () => {
        throw new Error("Recovery cannot rescan or reanchor");
      },
    },
  });
  const fresh = await usecases.disclosure(session, {
    connectionId: "mailbox-b",
  });
  const result = await usecases.start(
    session,
    {
      connectionId: fresh.connectionId,
      expectedConnectionGeneration: fresh.connectionGeneration,
      expectedAiSettingsRevision: fresh.aiSettingsRevision,
      expectedProfileVersion: fresh.profileVersion,
      acceptedDisclosureVersion: fresh.disclosureVersion,
      reviewToken: fresh.reviewToken,
      startDate: fresh.startDate,
      endDate: fresh.endDate,
      timezone: fresh.timezone,
      reportingCurrency: fresh.reportingCurrency,
      authorizeHourlySync: true,
    },
    "owned-auth-recovery",
  );
  expect(result).toEqual({ importRunId: parent.id, reused: true });
  expect(fresh.cutoffAt).toBe(parent.frozen_cutoff);
  expect(
    await createJobStore(db, {
      policy,
      clock: () => now + 300002,
    }).checkpoint(oldLease),
  ).toBe(false);
  for (let step = 0; step < 10; step++)
    await createJobStore(db, {
      policy,
      clock: () => now + 300002,
      processingReview: createProcessingReviewResolver(selected),
    }).recover();
  expect(
    await db
      .prepare("SELECT status FROM jobs WHERE user_id=? AND id=?")
      .bind(session.tenant.userId, jobId)
      .first("status"),
  ).toBe("ready");
});

it("strict reviewed recovery leaves schedule, candidate and reservation progress inside one native 24-statement invocation", async () => {
  const selected = inference(),
    destination = selected.destinations[0];
  if (!destination) throw new Error("Missing configured processor");
  destination.endpoint =
    "https://fresh-reviewed.example.invalid/v1/chat/completions";
  await db
    .prepare("UPDATE scheduler_cursors SET last_user_id='',version=version+1")
    .run();
  await db
    .prepare("UPDATE profiles SET job_recovery_cursor='' WHERE user_id=?")
    .bind(session.tenant.userId)
    .run();
  const meter = createInvocationDatabase(env.DB, 24);
  const policy = {
    dispatchLimit: 50,
    scheduleLimit: 50,
    tenantConcurrency: 2,
    globalConcurrency: 20,
    maxAttempts: 3,
    leaseMs: 300000,
    redeliveryMs: 60000,
    queryLimit: 24,
  };
  const store = createJobStore(meter.db, {
    policy,
    clock: () => Date.now() + 1000000,
    processingReview: createProcessingReviewResolver(selected),
  });
  await store.recover();
  await store.scheduleDue();
  const candidates = await store.candidates();
  expect(candidates.length).toBeGreaterThan(0);
  for (const candidate of candidates)
    expect(await store.dispatched(candidate)).toBe(true);
  expect(meter.executedStatements()).toBeLessThanOrEqual(24);
});
