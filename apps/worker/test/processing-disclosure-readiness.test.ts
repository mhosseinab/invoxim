import { env } from "cloudflare:workers";
import { createLoginAuth, type LoginConfiguration } from "@invoxim/adapters";
import { beforeAll, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import {
  createOnboardingRoutes,
  type OnboardingBindings,
} from "../src/onboarding-routes";

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
  const unavailableDatabase = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "prepare")
        return () => {
          throw new Error("Synthetic database unavailable");
        };
      return Reflect.get(target, property, receiver);
    },
  });
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
