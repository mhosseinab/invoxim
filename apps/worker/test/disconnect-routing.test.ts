import { env } from "cloudflare:workers";
import { createLoginAuth, loginConfiguration } from "@invoxim/adapters";
import { expect, it } from "vitest";
import { requireFixture } from "../../../packages/testkit/src/fixture-value";
import worker from "../src/index";
import { installOnboardingQaHooks, owner } from "./onboarding-qa-fixture";

installOnboardingQaHooks();

/**
 * WRK-1 / OD-1: plain disconnect is owned by the mailbox sub-app (24488b8)
 * and must work with shipped flags. Shipped wrangler.jsonc sets
 * LIFECYCLE_ENABLED=false, so the composed worker must not answer
 * DELETE /api/connections/:id with lifecycle's 503.
 */
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
    AUTH_ORIGIN: "https://disconnect-routing.example.invalid",
    AUTH_SECRET: "synthetic-disconnect-routing-secret-never-production-12345",
    AUTH_GOOGLE_CLIENT_ID: "synthetic-login",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic-secret",
    AUTH_ALLOWED_EMAILS: JSON.stringify([session.loginEmail]),
    // Shipped flags: LIFECYCLE_ENABLED is false/absent in wrangler.jsonc.
    LIFECYCLE_ENABLED: "false",
  };
  const login = requireFixture(loginConfiguration(bindings));
  const context = await createLoginAuth(env.DB, login).$context;
  const created = requireFixture(
    await context.internalAdapter.createSession(name, false),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(login.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(created.token),
  );
  const headers = {
    Origin: login.origin,
    "Content-Type": "application/json",
    Cookie: `__Secure-better-auth.session_token=${encodeURIComponent(`${created.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`,
  };
  return {
    bindings,
    headers,
    name,
    origin: login.origin,
    disconnect: (
      body = { generation: 1, credentialVersion: 1 },
      id = "outlook",
    ) =>
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

it("WRK-1 composed worker disconnects a mailbox with shipped flags instead of returning 503", async () => {
  const f = await fixture("disconnect-composed");
  const response = await f.disconnect();
  expect(response.status).toBe(204);
});

it("WRK-1 composed worker GET /api/connections is the combined storage view", async () => {
  const f = await fixture("disconnect-composed-list");
  const response = await worker.fetch(
    new Request(`${f.origin}/api/connections`, { headers: f.headers }),
    f.bindings,
  );
  expect(response.status).toBe(200);
});
