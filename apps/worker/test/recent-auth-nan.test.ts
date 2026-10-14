import { env } from "cloudflare:workers";
import { createLoginAuth, loginConfiguration } from "@invoxim/adapters";
import { expect, it } from "vitest";
import worker from "../src/index";
import { requireFixture } from "./fixture-value";
import { owner } from "./onboarding-qa-fixture";

/**
 * WRK-4 / W4: a session createdAt that decodes to NaN must fail the
 * recent-auth mutation guard. storage/recurring/fx already reject it via
 * Number.isSafeInteger; ai-routes and lifecycle-routes compared NaN
 * without a finite check, so the guard silently passed.
 */
async function fixture(name: string) {
  const session = await owner(name, `mail-${name}`);
  const bindings = {
    DB: env.DB,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://nan-createdat.example.invalid",
    AUTH_SECRET: "synthetic-nan-createdat-secret-never-production-12345",
    AUTH_GOOGLE_CLIENT_ID: "synthetic-login",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic-secret",
    AUTH_ALLOWED_EMAILS: JSON.stringify([session.loginEmail]),
    LIFECYCLE_ENABLED: "true",
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
  // better-auth rehydrates createdAt with new Date(row.createdAt); a
  // non-numeric column value yields an Invalid Date whose getTime() is NaN.
  await env.DB.prepare("UPDATE session SET createdAt=? WHERE id=?")
    .bind("not-a-timestamp", created.id)
    .run();
  return {
    bindings,
    headers,
    origin: login.origin,
  };
}

it("WRK-4 AI settings mutation rejects a NaN session createdAt", async () => {
  const f = await fixture("nan-created-ai");
  const response = await worker.fetch(
    new Request(`${f.origin}/api/ai/settings`, {
      method: "PUT",
      headers: f.headers,
      body: JSON.stringify({}),
    }),
    f.bindings,
  );
  expect(response.status).toBe(403);
  expect((await response.json() as { error: { code: string } }).error.code).toBe(
    "origin_or_recent_auth_required",
  );
});

it("WRK-4 lifecycle mutation rejects a NaN session createdAt", async () => {
  const f = await fixture("nan-created-lifecycle");
  const response = await worker.fetch(
    new Request(`${f.origin}/api/connections/mail-nan-created-lifecycle`, {
      method: "DELETE",
      headers: f.headers,
      body: JSON.stringify({
        confirmed: true,
        generation: 1,
        credentialVersion: 1,
      }),
    }),
    f.bindings,
  );
  expect(response.status).toBe(403);
  expect((await response.json() as { error: { code: string } }).error.code).toBe(
    "recent_auth_required",
  );
});
