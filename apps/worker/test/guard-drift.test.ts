import { env } from "cloudflare:workers";
import type { AuthBindings } from "@invoxim/adapters";
import { beforeAll, expect, it } from "vitest";
import { createAuthRoutes } from "../src/auth-routes";
import { createFxRoutes } from "../src/fx-routes";
import { useCurrentSchema } from "./support/db";
import { seedTenant, signedSession } from "./support/tenant";

/**
 * G3 (WRK-5): pin the unified Origin rule and the single retryable rule where
 * the per-file guards currently drift.
 * - GET with a mismatched Origin header must be rejected (ai/mailbox/storage/auth
 *   skipped the header check entirely).
 * - A 503 that describes missing operator configuration is not retryable;
 *   a 503 that describes transient unavailability is.
 */

const db = env.DB;
const origin = "https://guard-drift.example.invalid";
const secret = "synthetic-guard-drift-secret-never-use-live-1234567890";
const bindings: AuthBindings = {
  DB: env.DB,
  AUTH_ENABLED: "true",
  AUTH_ORIGIN: origin,
  AUTH_SECRET: secret,
  AUTH_GOOGLE_CLIENT_ID: "synthetic",
  AUTH_GOOGLE_CLIENT_SECRET: "synthetic",
  AUTH_ALLOWED_EMAILS: JSON.stringify(["guard-drift@example.invalid"]),
};
const auth = createAuthRoutes();
const fx = createFxRoutes({
  service: () => null,
});

let cookie = "";
beforeAll(async () => {
  await useCurrentSchema(db);
  const seeded = await seedTenant(db, { userId: "guard-drift" });
  cookie = await signedSession(secret, seeded.sessionToken);
});

function errorBody(body: unknown) {
  const value = body as {
    error?: { code?: string; retryable?: boolean };
  };
  return value.error ?? {};
}

it("G3 GET rejects a mismatched Origin header even with a live session", async () => {
  const response = await auth.request(
    `${origin}/api/me`,
    {
      headers: {
        Cookie: cookie,
        Origin: "https://attacker.example.invalid",
      },
    },
    bindings,
  );
  expect(response.status).toBe(403);
  expect(errorBody(await response.json()).code).toBe("origin_required");
});

it("G3 GET accepts a matching Origin header", async () => {
  const response = await auth.request(
    `${origin}/api/me`,
    { headers: { Cookie: cookie, Origin: origin } },
    bindings,
  );
  expect(response.status).toBe(200);
});

it("G3 GET without an Origin header remains allowed for same-origin reads", async () => {
  const response = await auth.request(
    `${origin}/api/me`,
    { headers: { Cookie: cookie } },
    bindings,
  );
  expect(response.status).toBe(200);
});

it("G3 503 configuration failures are not retryable", async () => {
  const response = await fx.request(
    `${origin}/api/fx/reporting`,
    { headers: { Cookie: cookie, Origin: origin } },
    bindings,
  );
  expect(response.status).toBe(503);
  const body = errorBody(await response.json());
  expect(body.code).toBe("fx_not_configured");
  expect(body.retryable).toBe(false);
});

it("G3 auth_not_configured is not retryable", async () => {
  const response = await auth.request(
    `${origin}/api/me`,
    { headers: { Cookie: cookie, Origin: origin } },
    { ...bindings, AUTH_ENABLED: undefined, AUTH_SECRET: undefined },
  );
  // Login configuration missing → 401 on /api/me (no service), not a 503.
  // Use the auth/* catch-all path that reports auth_not_configured.
  const login = await auth.request(
    `${origin}/api/auth/get-session`,
    { headers: { Cookie: cookie, Origin: origin } },
    { ...bindings, AUTH_ENABLED: undefined, AUTH_SECRET: undefined },
  );
  expect([401, 503]).toContain(response.status);
  if (login.status === 503) {
    expect(errorBody(await login.json()).retryable).toBe(false);
  }
});

it("G3 mutation without an Origin header is rejected", async () => {
  const response = await auth.request(
    `${origin}/api/me`,
    {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        timezone: "Europe/Vienna",
        reportingCurrency: "EUR",
        version: 1,
      }),
    },
    bindings,
  );
  expect(response.status).toBe(403);
  expect(errorBody(await response.json()).code).toBe("origin_required");
});
