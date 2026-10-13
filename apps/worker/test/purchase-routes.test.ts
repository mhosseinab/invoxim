// Explicit populated historical-upgrade fixture; old SQL is never an active deployment migration.

import { env } from "cloudflare:workers";
import type { AuthBindings, LoginConfiguration } from "@invoxim/adapters";
import { createLoginAuth } from "@invoxim/adapters";
import { purchaseListResponseSchema } from "@invoxim/contracts";
import { beforeAll, expect, it } from "vitest";
import { createInvocationDatabase } from "../src/invocation-database";
import { createPurchaseRoutes } from "../src/purchase-routes";
import authMigration from "./migrations/historical/0001_auth.sql?raw";
import records from "./migrations/historical/0002_records.sql?raw";
import schedule from "./migrations/historical/0003_indexes_and_schedule.sql?raw";
import credentials from "./migrations/historical/0004_credentials_and_oauth.sql?raw";
import profiles from "./migrations/historical/0005_profile_version.sql?raw";
import jobs from "./migrations/historical/0006_jobs.sql?raw";
import mailbox from "./migrations/historical/0007_mailbox.sql?raw";
import discovery from "./migrations/historical/0008_discovery.sql?raw";
import ai from "./migrations/historical/0009_ai.sql?raw";
import pipeline from "./migrations/historical/0010_ledger_pipeline.sql?raw";
import lifecycle from "./migrations/historical/0011_lifecycle.sql?raw";
import reviewFields from "./migrations/historical/0012_review_fields.sql?raw";
import corrections from "./migrations/historical/0013_corrections.sql?raw";
import onboarding from "./migrations/historical/0014_onboarding.sql?raw";

const db = env.DB;

const config: LoginConfiguration = {
  origin: "https://views.example.invalid",
  secret: "synthetic-purchase-route-secret-never-use-live-123",
  googleClientId: "synthetic",
  googleClientSecret: "synthetic",
  allowedEmails: ["route-a@example.invalid", "route-b@example.invalid"],
};
const bindings: AuthBindings = {
  DB: env.DB,
  AUTH_ENABLED: "true",
  AUTH_ORIGIN: config.origin,
  AUTH_SECRET: config.secret,
  AUTH_GOOGLE_CLIENT_ID: config.googleClientId,
  AUTH_GOOGLE_CLIENT_SECRET: config.googleClientSecret,
  AUTH_ALLOWED_EMAILS: JSON.stringify(config.allowedEmails),
};
const cookies = new Map<string, string>();
const app = createPurchaseRoutes();
beforeAll(async () => {
  for (const sql of [
    authMigration,
    records,
    schedule,
    credentials,
    profiles,
    jobs,
    mailbox,
    discovery,
    ai,
    pipeline,
    lifecycle,
    reviewFields,
  ])
    for (const statement of sql.split(";").filter((s) => s.trim()))
      await db.prepare(statement).run();
  const context = await createLoginAuth(db, config).$context;
  for (const id of ["route-a", "route-b"]) {
    await db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)',
      )
      .bind(id, id, `${id}@example.invalid`, Date.now(), Date.now())
      .run();
    await db
      .prepare(
        "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
      )
      .bind(id, Date.now(), Date.now())
      .run();
    await db
      .prepare(
        "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES(?,?,?,'synthetic','2026-10-01',NULL,NULL,'unknown')",
      )
      .bind(`purchase-${id}`, id, `Synthetic ${id}`)
      .run();
    const session = await context.internalAdapter.createSession(id, false);
    if (!session) throw new Error("fixture session");
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
    cookies.set(
      id,
      `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`,
    );
  }
  // Preserve signed sessions and owned legacy records across the current schema upgrade.
  for (const sql of [corrections, onboarding])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
function cookie(id = "route-a") {
  const value = cookies.get(id);
  if (!value) throw new Error("fixture cookie");
  return value;
}
it("authenticated reads require verified signed live session and exact origin", async () => {
  for (const path of ["", "/summary", "/coverage", "/purchase-route-b"]) {
    expect(
      (await app.request(`${config.origin}/api/purchases${path}`, {}, bindings))
        .status,
    ).toBe(401);
    expect(
      (
        await app.request(
          `${config.origin}/api/purchases${path}`,
          {
            headers: {
              Cookie: "__Secure-better-auth.session_token=forged",
              "X-User-Id": "route-b",
            },
          },
          bindings,
        )
      ).status,
    ).toBe(401);
  }
  expect(
    (
      await app.request(
        `${config.origin}/api/purchases`,
        {
          headers: {
            Cookie: cookie(),
            Origin: "https://attacker.example.invalid",
          },
        },
        bindings,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request(
        "https://attacker.example.invalid/api/purchases",
        { headers: { Cookie: cookie() } },
        bindings,
      )
    ).status,
  ).toBe(403);
});
it("UI-03 actual session reads work without Gmail or AI configuration and ignore forged identity headers", async (ctx) => {
  const meter = createInvocationDatabase(env.DB, 40);
  const response = await app.request(
    `${config.origin}/api/purchases`,
    { headers: { Cookie: cookie(), "X-User-Id": "route-b" } },
    { ...bindings, DB: meter.db },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    rows: [
      {
        id: "purchase-route-a",
        merchant: "Synthetic route-a",
        documentTotalMinor: null,
        currency: null,
      },
    ],
    nextCursor: null,
  });
  expect(meter.executedStatements()).toBeGreaterThan(0);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  ctx.annotate(
    `actual signed-session list statement count ${meter.executedStatements()}`,
  );
  const detail = await app.request(
    `${config.origin}/api/purchases/purchase-route-b`,
    { headers: { Cookie: cookie() } },
    bindings,
  );
  expect(detail.status).toBe(404);
  expect(detail.headers.get("cache-control")).toBe("no-store");
});
it("strict bounded query rejects duplicate fields, identity injection, invalid periods and cursors", async () => {
  for (const suffix of [
    "?userId=route-b",
    "?limit=51",
    "?limit=0",
    "?q=a&q=b",
    "?from=2026-02-30",
    "?from=2026-11-01&to=2026-10-01",
    "?cursor=bad",
    "?paymentState=all",
    "/summary?cursor=bad",
    "/coverage?userId=route-b",
  ]) {
    const response = await app.request(
      `${config.origin}/api/purchases${suffix}`,
      { headers: { Cookie: cookie() } },
      bindings,
    );
    expect(response.status, suffix).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});
it("HOME-03 empty financial evidence and original-currency exclusions are explicit", async () => {
  const response = await app.request(
    `${config.origin}/api/purchases/summary`,
    { headers: { Cookie: cookie() } },
    bindings,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    totals: [],
    dateBasis: "event",
    recordCount: 1,
    unpaidCount: 0,
    unknownCount: 1,
    reviewCount: 0,
    excludedEntryCount: 0,
    missingCurrencyCount: 1,
    conversion: "not_configured",
  });
  const coverage = await app.request(
    `${config.origin}/api/purchases/coverage`,
    { headers: { Cookie: cookie() } },
    bindings,
  );
  expect(coverage.status).toBe(200);
  expect(await coverage.json()).toEqual({
    readyPurchaseCount: 1,
    openReviewCount: 0,
    connections: [],
  });
});
it("deletion barrier revokes reads despite still-signed cookie and DB failures disclose only safe errors", async () => {
  await db
    .prepare("UPDATE profiles SET status='deleting' WHERE user_id='route-b'")
    .run();
  expect(
    (
      await app.request(
        `${config.origin}/api/purchases`,
        { headers: { Cookie: cookie("route-b") } },
        bindings,
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await app.request(
        `${config.origin}/api/purchases`,
        { headers: { Cookie: cookie() } },
        { ...bindings, AUTH_ENABLED: "false" },
      )
    ).status,
  ).toBe(401);
});
it("UI-03 transport bounds handle Unicode long natural identities without skipped ties or oversized JSON", async () => {
  const ids = Array.from(
    { length: 40 },
    (_, index) =>
      `unicode-${String(index).padStart(2, "0")}-${"界".repeat(1500)}`,
  );
  await db.batch(
    ids.map((id) =>
      db
        .prepare(
          "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES(?,'route-a','Long identifiers','long identifiers','2026-10-01',NULL,NULL,'unknown')",
        )
        .bind(id),
    ),
  );
  const response = await app.request(
    `${config.origin}/api/purchases?q=Long&limit=2`,
    { headers: { Cookie: cookie() } },
    bindings,
  );
  expect(response.status).toBe(200);
  const page = purchaseListResponseSchema.parse(await response.json());
  expect(page.rows.map((row: { id: string }) => row.id)).toEqual(
    ids.slice(0, 2),
  );
  expect(page.nextCursor).toEqual(expect.any(String));
  if (!page.nextCursor) throw new Error("fixture continuation absent");
  const second = await app.request(
    `${config.origin}/api/purchases?q=Long&limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
    { headers: { Cookie: cookie() } },
    bindings,
  );
  expect(second.status).toBe(200);
  expect(
    purchaseListResponseSchema
      .parse(await second.json())
      .rows.map((row) => row.id),
  ).toEqual(ids.slice(2, 4));
  const oversized = await app.request(
    `${config.origin}/api/purchases?q=Long&limit=50`,
    { headers: { Cookie: cookie() } },
    bindings,
  );
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toMatchObject({
    error: { code: "response_too_large", retryable: false },
  });
  expect(oversized.headers.get("cache-control")).toBe("no-store");
});
it("canonical /api/summary shares authenticated no-store filter semantics with purchase summary", async () => {
  const headers = { Cookie: cookie() };
  const expected = await app.request(
    `${config.origin}/api/purchases/summary?q=Long`,
    { headers },
    bindings,
  );
  const response = await app.request(
    `${config.origin}/api/summary?q=Long`,
    { headers },
    bindings,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(await expected.json());
  expect(
    (await app.request(`${config.origin}/api/summary`, {}, bindings)).status,
  ).toBe(401);
});
it("HOME-05 open-review API derives tenant from actual session and rejects query authority, unbounded input and cross origin", async () => {
  const url = `${config.origin}/api/purchase-reviews`;
  expect((await app.request(url, {}, bindings)).status).toBe(401);
  const response = await app.request(
    url,
    { headers: { Cookie: cookie(), "X-User-Id": "route-b" } },
    bindings,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ reviews: [], hasMore: false });
  for (const suffix of [
    "?userId=route-b",
    "?limit=51",
    "?limit=0",
    "?limit=1&limit=2",
    "?q=private",
  ])
    expect(
      (
        await app.request(
          url + suffix,
          { headers: { Cookie: cookie() } },
          bindings,
        )
      ).status,
      suffix,
    ).toBe(400);
  expect(
    (
      await app.request(
        url,
        {
          headers: {
            Cookie: cookie(),
            Origin: "https://attacker.example.invalid",
          },
        },
        bindings,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request(
        url,
        { headers: { Cookie: cookie("route-b") } },
        bindings,
      )
    ).status,
  ).toBe(401);
});
