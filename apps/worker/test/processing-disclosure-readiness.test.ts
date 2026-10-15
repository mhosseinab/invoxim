import { env } from "cloudflare:workers";
import { createLoginAuth, type LoginConfiguration } from "@invoxim/adapters";
import { aiSettingsResponseSchema } from "@invoxim/contracts";
import { beforeAll, expect, it, vi } from "vitest";
import runtimeText from "../../../config/ai.abacus.production.json?raw";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { createAiRoutes } from "../src/ai-routes";
import worker from "../src/index";
import {
  createOnboardingRoutes,
  type OnboardingBindings,
} from "../src/onboarding-routes";
import { syntheticClassificationBindings } from "./classification-fixture";
import { faultingDatabase } from "./support/faults";

const db = env.DB;
const userId = "synthetic-disclosure-owner";
const configuration: LoginConfiguration = {
  origin: "https://synthetic.example",
  secret: "synthetic-disclosure-secret-never-live-123",
  googleClientId: "synthetic-client",
  googleClientSecret: "synthetic-client-secret",
  allowedEmails: ["disclosure@example.invalid"],
};
const bindings: OnboardingBindings = {
  DB: db,
  AUTH_ENABLED: "true",
  AUTH_ORIGIN: configuration.origin,
  AUTH_SECRET: configuration.secret,
  AUTH_GOOGLE_CLIENT_ID: configuration.googleClientId,
  AUTH_GOOGLE_CLIENT_SECRET: configuration.googleClientSecret,
  AUTH_ALLOWED_EMAILS: JSON.stringify(configuration.allowedEmails),
  AI_ENABLED: "false",
  EXTRACTION_ENABLED: "false",
  GMAIL_DISCOVERY_ENABLED: "false",
  JOBS_ENABLED: "false",
};
const app = createOnboardingRoutes();
let cookie: string;

beforeAll(async () => {
  for (const statement of baseline.split(";").filter((value) => value.trim()))
    await db.prepare(statement).run();
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
    )
    .bind(userId, "Synthetic", configuration.allowedEmails[0])
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind(userId)
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes) VALUES(?,?,'mailbox','gmail',?,?,?)",
    )
    .bind(
      "synthetic-owned-mailbox",
      userId,
      "synthetic-subject",
      "mailbox@example.invalid",
      JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
    )
    .run();
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
    )
    .bind("synthetic-foreign-owner", "Synthetic Other", "other@example.invalid")
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind("synthetic-foreign-owner")
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes) VALUES(?,?,'mailbox','gmail',?,?,?)",
    )
    .bind(
      "synthetic-foreign-mailbox",
      "synthetic-foreign-owner",
      "synthetic-foreign-subject",
      "foreign@example.invalid",
      JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
    )
    .run();
  const auth = createLoginAuth(db, configuration);
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(userId, false);
  if (!session) throw new Error("Synthetic session creation failed");
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
  const signed = encodeURIComponent(
    `${session.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`,
  );
  cookie = `__Secure-better-auth.session_token=${signed}`;
});

function disclosure(query: string, authenticated = true) {
  return app.request(
    `${configuration.origin}/api/processing-disclosure?${query}`,
    { headers: authenticated ? { Cookie: cookie } : {} },
    bindings,
  );
}

it("ONBOARD-04 reports missing processing configuration without inviting repeated retries or creating work", async () => {
  const response = await disclosure(
    "connectionId=synthetic-owned-mailbox&timezone=Europe/Vienna",
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    error: { code: "processing_not_configured", retryable: false },
  });
  for (const table of ["jobs", "processing_consents", "import_runs"])
    expect(
      await db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id=?`)
        .bind(userId)
        .first("count"),
    ).toBe(0);
});

it("ONBOARD-04 configuration diagnostics require a verified session", async () => {
  const response = await disclosure(
    "connectionId=synthetic-owned-mailbox",
    false,
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    error: { code: "unauthorized" },
  });
});

it("ONBOARD-04 unavailable processors do not bypass owned-mailbox authorization", async () => {
  for (const connectionId of [
    "synthetic-unowned-mailbox",
    "synthetic-foreign-mailbox",
  ]) {
    const response = await disclosure(`connectionId=${connectionId}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
  }
});

it("ONBOARD-04 unavailable processors preserve strict disclosure query validation", async () => {
  for (const query of [
    "connectionId=synthetic-owned-mailbox&timezone=invalid-zone",
    "connectionId=synthetic-owned-mailbox&userId=synthetic-other-owner",
    "connectionId=synthetic-owned-mailbox&connectionId=synthetic-unowned-mailbox",
  ]) {
    const response = await disclosure(query);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
  }
});

it("ONBOARD-04 runtime failures remain retryable even when processing is unconfigured", async () => {
  const { db: unavailableDatabase } = faultingDatabase(db, [
    {
      once: false,
      on: "prepare",
      fire: () => {
        throw new Error("Synthetic database unavailable");
      },
    },
  ]);
  const response = await app.request(
    `${configuration.origin}/api/processing-disclosure?connectionId=synthetic-owned-mailbox`,
    { headers: { Cookie: cookie } },
    { ...bindings, DB: unavailableDatabase },
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { code: "processing_unavailable", retryable: true },
  });
});

it("ONBOARD-04 connection capacity failures remain retryable when processing is unconfigured", async () => {
  const connectionIds = Array.from(
    { length: 10 },
    (_, index) => `synthetic-capacity-mailbox-${index}`,
  );
  try {
    for (const connectionId of connectionIds)
      await db
        .prepare(
          "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes) VALUES(?,?,'mailbox','gmail',?,?,?)",
        )
        .bind(
          connectionId,
          userId,
          connectionId,
          "capacity@example.invalid",
          JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
        )
        .run();
    const response = await disclosure("connectionId=synthetic-owned-mailbox");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "processing_unavailable", retryable: true },
    });
  } finally {
    for (const connectionId of connectionIds)
      await db
        .prepare("DELETE FROM connections WHERE user_id=? AND id=?")
        .bind(userId, connectionId)
        .run();
  }
});

it("AI-03/ONBOARD-04 approved Abacus runtime variables make both read endpoints available without calling a model or starting import", async () => {
  const preset = JSON.parse(runtimeText);
  const configured = {
    ...bindings,
    ...preset.variables,
    ...syntheticClassificationBindings,
    AI_REGISTRY_JSON: JSON.stringify(preset.registry),
    AI_BUDGET_JSON: JSON.stringify(preset.budget),
    AI_HOSTED_KEY: "synthetic-abacus-hosted-key",
    CREDENTIAL_KEYRING: JSON.stringify({
      activeVersion: 1,
      keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    }),
  };
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected external request"));
  try {
    const settings = await createAiRoutes().request(
      `${configuration.origin}/api/ai/settings`,
      { headers: { Cookie: cookie } },
      configured,
    );
    expect(settings.status).toBe(200);
    const result = aiSettingsResponseSchema.parse(await settings.json());
    expect(result.providers).toEqual([
      {
        id: "abacus-routellm",
        models: ["gpt-6-luna"],
        policyVersion: 1,
        noticeRefs: ["abacus-routellm-v1", "openai-upstream-v1"],
      },
    ]);
    expect(result.allowance.hostedFundingAvailable).toBe(true);
    const response = await app.request(
      `${configuration.origin}/api/processing-disclosure?connectionId=synthetic-owned-mailbox&timezone=Europe/Vienna`,
      { headers: { Cookie: cookie } },
      configured,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const disclosure = await response.json();
    expect(disclosure).toMatchObject({
      inference: {
        providerId: "abacus-routellm",
        model: "gpt-6-luna",
        mode: "hosted",
      },
      canStartImport: false,
      availability: "configuration",
    });
    expect(transport).not.toHaveBeenCalled();
    for (const table of ["jobs", "processing_consents", "import_runs"])
      expect(
        await db
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id=?`)
          .bind(userId)
          .first("count"),
      ).toBe(0);
    expect(preset.budget.globalDailyUsdMicros).toBe("1000000");
    expect(preset.budget.globalMonthlyUsdMicros).toBe("10000000");
  } finally {
    transport.mockRestore();
  }
});

it("AI-03 Worker loads the server-side preset with Wrangler secrets and the AI binding, without copied AI variables", async () => {
  const base = { ...bindings };
  delete base.AI_ENABLED;
  const configured = {
    ...base,
    AI: {
      async run() {
        throw new Error("UNEXPECTED_CLASSIFICATION_CALL");
      },
    },
    AI_HOSTED_KEY: "synthetic-abacus-hosted-key",
    CREDENTIAL_KEYRING: JSON.stringify({
      activeVersion: 1,
      keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    }),
  };
  const response = await worker.request(
    `${configuration.origin}/api/ai/settings`,
    { headers: { Cookie: cookie } },
    configured,
  );
  expect(response.status).toBe(200);
  expect(
    aiSettingsResponseSchema.parse(await response.json()).providers[0]?.id,
  ).toBe("abacus-routellm");
  const disabled = await worker.request(
    `${configuration.origin}/api/ai/settings`,
    { headers: { Cookie: cookie } },
    { ...configured, AI_ENABLED: "false" },
  );
  expect(disabled.status).toBe(503);
  const missingKey = { ...configured };
  Reflect.deleteProperty(missingKey, "AI_HOSTED_KEY");
  const unavailable = await worker.request(
    `${configuration.origin}/api/ai/settings`,
    { headers: { Cookie: cookie } },
    missingKey,
  );
  expect(unavailable.status).toBe(503);
});
