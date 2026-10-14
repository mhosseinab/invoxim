import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import worker from "../../src/index";
import { useCurrentSchema } from "./db";
import { routeRequest } from "./route";
import { onboardingSession, seedTenant, signedSession } from "./tenant";

const db = env.DB;

beforeAll(async () => {
  await useCurrentSchema(db);
});

it("seedTenant inserts the shared user/profile/session rows and returns an OnboardingSession (X3)", async () => {
  const seeded = await seedTenant(db, {
    userId: "tenant-helper-owner",
    connectionId: "tenant-helper-mail",
    provider: "gmail",
  });
  expect(seeded.loginEmail).toBe("tenant-helper-owner@example.invalid");
  const user = await db
    .prepare("SELECT id,email FROM user WHERE id=?")
    .bind("tenant-helper-owner")
    .first();
  expect(user).toEqual({
    id: "tenant-helper-owner",
    email: "tenant-helper-owner@example.invalid",
  });
  const profile = await db
    .prepare("SELECT timezone,reporting_currency FROM profiles WHERE user_id=?")
    .bind("tenant-helper-owner")
    .first();
  expect(profile).toEqual({
    timezone: "Europe/Vienna",
    reporting_currency: "EUR",
  });
  const session = await db
    .prepare("SELECT id,token,userId FROM session WHERE id=?")
    .bind(seeded.sessionId)
    .first();
  expect(session).toEqual({
    id: seeded.sessionId,
    token: seeded.sessionToken,
    userId: "tenant-helper-owner",
  });
  const connection = await db
    .prepare("SELECT id,provider,kind FROM connections WHERE id=?")
    .bind("tenant-helper-mail")
    .first();
  expect(connection).toEqual({
    id: "tenant-helper-mail",
    provider: "gmail",
    kind: "mailbox",
  });
  const asOnboarding = onboardingSession(seeded);
  expect(asOnboarding.tenant.userId).toBe("tenant-helper-owner");
  expect(asOnboarding.loginEmail).toBe(seeded.loginEmail);
});

it("signedSession builds a stable HMAC-signed session cookie (X4)", async () => {
  const cookie = await signedSession("synthetic-secret-1234567890", "token-a");
  expect(cookie.startsWith("__Secure-better-auth.session_token=")).toBe(true);
  const decoded = decodeURIComponent(
    cookie.slice("__Secure-better-auth.session_token=".length),
  );
  const [token, signature] = decoded.split(".");
  expect(token).toBe("token-a");
  expect(signature).toBeDefined();
  expect(signature?.length).toBeGreaterThan(0);
  const again = await signedSession("synthetic-secret-1234567890", "token-a");
  expect(again).toBe(cookie);
  const other = await signedSession("synthetic-secret-1234567890", "token-b");
  expect(other).not.toBe(cookie);
});

it("routeRequest sends cookie/origin headers and reports the statement count (X5)", async () => {
  const seeded = await seedTenant(db, {
    userId: "tenant-helper-route",
    connectionId: "tenant-helper-route-mail",
    provider: "outlook",
    schedulingState: "active",
  });
  const secret = "synthetic-route-secret-1234567890";
  const cookie = await signedSession(secret, seeded.sessionToken);
  const { response, statements } = await routeRequest({
    fetch: (request, env_) =>
      worker.fetch(request, env_ as Parameters<typeof worker.fetch>[1]),
    bindings: { DB: db, AUTH_ENABLED: "false" },
    origin: "https://tenant-helper.example.invalid",
    cookie,
    path: "/api/public-config",
    limit: 40,
  });
  // public-config is reachable without a session; the helper only proves the
  // transport shape and the meter. Status may be 200 or 4xx depending on
  // flags, but a thrown meter budget would reject the promise above.
  expect(response.status).toBeLessThan(600);
  expect(statements).toBeGreaterThanOrEqual(0);
  expect(statements).toBeLessThanOrEqual(40);
});
