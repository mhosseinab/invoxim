import { env } from "cloudflare:workers";
import type { AuthBindings } from "@invoxim/adapters";
import { beforeAll, expect, it, vi } from "vitest";
import { useCurrentSchema } from "./support/db";
import { statementCounter } from "./support/faults";
import { seedTenant, signedSession } from "./support/tenant";

/**
 * G-40 (WRK-5 review finding 4): one D1 statement meter per request. PATCH
 * /api/me must run the guard and the profile update on the same 40-statement
 * meter, so the whole request is accounted against one budget.
 */
const meters = vi.hoisted(
  () => [] as { executedStatements: () => number; limit: number }[],
);
vi.mock("../src/invocation-database", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/invocation-database")>();
  return {
    ...actual,
    createInvocationDatabase(nativeDatabase: D1Database, limit: number) {
      const meter = actual.createInvocationDatabase(nativeDatabase, limit);
      meters.push({ executedStatements: meter.executedStatements, limit });
      return meter;
    },
  };
});

const db = env.DB;
const origin = "https://me-meter.example.invalid";
const secret = "synthetic-me-meter-secret-never-use-live-1234567890";
const bindings: AuthBindings = {
  DB: env.DB,
  AUTH_ENABLED: "true",
  AUTH_ORIGIN: origin,
  AUTH_SECRET: secret,
  AUTH_GOOGLE_CLIENT_ID: "synthetic",
  AUTH_GOOGLE_CLIENT_SECRET: "synthetic",
  AUTH_ALLOWED_EMAILS: JSON.stringify(["me-meter@example.invalid"]),
};
let cookie = "";
let createAuthRoutes: typeof import("../src/auth-routes").createAuthRoutes;
beforeAll(async () => {
  // Test files share a runtime (isolate: false), so the route module may
  // already be loaded unmocked; reload it so the mock above applies.
  vi.resetModules();
  ({ createAuthRoutes } = await import("../src/auth-routes"));
  await useCurrentSchema(db);
  const seeded = await seedTenant(db, { userId: "me-meter" });
  cookie = await signedSession(secret, seeded.sessionToken);
  // Re-evaluating the route module graph can exceed the default 10 s hook
  // budget on a loaded host.
}, 60000);

it("G-40 PATCH /api/me runs guard and update on one shared 40-statement meter", async () => {
  const counted = statementCounter(db);
  meters.length = 0;
  const response = await createAuthRoutes().request(
    `${origin}/api/me`,
    {
      method: "PATCH",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timezone: "Europe/Berlin",
        reportingCurrency: "EUR",
        version: 1,
      }),
    },
    { ...bindings, DB: counted.db },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    settings: { timezone: "Europe/Berlin", version: 2 },
  });
  expect(meters).toHaveLength(1);
  const [meter] = meters;
  expect(meter?.limit).toBe(40);
  // Every statement the request executed went through that single meter.
  expect(meter?.executedStatements()).toBe(counted.count());
  expect(counted.count()).toBeLessThanOrEqual(40);
});
