import { env } from "cloudflare:workers";
import {
  createLoginAuth,
  issueWorkspaceMutationToken,
  loginConfiguration,
} from "@invoxim/adapters";
import {
  recurringDetailResponseSchema,
  recurringListResponseSchema,
  recurringPreviewResponseSchema,
  recurringWriteResponseSchema,
} from "@invoxim/contracts";
import { beforeAll, expect, it } from "vitest";
import migration from "../../../packages/adapters/migrations/0003_recurring_series.sql?raw";
import { createRecurringService } from "../../../packages/adapters/src/recurring/service";
import worker from "../src/index";
import { createInvocationDatabase } from "../src/invocation-database";
import { createRecurringRoutes } from "../src/recurring-routes";
import { owner } from "./onboarding-qa-fixture";

beforeAll(async () => {
  for (const statement of migration.split(";").filter((value) => value.trim()))
    await env.DB.prepare(statement).run();
});
async function fixture(id: string) {
  const current = await owner(id);
  const bindings = {
    DB: env.DB,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://recurring-routes.example.invalid",
    AUTH_SECRET: "synthetic-recurring-route-secret-1234567890",
    AUTH_GOOGLE_CLIENT_ID: "synthetic-login",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic-login-secret",
    AUTH_ALLOWED_EMAILS: JSON.stringify([current.loginEmail]),
  };
  const config = loginConfiguration(bindings);
  if (!config) throw new Error("fixture configuration missing");
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
  const routes = createRecurringRoutes({
    service: (db) => createRecurringService(db),
  });
  return { current, bindings, config, session, cookie, routes };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const input = {
  id: "series",
  identityKey: "synthetic-user-selected-service",
  cadence: "monthly" as const,
  anchorDate: "2026-01-31",
  entries: [{ entryId: "payment", expectedVersion: 1 }],
};
async function payment(f: Fixture) {
  await env.DB.prepare(
    "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('purchase',?,'Synthetic','synthetic','2026-01-31',1000,'EUR','paid')",
  )
    .bind(f.current.tenant.userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO ledger_entries(id,user_id,purchase_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('payment',?,'purchase','payment','payment',1000,'EUR','2026-01-31','user-confirmed-date',1,'user-confirmed')",
  )
    .bind(f.current.tenant.userId)
    .run();
}
async function request(
  f: Fixture,
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
  headers: Record<string, string> = {},
) {
  const meter = createInvocationDatabase(env.DB, 40);
  const response = await f.routes.fetch(
    new Request(`${f.config.origin}${path}`, {
      method,
      headers: {
        Cookie: f.cookie,
        Origin: f.config.origin,
        "Content-Type": "application/json",
        ...(token ? { "X-Workspace-Token": token } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...f.bindings, DB: meter.db },
  );
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  return response;
}
it("T20-API-LIST-01: bounded service list returns persisted owned series rather than an empty fabricated page", async () => {
  const f = await fixture("recurring-list-red");
  await payment(f);
  const service = createRecurringService(env.DB);
  await service.createUserSeries(f.current.tenant, input);
  expect(await service.list(f.current.tenant, { limit: 1 })).toMatchObject({
    status: "current",
    records: [{ status: "current", series: { id: "series" } }],
    nextCursor: null,
  });
});
it("T20-API-LIST-02: authenticated HTTP list exposes stored user series with honest capability and page scope", async () => {
  const f = await fixture("recurring-http-red");
  await payment(f);
  await createRecurringService(env.DB).createUserSeries(
    f.current.tenant,
    input,
  );
  const response = await request(f, "/api/recurring?limit=1");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    status: "current",
    pageScope: "page",
    pageSnapshot: false,
    automaticSuggestionsAvailable: false,
    userSelectionRequired: true,
    records: [{ status: "current", series: { id: "series" } }],
    mutationToken: expect.any(String),
  });
});
async function page(f: Fixture, query = "") {
  const response = await request(f, `/api/recurring${query}`);
  expect(response.status).toBe(200);
  return recurringListResponseSchema.parse(await response.json());
}
it("T20-API-MUTATION-01: actor-scoped creation and decisions persist with expected versions and no new cash event", async () => {
  const f = await fixture("recurring-http-create");
  await payment(f);
  const token = (await page(f)).mutationToken;
  const created = await request(f, "/api/recurring", "POST", input, token);
  expect(created.status).toBe(201);
  expect(recurringWriteResponseSchema.parse(await created.json())).toEqual({
    status: "stored",
    version: 1,
  });
  expect(
    (await request(f, "/api/recurring", "POST", input, token)).status,
  ).toBe(409);
  expect(
    (
      await request(
        f,
        "/api/recurring/series",
        "PATCH",
        { expectedVersion: 1, state: "confirmed" },
        token,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        f,
        "/api/recurring/series",
        "PATCH",
        { expectedVersion: 1, state: "dismissed" },
        token,
      )
    ).status,
  ).toBe(409);
  const detail = await request(f, "/api/recurring/series");
  expect(detail.status).toBe(200);
  expect(
    recurringDetailResponseSchema.parse(await detail.json()),
  ).toMatchObject({
    record: {
      status: "current",
      series: { state: "confirmed", version: 2 },
      projection: { forecast: { certainty: "estimate" } },
    },
  });
  expect(
    (
      await request(
        f,
        "/api/recurring/series",
        "PATCH",
        { expectedVersion: 2, state: "paused" },
        token,
      )
    ).status,
  ).toBe(200);
  const paused = await request(f, "/api/recurring/series");
  expect(await paused.json()).toMatchObject({
    record: { projection: { forecast: null } },
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM ledger_entries WHERE user_id=?",
    )
      .bind(f.current.tenant.userId)
      .first(),
  ).toEqual({ total: 1 });
});
it("T20-API-LIST-03: keyset pages cover owned stored series without inventing a period snapshot", async () => {
  const f = await fixture("recurring-pagination");
  await payment(f);
  const service = createRecurringService(env.DB);
  for (const id of ["c", "a", "b"])
    await service.createUserSeries(f.current.tenant, { ...input, id });
  const first = await page(f, "?limit=1");
  expect(first.records.map((record) => record.series.id)).toEqual(["a"]);
  expect(first.nextCursor).toBe("a");
  const second = await page(f, "?limit=1&after=a");
  expect(second.records.map((record) => record.series.id)).toEqual(["b"]);
  const last = await page(f, "?limit=1&after=b");
  expect(last.records.map((record) => record.series.id)).toEqual(["c"]);
  expect(last.nextCursor).toBeNull();
  expect(first.pageSnapshot).toBe(false);
});
it("T20-API-PREVIEW-01: preview exposes insufficient stable identity evidence and writes neither series nor spending", async () => {
  const f = await fixture("recurring-http-preview");
  await payment(f);
  const token = (await page(f)).mutationToken;
  const response = await request(
    f,
    "/api/recurring/preview",
    "POST",
    { entries: input.entries },
    token,
  );
  expect(response.status).toBe(200);
  expect(
    recurringPreviewResponseSchema.parse(await response.json()),
  ).toMatchObject({
    result: { status: "insufficient", reason: "missing_service_identity" },
  });
  expect((await page(f)).records).toEqual([]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM ledger_entries WHERE user_id=?",
    )
      .bind(f.current.tenant.userId)
      .first(),
  ).toEqual({ total: 1 });
});
it("T20-API-EVIDENCE-01: changed evidence stays visible without a forecast, and can still be canceled", async () => {
  const f = await fixture("recurring-http-stale");
  await payment(f);
  const token = (await page(f)).mutationToken;
  await request(f, "/api/recurring", "POST", input, token);
  await env.DB.prepare(
    "UPDATE ledger_entries SET version=2,amount_minor=1200 WHERE user_id=?",
  )
    .bind(f.current.tenant.userId)
    .run();
  const detail = await request(f, "/api/recurring/series");
  const payload = recurringDetailResponseSchema.parse(await detail.json());
  expect(payload.record).toMatchObject({
    status: "stale",
    reason: "evidence_changed",
    entryIds: ["payment"],
  });
  expect(payload.record).not.toHaveProperty("projection");
  expect(
    (
      await request(
        f,
        "/api/recurring/series",
        "PATCH",
        { expectedVersion: 1, state: "confirmed" },
        token,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        f,
        "/api/recurring/series",
        "PATCH",
        { expectedVersion: 1, state: "canceled" },
        token,
      )
    ).status,
  ).toBe(200);
});
it("T20-API-AUTH-01: unauthenticated and cross-tenant requests cannot read or choose another user's series/payment", async () => {
  const f = await fixture("recurring-private");
  await payment(f);
  await createRecurringService(env.DB).createUserSeries(
    f.current.tenant,
    input,
  );
  expect(
    (
      await request(f, "/api/recurring", "GET", undefined, undefined, {
        Cookie: "",
        "X-User-Id": f.current.tenant.userId,
      })
    ).status,
  ).toBe(401);
  const other = await fixture("recurring-private-other");
  const token = (await page(other)).mutationToken;
  expect((await page(other)).records).toEqual([]);
  expect((await request(other, "/api/recurring/series")).status).toBe(404);
  expect(
    (
      await request(
        other,
        "/api/recurring/series",
        "PATCH",
        { expectedVersion: 1, state: "canceled" },
        token,
      )
    ).status,
  ).toBe(409);
  expect(
    (await request(other, "/api/recurring", "POST", input, token)).status,
  ).toBe(409);
  expect(
    (
      await request(
        other,
        "/api/recurring",
        "POST",
        { ...input, userId: f.current.tenant.userId },
        token,
      )
    ).status,
  ).toBe(400);
});
it("T20-API-AUTH-02: mutations reject absent, wrong-purpose, expired, previous-account and previous-session tokens", async () => {
  const f = await fixture("recurring-token-boundary");
  await payment(f);
  const identity = { userId: f.current.tenant.userId, sessionId: f.session.id };
  const wrongPurpose = await issueWorkspaceMutationToken(
    identity,
    f.config.secret,
    Date.now,
    "corrections",
  );
  const expired = await issueWorkspaceMutationToken(
    identity,
    f.config.secret,
    () => Date.now() - 700000,
    "recurring",
  );
  const otherAccount = await issueWorkspaceMutationToken(
    { ...identity, userId: "different-account" },
    f.config.secret,
    Date.now,
    "recurring",
  );
  const previousSession = await issueWorkspaceMutationToken(
    { ...identity, sessionId: "previous-session" },
    f.config.secret,
    Date.now,
    "recurring",
  );
  for (const token of [
    undefined,
    wrongPurpose,
    expired,
    otherAccount,
    previousSession,
  ]) {
    const response = await request(f, "/api/recurring", "POST", input, token);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "workspace_changed_or_expired" },
    });
  }
  expect((await page(f)).records).toEqual([]);
});
it("T20-API-AUTH-03: origin and recent-auth guards precede mutations and malformed bodies cannot choose authority", async () => {
  const f = await fixture("recurring-request-boundary");
  await payment(f);
  const token = (await page(f)).mutationToken;
  expect(
    (
      await request(f, "/api/recurring", "POST", input, token, {
        Origin: "https://other.example.invalid",
      })
    ).status,
  ).toBe(403);
  expect(
    (await request(f, "/api/recurring", "POST", input, token, { Origin: "" }))
      .status,
  ).toBe(403);
  expect(
    (
      await request(
        f,
        "/api/recurring",
        "POST",
        { ...input, anchorDate: "2026-02-30" },
        token,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await request(
        f,
        "/api/recurring",
        "POST",
        { ...input, raw: "x".repeat(17000) },
        token,
      )
    ).status,
  ).toBe(413);
  await env.DB.prepare('UPDATE "session" SET createdAt=? WHERE id=?')
    .bind(Date.now() - 7200000, f.session.id)
    .run();
  const response = await request(f, "/api/recurring", "POST", input, token);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    error: { code: "recent_auth_required" },
  });
});
it("T20-API-INPUT-01: duplicate/unknown query keys, unsafe cursors and unsupported limits fail explicitly", async () => {
  const f = await fixture("recurring-query-boundary");
  for (const query of [
    "?limit=1&limit=2",
    "?userId=other",
    "?limit=11",
    "?limit=0",
    "?limit=1e1",
    "?after=%00",
    `?after=${"x".repeat(257)}`,
  ])
    expect((await request(f, `/api/recurring${query}`)).status).toBe(400);
  expect((await request(f, "/api/recurring/missing?limit=1")).status).toBe(400);
});
it("T20-API-BUDGET-01: maximum20-member creation stays within the shared40-query route budget", async () => {
  const f = await fixture("recurring-create-budget");
  const entries: { entryId: string; expectedVersion: number }[] = [];
  for (let index = 0; index < 20; index++) {
    const id = `member-${index}`;
    const date = new Date(Date.UTC(2025, index, 1)).toISOString().slice(0, 10);
    await env.DB.prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES(?,?,'Synthetic','synthetic',?,1000,'EUR','paid')",
    )
      .bind(id, f.current.tenant.userId, date)
      .run();
    await env.DB.prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES(?,?,?,?,'payment',1000,'EUR',?,'user-confirmed-date',1,'user-confirmed')",
    )
      .bind(id, f.current.tenant.userId, id, id, date)
      .run();
    entries.push({ entryId: id, expectedVersion: 1 });
  }
  const token = (await page(f)).mutationToken;
  const response = await request(
    f,
    "/api/recurring",
    "POST",
    { ...input, anchorDate: "2025-01-01", entries },
    token,
  );
  expect(response.status).toBe(201);
  const detail = await request(f, "/api/recurring/series");
  expect(await detail.json()).toMatchObject({
    record: { series: { selected_entry_count: 20 } },
  });
});
it("T20-API-BUDGET-02: maximum10-series list stays within the shared40-query route budget", async () => {
  const f = await fixture("recurring-list-budget");
  await payment(f);
  const service = createRecurringService(env.DB);
  for (let index = 0; index < 11; index++)
    await service.createUserSeries(f.current.tenant, {
      ...input,
      id: `series-${String(index).padStart(2, "0")}`,
    });
  const response = await page(f, "?limit=10");
  expect(response.records).toHaveLength(10);
  expect(response.nextCursor).toBe("series-09");
});
it("T20-API-CONFIG-01: unavailable composition is explicit and grants no implicit automatic recurrence capability", async () => {
  const f = await fixture("recurring-unconfigured");
  f.routes = createRecurringRoutes({ service: () => null });
  const response = await request(f, "/api/recurring");
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    error: { code: "recurring_not_configured" },
  });
});
it("T20-API-MOUNT-01: actual Worker composition mounts authenticated series only with the exact server flag", async () => {
  const f = await fixture("recurring-worker-mounted");
  await payment(f);
  await createRecurringService(env.DB).createUserSeries(
    f.current.tenant,
    input,
  );
  const meter = createInvocationDatabase(env.DB, 40);
  const bindings = { ...f.bindings, RECURRING_ENABLED: "true", DB: meter.db };
  const response = await worker.fetch(
    new Request(`${f.config.origin}/api/recurring?limit=1`, {
      headers: { Cookie: f.cookie, Origin: f.config.origin },
    }),
    bindings,
  );
  expect(response.status).toBe(200);
  expect(
    recurringListResponseSchema.parse(await response.json()),
  ).toMatchObject({
    records: [{ status: "current", series: { id: "series" } }],
    automaticSuggestionsAvailable: false,
  });
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("T20-API-MOUNT-02: actual Worker composition leaves recurrence disabled when no server flag is set", async () => {
  const f = await fixture("recurring-worker-default-disabled");
  const meter = createInvocationDatabase(env.DB, 40);
  const response = await worker.fetch(
    new Request(`${f.config.origin}/api/recurring`, {
      headers: { Cookie: f.cookie, Origin: f.config.origin },
    }),
    { ...f.bindings, DB: meter.db },
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { code: "recurring_not_configured" },
  });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
