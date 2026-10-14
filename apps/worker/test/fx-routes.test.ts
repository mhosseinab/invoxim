import { env } from "cloudflare:workers";
import {
  createLoginAuth,
  issueWorkspaceMutationToken,
  loginConfiguration,
  readAuthJson,
} from "@invoxim/adapters";
import { expect, it } from "vitest";
import { createFxReportingService } from "../../../packages/adapters/src/fx/service";
import {
  fxReportingExportSchema,
  fxReportingResponseSchema,
} from "../../../packages/contracts/src/fx-reporting";
import { createFxRoutes } from "../src/fx-routes";
import { createInvocationDatabase } from "../src/invocation-database";
import { owner, installOnboardingQaHooks } from "./onboarding-qa-fixture";

installOnboardingQaHooks();

const query =
  "expectedProfileVersion=1&reportingCurrency=EUR&fromDate=2026-01-01&toDate=2026-12-31&limit=3";
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
  const routes = createFxRoutes({
    service: (db) =>
      createFxReportingService(db, {
        policy: { source: "synthetic-reference", maxPriorAgeDays: 2 },
        reader: null,
      }),
  });
  return { current, bindings, session, cookie, config, routes };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
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
it("FX-05: real signed session reads an explicit bounded page subtotal and receives actor-scoped mutation token", async () => {
  const f = await fixture("fx-route-owner");
  const response = await request(f, `/api/fx/reporting?${query}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    status: "current",
    summaryScope: "page",
    expectedProfileVersion: 1,
    reportingCurrency: "EUR",
    pageSummary: { signedMinor: "0" },
    pendingCount: 0,
    nextCursor: null,
    entries: [],
    mutationToken: expect.any(String),
  });
});

const input = {
  expectedProfileVersion: 1,
  reportingCurrency: "EUR",
  fromDate: "2026-01-01",
  toDate: "2026-12-31",
  limit: 3,
};
async function page(f: Fixture) {
  const response = await request(f, `/api/fx/reporting?${query}`);
  expect(response.status).toBe(200);
  return fxReportingResponseSchema.parse(await response.json());
}
async function events(f: Fixture, ids = ["payment", "refund"]) {
  await env.DB.prepare(
    "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('purchase',?,'Synthetic','synthetic','2026-03-10',105,'EUR','paid')",
  )
    .bind(f.current.tenant.userId)
    .run();
  for (const id of ids)
    await env.DB.prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES(?,?,'purchase',?,?,?,'EUR','2026-03-10','user-confirmed-date',1,'user-confirmed')",
    )
      .bind(
        id,
        f.current.tenant.userId,
        id,
        id === "refund" ? "refund" : "payment",
        id === "refund" ? 5 : 105,
      )
      .run();
}
it("FX-03: list page subtotal and export use the exact same persisted original event rows", async () => {
  const f = await fixture("fx-route-export");
  await events(f);
  const first = await page(f);
  expect(first.pendingCount).toBe(2);
  expect(
    (await request(f, "/api/fx/revalue", "POST", input, first.mutationToken))
      .status,
  ).toBe(200);
  const current = await page(f);
  const response = await request(f, `/api/fx/reporting/export?${query}`);
  expect(response.status).toBe(200);
  const exported = fxReportingExportSchema.parse(await response.json());
  expect(exported.rows).toEqual(current.entries);
  expect(exported.pageSummary).toEqual(current.pageSummary);
  expect(exported.pageSummary.signedMinor).toBe("100");
  expect(exported.summaryScope).toBe("page");
});
it("FX-05: GET and read-only POST cannot silently revalue or require mutation authority", async () => {
  const f = await fixture("fx-route-readonly");
  await events(f);
  const get = await page(f);
  const response = await request(f, "/api/fx/reporting/page", "POST", input);
  expect(response.status).toBe(200);
  const post = fxReportingResponseSchema.parse(await response.json());
  expect(post.entries).toEqual(get.entries);
  expect(post.pageSummary).toEqual(get.pageSummary);
  expect(post.pendingCount).toBe(2);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM entry_valuations WHERE user_id=?",
    )
      .bind(f.current.tenant.userId)
      .first("total"),
  ).toBe(0);
});
it("FX-05: purpose, actor, session and recent authentication fence bounded revaluation", async () => {
  const f = await fixture("fx-route-purpose");
  expect((await request(f, "/api/fx/revalue", "POST", input)).status).toBe(403);
  const wrong = await issueWorkspaceMutationToken(
    { userId: f.current.tenant.userId, sessionId: f.session.id },
    f.config.secret,
  );
  expect(
    (await request(f, "/api/fx/revalue", "POST", input, wrong)).status,
  ).toBe(403);
  const view = await page(f);
  const foreign = await fixture("fx-route-foreign");
  expect(
    (
      await request(
        foreign,
        "/api/fx/revalue",
        "POST",
        input,
        view.mutationToken,
      )
    ).status,
  ).toBe(403);
  const differentSession = await issueWorkspaceMutationToken(
    { userId: f.current.tenant.userId, sessionId: "foreign-session" },
    f.config.secret,
    Date.now,
    "fx-reporting",
  );
  expect(
    (await request(f, "/api/fx/revalue", "POST", input, differentSession))
      .status,
  ).toBe(403);
  await env.DB.prepare('UPDATE "session" SET createdAt=? WHERE id=?')
    .bind(Date.now() - 3600001, f.session.id)
    .run();
  expect(
    (await request(f, "/api/fx/revalue", "POST", input, view.mutationToken))
      .status,
  ).toBe(403);
});
it("FX-05: rejects request tenant authority, duplicate filters, extra fields and oversized work", async () => {
  const f = await fixture("fx-route-validation"),
    view = await page(f);
  expect(
    (await request(f, `/api/fx/reporting?${query}&userId=foreign`)).status,
  ).toBe(400);
  expect((await request(f, `/api/fx/reporting?${query}&limit=1`)).status).toBe(
    400,
  );
  expect(
    (
      await request(
        f,
        "/api/fx/revalue",
        "POST",
        { ...input, limit: 4 },
        view.mutationToken,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await request(
        f,
        "/api/fx/revalue",
        "POST",
        { ...input, userId: "foreign" },
        view.mutationToken,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await request(f, "/api/fx/reporting/page", "POST", {
        ...input,
        userId: "foreign",
      })
    ).status,
  ).toBe(400);
  expect(
    (await request(f, "/api/fx/reporting/page?unexpected=1", "POST", input))
      .status,
  ).toBe(400);
});
it("FX-05: stale preferences are a conflict and disabled services are unavailable instead of zero", async () => {
  const f = await fixture("fx-route-stale"),
    view = await page(f);
  await env.DB.prepare("UPDATE profiles SET version=2 WHERE user_id=?")
    .bind(f.current.tenant.userId)
    .run();
  const stale = await request(f, `/api/fx/reporting?${query}`);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    error: { code: "valuation_stale" },
  });
  expect(
    (await request(f, "/api/fx/revalue", "POST", input, view.mutationToken))
      .status,
  ).toBe(409);
  f.routes = createFxRoutes({ service: () => null });
  const disabled = await request(f, `/api/fx/reporting?${query}`);
  expect(disabled.status).toBe(503);
  expect(await disabled.json()).toMatchObject({
    error: { code: "fx_not_configured" },
  });
});
it("FX-05: authenticated pages reject cross-origin and absent sessions", async () => {
  const f = await fixture("fx-route-origins");
  expect(
    (
      await request(
        f,
        `/api/fx/reporting?${query}`,
        "GET",
        undefined,
        undefined,
        { Origin: "https://foreign.example.invalid" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(f, "/api/fx/reporting/page", "POST", input, undefined, {
        Origin: "https://foreign.example.invalid",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        f,
        `/api/fx/reporting?${query}`,
        "GET",
        undefined,
        undefined,
        { Cookie: "" },
      )
    ).status,
  ).toBe(401);
});
it("FX-05: read-only POST and export roundtrip large opaque cursors within40KiB body cap", async () => {
  const f = await fixture("fx-route-largecursor");
  await events(f, [`a${"界".repeat(3000)}`, "z"]);
  const firstResponse = await request(f, "/api/fx/reporting/page", "POST", {
    ...input,
    limit: 1,
  });
  expect(firstResponse.status).toBe(200);
  const first = fxReportingResponseSchema.parse(await firstResponse.json());
  if (!first.nextCursor) throw new Error("missing large cursor");
  expect(first.nextCursor.length).toBeGreaterThan(8192);
  const next = await request(f, "/api/fx/reporting/page", "POST", {
    ...input,
    limit: 1,
    cursor: first.nextCursor,
  });
  expect(next.status).toBe(200);
  expect(
    fxReportingResponseSchema
      .parse(await next.json())
      .entries.map((row) => row.entry.id),
  ).toEqual(["z"]);
  const exportResponse = await request(f, "/api/fx/reporting/export", "POST", {
    ...input,
    limit: 1,
    cursor: first.nextCursor,
  });
  expect(exportResponse.status).toBe(200);
  expect(
    fxReportingExportSchema
      .parse(await exportResponse.json())
      .rows.map((row) => row.entry.id),
  ).toEqual(["z"]);
});
it("Auth JSON default remains4KiB and explicit FX limit is bounded at40KiB", async () => {
  const requestBody = (length: number) =>
    new Request("https://fx-routes.example.invalid/api/fx/reporting/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(length) }),
    });
  await expect(readAuthJson(requestBody(5000))).rejects.toMatchObject({
    status: 413,
    code: "request_too_large",
  });
  expect(await readAuthJson(requestBody(5000), 40960)).toEqual({
    value: "x".repeat(5000),
  });
  await expect(readAuthJson(requestBody(40960), 40960)).rejects.toMatchObject({
    status: 413,
    code: "request_too_large",
  });
  await expect(readAuthJson(requestBody(1), 40961)).rejects.toMatchObject({
    status: 400,
    code: "invalid_request",
  });
});
it("FX-01/03/04: real signed-session revaluation of three cold foreign events fits the shared40-statement budget", async () => {
  const f = await fixture("fx-route-cold-three");
  await events(f, []);
  const originals = [
    {
      id: "a-usd-payment",
      kind: "payment",
      amount: 10,
      currency: "USD",
      date: "2026-04-13",
    },
    {
      id: "b-gbp-payment",
      kind: "payment",
      amount: 100,
      currency: "GBP",
      date: "2026-05-14",
    },
    {
      id: "c-jpy-refund",
      kind: "refund",
      amount: 10,
      currency: "JPY",
      date: "2026-06-15",
    },
  ];
  for (const event of originals)
    await env.DB.prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES(?,?,'purchase',?,?,?, ?,?,'user-confirmed-date',1,'user-confirmed')",
    )
      .bind(
        event.id,
        f.current.tenant.userId,
        event.id,
        event.kind,
        event.amount,
        event.currency,
        event.date,
      )
      .run();
  const source = "synthetic-cold-route-reference";
  const lookups: {
    fromCurrency: string;
    toCurrency: string;
    requestedDate: string;
  }[] = [];
  f.routes = createFxRoutes({
    service: (db) =>
      createFxReportingService(db, {
        policy: { source, maxPriorAgeDays: 2 },
        reader: {
          async lookup(request) {
            lookups.push(request);
            const rate = request.fromCurrency === "GBP" ? "2" : "0.5";
            return {
              ...request,
              source,
              effectiveDate: request.requestedDate,
              rate,
              version: "synthetic-cold-v1",
              retrievedAt: 0,
            };
          },
        },
      }),
  });
  const before = await page(f);
  expect(before.pendingCount).toBe(3);
  expect(lookups).toEqual([]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM fx_rates WHERE source=?",
    )
      .bind(source)
      .first("total"),
  ).toBe(0);
  const meter = createInvocationDatabase(env.DB, 40);
  const response = await f.routes.fetch(
    new Request(`${f.config.origin}/api/fx/revalue`, {
      method: "POST",
      headers: {
        Cookie: f.cookie,
        Origin: f.config.origin,
        "Content-Type": "application/json",
        "X-Workspace-Token": before.mutationToken,
      },
      body: JSON.stringify(input),
    }),
    { ...f.bindings, DB: meter.db },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: "current",
    processed: 3,
    nextCursor: null,
  });
  const executed = meter.executedStatements();
  console.info(
    "FX three cold events with real auth: native statements",
    executed,
  );
  expect(executed).toBeLessThanOrEqual(40);
  expect(lookups).toEqual([
    { fromCurrency: "USD", toCurrency: "EUR", requestedDate: "2026-04-13" },
    { fromCurrency: "GBP", toCurrency: "EUR", requestedDate: "2026-05-14" },
    { fromCurrency: "JPY", toCurrency: "EUR", requestedDate: "2026-06-15" },
  ]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM entry_valuations WHERE user_id=? AND status='converted'",
    )
      .bind(f.current.tenant.userId)
      .first("total"),
  ).toBe(3);
  const current = await page(f);
  expect(current.pendingCount).toBe(0);
  expect(
    current.entries.map((row) =>
      row.status === "valued" && row.result.status === "converted"
        ? row.result.signedMinor
        : null,
    ),
  ).toEqual(["5", "200", "-500"]);
  expect(current.pageSummary.signedMinor).toBe("-295");
  const exportedResponse = await request(
    f,
    `/api/fx/reporting/export?${query}`,
  );
  expect(exportedResponse.status).toBe(200);
  const exported = fxReportingExportSchema.parse(await exportedResponse.json());
  expect(exported.rows).toEqual(current.entries);
  expect(exported.pageSummary).toEqual(current.pageSummary);
  expect(lookups).toHaveLength(3);
  expect(
    (
      await env.DB.prepare(
        "SELECT id,kind,CAST(amount_minor AS TEXT) AS amount,currency,event_date AS date FROM ledger_entries WHERE user_id=? ORDER BY id",
      )
        .bind(f.current.tenant.userId)
        .all()
    ).results,
  ).toEqual(
    originals.map((event) => ({ ...event, amount: String(event.amount) })),
  );
});
