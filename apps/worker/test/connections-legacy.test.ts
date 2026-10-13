import { env } from "cloudflare:workers";
import { createLoginAuth, loginConfiguration } from "@invoxim/adapters";
import { beforeAll, expect, it } from "vitest";
import worker from "../src/index";

import auth from "./migrations/historical/0001_auth.sql?raw";
import records from "./migrations/historical/0002_records.sql?raw";
import indexes from "./migrations/historical/0003_indexes_and_schedule.sql?raw";
import credentials from "./migrations/historical/0004_credentials_and_oauth.sql?raw";
import profile from "./migrations/historical/0005_profile_version.sql?raw";
import jobs from "./migrations/historical/0006_jobs.sql?raw";
import mailbox from "./migrations/historical/0007_mailbox.sql?raw";
import discovery from "./migrations/historical/0008_discovery.sql?raw";
import ai from "./migrations/historical/0009_ai.sql?raw";
import pipeline from "./migrations/historical/0010_ledger_pipeline.sql?raw";
import lifecycle from "./migrations/historical/0011_lifecycle.sql?raw";
import review from "./migrations/historical/0012_review_fields.sql?raw";
import corrections from "./migrations/historical/0013_corrections.sql?raw";
import onboarding from "./migrations/historical/0014_onboarding.sql?raw";
import fx from "./migrations/historical/0015_fx.sql?raw";
import outlook from "./migrations/historical/0016_outlook_folders.sql?raw";

const db = env.DB;

// This compatibility case deliberately installs the real pre-Drive schema.
beforeAll(async () => {
  for (const sql of [
    auth,
    records,
    indexes,
    credentials,
    profile,
    jobs,
    mailbox,
    discovery,
    ai,
    pipeline,
    lifecycle,
    review,
    corrections,
    onboarding,
    fx,
    outlook,
  ])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
});
async function owner(userId: string) {
  const loginEmail = `${userId}@example.invalid`;
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)",
    )
    .bind(userId, "Synthetic legacy owner", loginEmail)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,timezone,reporting_currency,created_at,updated_at) VALUES(?,'Europe/Vienna','EUR',0,0)",
    )
    .bind(userId)
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes,credential_ciphertext,credential_key_version,credential_version,scheduling_state) VALUES('mailbox-b',?,'mailbox','gmail','mailbox-b','selected-b@example.invalid',?,'synthetic-encrypted-token',1,1,'awaiting_import')",
    )
    .bind(
      userId,
      JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
    )
    .run();
  return { tenant: { userId }, loginEmail };
}

it("canonical private metadata works before the optional Drive migration and without OAuth adapters", async () => {
  const current = await owner("connections-pre-drive");
  const bindings = {
    DB: env.DB,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://connections-legacy.example.invalid",
    AUTH_SECRET: "synthetic-legacy-connection-secret-1234567890",
    AUTH_GOOGLE_CLIENT_ID: "synthetic-login",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic-login-secret",
    AUTH_ALLOWED_EMAILS: JSON.stringify([current.loginEmail]),
  };
  const login = loginConfiguration(bindings);
  if (!login) throw new Error("Synthetic login fixture unavailable");
  const auth = await createLoginAuth(db, login).$context;
  const session = await auth.internalAdapter.createSession(
    current.tenant.userId,
    false,
  );
  if (!session) throw new Error("Synthetic session not created");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(login.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(session.token),
  );
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${btoa(String.fromCharCode(...new Uint8Array(signed)))}`)}`;
  expect(
    await db
      .prepare("SELECT name FROM sqlite_schema WHERE name='archive_settings'")
      .first(),
  ).toBeNull();
  const response = await worker.fetch(
    new Request(`${login.origin}/api/connections`, {
      headers: { Cookie: cookie },
    }),
    bindings,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const value = (await response.json()) as {
    connections: unknown[];
    hasMore: boolean;
  };
  expect(value.connections).toEqual([
    expect.objectContaining({
      id: "mailbox-b",
      kind: "mailbox",
      provider: "gmail",
      configured: true,
    }),
  ]);
  expect(value.hasMore).toBe(false);
  expect(JSON.stringify(value)).not.toContain("synthetic-encrypted-token");
});
