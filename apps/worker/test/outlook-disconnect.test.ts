import { env } from "cloudflare:workers";
import { createLoginAuth, loginConfiguration } from "@invoxim/adapters";
import { expect, it } from "vitest";
import { requireFixture } from "../../../packages/testkit/src/fixture-value";
import worker from "../src/index";
import { installOnboardingQaHooks, owner } from "./onboarding-qa-fixture";
import { signedSession } from "./support/tenant";

installOnboardingQaHooks();

async function fixture(name: string) {
  const session = await owner(name, "outlook");
  await env.DB.prepare(
    "UPDATE connections SET provider='outlook' WHERE user_id=?",
  )
    .bind(name)
    .run();
  const bindings = {
    DB: env.DB,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://disconnect.example.invalid",
    AUTH_SECRET: "synthetic-disconnect-secret-never-production-12345",
    AUTH_GOOGLE_CLIENT_ID: "synthetic-login",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic-secret",
    AUTH_ALLOWED_EMAILS: JSON.stringify([session.loginEmail]),
  };
  const login = requireFixture(loginConfiguration(bindings));
  const context = await createLoginAuth(env.DB, login).$context;
  const created = requireFixture(
    await context.internalAdapter.createSession(name, false),
  );
  const headers = {
    Origin: login.origin,
    "Content-Type": "application/json",
    Cookie: await signedSession(login.secret, created.token),
  };
  return {
    bindings,
    headers,
    name,
    sessionId: created.id,
    request: (body = { generation: 1, credentialVersion: 1 }, id = "outlook") =>
      worker.fetch(
        new Request(`${login.origin}/api/connections/${id}`, {
          method: "DELETE",
          headers,
          body: JSON.stringify(body),
        }),
        bindings,
      ),
  };
}

it("OUTLOOK-01 disconnect remains available without OAuth configuration and is idempotent", async () => {
  const f = await fixture("disconnect-disabled");
  expect((await f.request()).status).toBe(204);
  expect((await f.request()).status).toBe(204);
  expect(
    await env.DB.prepare(
      "SELECT state,scheduling_state,generation,credential_version,credential_ciphertext FROM connections WHERE user_id=?",
    )
      .bind(f.name)
      .first(),
  ).toEqual({
    state: "disconnected",
    scheduling_state: "paused",
    generation: 2,
    credential_version: 2,
    credential_ciphertext: null,
  });
  expect(
    (
      await worker.fetch(
        new Request(`${f.bindings.AUTH_ORIGIN}/api/connections`, {
          headers: f.headers,
        }),
        f.bindings,
      )
    ).status,
  ).toBe(200);
});

it("OUTLOOK-01 rejects stale versions and foreign connections", async () => {
  const f = await fixture("disconnect-fences");
  expect(
    (await f.request({ generation: 2, credentialVersion: 1 })).status,
  ).toBe(409);
  expect((await f.request(undefined, "foreign")).status).toBe(404);
  await env.DB.prepare("UPDATE session SET createdAt=0 WHERE id=?")
    .bind(f.sessionId)
    .run();
  expect((await f.request()).status).toBe(403);
});

it("OUTLOOK-01 disconnect uses the owned provider when both providers are configured", async () => {
  const f = await fixture("disconnect-both");
  const configured = {
    ...f.bindings,
    GMAIL_ENABLED: "true",
    GMAIL_CLIENT_ID: "synthetic-gmail",
    GMAIL_CLIENT_SECRET: "synthetic-secret",
    OUTLOOK_ENABLED: "true",
    OUTLOOK_CLIENT_ID: "11111111-2222-4333-8444-555555555555",
    OUTLOOK_CLIENT_SECRET: "synthetic-secret",
    OUTLOOK_AUTHORITY: "common",
    CREDENTIAL_KEYRING: JSON.stringify({
      activeVersion: 1,
      keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    }),
  };
  const foreign = await owner("disconnect-foreign", "foreign-owned");
  const request = (id: string, origin = f.bindings.AUTH_ORIGIN) =>
    worker.fetch(
      new Request(`${f.bindings.AUTH_ORIGIN}/api/connections/${id}`, {
        method: "DELETE",
        headers: { ...f.headers, Origin: origin },
        body: JSON.stringify({ generation: 1, credentialVersion: 1 }),
      }),
      configured,
    );
  expect((await request("foreign-owned")).status).toBe(404);
  expect(
    (await request("outlook", "https://foreign.example.invalid")).status,
  ).toBe(403);
  expect((await request("outlook")).status).toBe(204);
  expect(
    (
      await env.DB.prepare(
        "SELECT state FROM connections WHERE user_id=? AND id='foreign-owned'",
      )
        .bind(foreign.tenant.userId)
        .first()
    )?.state,
  ).toBe("connected");
});
