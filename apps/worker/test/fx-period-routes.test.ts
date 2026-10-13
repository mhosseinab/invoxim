import { env } from "cloudflare:workers";
import { createLoginAuth, loginConfiguration } from "@invoxim/adapters";
import { beforeAll, expect, it } from "vitest";
import revision from "../../../packages/adapters/migrations/0005_reporting_revision.sql?raw";
import worker from "../src/index";
import { createInvocationDatabase } from "../src/invocation-database";
import { owner } from "./onboarding-qa-fixture";

beforeAll(async () => {
  for (const sql of revision.match(
    /ALTER TABLE[\s\S]*?;|CREATE TRIGGER[\s\S]*?END;/g,
  ) ?? [])
    await env.DB.prepare(sql).run();
});
async function fixture(id: string) {
  const current = await owner(id);
  const bindings = {
    DB: env.DB,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://fx-routes.example.invalid",
    AUTH_SECRET: "synthetic-fx-routes-signing-secret-1234567890",
    AUTH_GOOGLE_CLIENT_ID: "synthetic-login",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic-login-secret",
    AUTH_ALLOWED_EMAILS: JSON.stringify([current.loginEmail]),
  };
  const config = loginConfiguration(bindings);
  if (!config) throw new Error("fixture config missing");
  const adapter = await createLoginAuth(env.DB, config).$context;
  const session = await adapter.internalAdapter.createSession(
    current.tenant.userId,
    false,
  );
  if (!session) throw new Error("fixture session missing");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(config.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(session.token),
  );
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
  return {
    current,
    bindings: {
      ...env,
      ...bindings,
      FX_REFERENCE_ENABLED: "true",
      FX_REFERENCE_ADAPTER: "frankfurter-v2",
      FX_REFERENCE_SOURCE: "ecb",
      FX_MAX_PRIOR_AGE_DAYS: "2",
      FX_REFERENCE_TIMEOUT_MS: "1000",
    },
    session,
    cookie,
    config,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function request(
  f: Fixture,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const meter = createInvocationDatabase(env.DB, 40);
  const response = await worker.fetch(
    new Request(`${f.config.origin}/api/fx/reporting/period`, {
      method: "POST",
      headers: {
        Cookie: f.cookie,
        Origin: f.config.origin,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    { ...f.bindings, DB: meter.db },
  );
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  return response;
}
it("FX-05 actual Worker returns a complete exact period summary with trusted session and no provider call", async () => {
  const f = await fixture("period-route-empty");
  const response = await request(f, {
    filters: { from: "2026-01-01", to: "2026-12-31" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    status: "complete",
    summaryScope: "period",
    reportingCurrency: "EUR",
    stamp: expect.any(String),
    summary: {
      paidMinor: "0",
      refundedMinor: "0",
      netMinor: "0",
      convertedCount: "0",
      pendingCount: "0",
      unconvertedCount: "0",
      reasons: {},
    },
  });
});
it("FX-05 period request rejects client identity and foreign origin before any report", async () => {
  const f = await fixture("period-route-denial");
  expect((await request(f, { filters: {}, actorKey: "attacker" })).status).toBe(
    400,
  );
  expect((await request(f, { filters: {}, userId: "attacker" })).status).toBe(
    400,
  );
  expect(
    (
      await request(
        f,
        { filters: {} },
        { Origin: "https://foreign.example.invalid" },
      )
    ).status,
  ).toBe(403);
  expect((await request(f, { filters: {} }, { Cookie: "" })).status).toBe(401);
});
it("FX-05 real signed stamp cannot be reused by another session or edited and detects earlier mutations", async () => {
  const f = await fixture("period-route-stamp");
  const initial = await request(f, { filters: {} });
  expect(initial.status).toBe(200);
  const page = await initial.json<{ stamp: string }>();
  for (const suffix of [".", "..junk"])
    expect(
      (await request(f, { filters: {}, stamp: `${page.stamp}${suffix}` }))
        .status,
    ).toBe(400);
  const other = await fixture("period-route-other");
  expect(
    (await request(other, { filters: {}, stamp: page.stamp })).status,
  ).toBe(400);
  expect(
    (await request(f, { filters: {}, stamp: `${page.stamp.slice(0, -1)}!` }))
      .status,
  ).toBe(400);
  await env.DB.prepare(
    "UPDATE profiles SET reporting_currency='USD',version=version+1 WHERE user_id=?",
  )
    .bind(f.current.tenant.userId)
    .run();
  const stale = await request(f, { filters: {}, stamp: page.stamp });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    error: { code: "valuation_stale" },
  });
});
