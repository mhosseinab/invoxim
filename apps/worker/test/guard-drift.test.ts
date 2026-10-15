import { env } from "cloudflare:workers";
import type { AuthBindings } from "@invoxim/adapters";
import { issueWorkspaceMutationToken } from "@invoxim/adapters";
import { Hono } from "hono";
import { beforeAll, expect, it } from "vitest";
import { createAuthRoutes } from "../src/auth-routes";
import { createFxRoutes } from "../src/fx-routes";
import { apiError, requireTenantContext } from "../src/http/guard";
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
let sessionId = "";
beforeAll(async () => {
  await useCurrentSchema(db);
  const seeded = await seedTenant(db, { userId: "guard-drift" });
  cookie = await signedSession(secret, seeded.sessionToken);
  sessionId = seeded.sessionId;
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

it.each([
  ["source_not_configured", false],
  ["source_unreadable", false],
  ["source_unavailable", true],
  ["source_changed", true],
] as const)(
  "G3 review-source 503 %s has retryable=%s",
  async (code, retryable) => {
    const body = errorBody(await apiError(503, code).json());
    expect(body).toMatchObject({ code, retryable });
  },
);

it("G3 auth_not_configured is not retryable", async () => {
  const unconfigured = {
    ...bindings,
    AUTH_ENABLED: undefined,
    AUTH_SECRET: undefined,
  };
  // Login configuration missing → /api/me has no tenant guard: 401, not 503.
  const response = await auth.request(
    `${origin}/api/me`,
    { headers: { Cookie: cookie, Origin: origin } },
    unconfigured,
  );
  expect(response.status).toBe(401);
  expect(errorBody(await response.json())).toMatchObject({
    code: "unauthorized",
    retryable: false,
  });
  // The auth/* path reports the operator configuration gap.
  const login = await auth.request(
    `${origin}/api/auth/get-session`,
    { headers: { Cookie: cookie, Origin: origin } },
    unconfigured,
  );
  expect(login.status).toBe(503);
  expect(errorBody(await login.json())).toMatchObject({
    code: "auth_not_configured",
    retryable: false,
  });
});

it("G3 a mutation guard without a token purpose fails closed instead of accepting a corrections token", async () => {
  const app = new Hono<{ Bindings: AuthBindings }>();
  app.post("/api/synthetic-mutation", async (c) => {
    const ready = await requireTenantContext(
      c,
      // A caller that forgot the purpose (only reachable by bypassing types).
      { mutation: true, recent: false } as never,
    );
    if ("response" in ready) return ready.response;
    return Response.json({ ok: true });
  });
  const token = await issueWorkspaceMutationToken(
    { userId: "guard-drift", sessionId: sessionId },
    secret,
    Date.now,
    "corrections",
  );
  const response = await app.request(
    `${origin}/api/synthetic-mutation`,
    {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "X-Workspace-Token": token },
    },
    bindings,
  );
  expect(response.status).toBe(403);
  expect(errorBody(await response.json()).code).toBe(
    "workspace_changed_or_expired",
  );
});

it("G3 the guard's token purpose is required by type for every mutation-capable call", () => {
  // Type-level pin, checked by `tsc --noEmit` (tests are in the tsconfig).
  type Options = Parameters<typeof requireTenantContext>[1];
  // @ts-expect-error a mutation-capable guard must name its token purpose
  const missing: Options = { recent: false };
  // @ts-expect-error a mutation guard must name its token purpose
  const mutation: Options = { mutation: true };
  const readOnly: Options = { mutation: false, recent: false };
  const purposeful: Options = { purpose: "lifecycle" };
  expect([missing, mutation, readOnly, purposeful]).toHaveLength(4);
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
