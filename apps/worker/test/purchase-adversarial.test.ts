import { env } from "cloudflare:workers";
import type { AuthBindings, LoginConfiguration } from "@invoxim/adapters";
import { createLoginAuth, createPurchaseViewReader } from "@invoxim/adapters";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";

import worker from "../src/index";
import { createInvocationDatabase } from "../src/invocation-database";
import { createPurchaseRoutes } from "../src/purchase-routes";
import { faultingDatabase } from "./support/faults";

const fixtureDatabase = env.DB;
const db = fixtureDatabase;

const configuration: LoginConfiguration = {
  origin: "https://qa-home.example.invalid",
  secret: "synthetic-private-home-secret-never-production-12345",
  googleClientId: "synthetic",
  googleClientSecret: "synthetic",
  allowedEmails: ["qa-home-a@example.invalid", "qa-home-b@example.invalid"],
};
const bindings: AuthBindings = {
  DB: env.DB,
  AUTH_ENABLED: "true",
  AUTH_ORIGIN: configuration.origin,
  AUTH_SECRET: configuration.secret,
  AUTH_GOOGLE_CLIENT_ID: configuration.googleClientId,
  AUTH_GOOGLE_CLIENT_SECRET: configuration.googleClientSecret,
  AUTH_ALLOWED_EMAILS: JSON.stringify(configuration.allowedEmails),
};
const app = createPurchaseRoutes(),
  cookies = new Map<string, string>();
async function evidence(
  owner: string,
  purchase: string,
  id: string,
  type = "receipt",
  refund = "none",
) {
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,? ,?,0,1)",
    )
    .bind(id, owner, `c-${owner}`, id)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES(?,?,?,'body',?,'text/plain',10)",
    )
    .bind(id, owner, id, "a".repeat(64))
    .run();
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state,structured_fields) VALUES(?,?,?,0,?,1,'unknown','{\"schemaVersion\":1}','accepted',?)",
    )
    .bind(
      id,
      owner,
      id,
      id,
      JSON.stringify({
        schemaVersion: 1,
        documentType: type,
        record: {
          documentDate: "2026-10-10",
          eventDate: "2026-10-10",
          paymentEvidence:
            type === "invoice" ? "explicitly-unpaid" : "explicitly-paid",
          refundEvidence: refund,
        },
      }),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,?,?,'document')",
    )
    .bind(owner, purchase, id)
    .run();
}
async function event(
  owner: string,
  purchase: string,
  observation: string,
  id: string,
  kind: string,
  amount: number,
  date: string,
  eligible = 1,
) {
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES(?,?,?,?,?,?,?,'EUR',?,'explicit-event-date',?)",
    )
    .bind(id, owner, purchase, observation, id, kind, amount, date, eligible)
    .run();
}
beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((s) => s.trim()))
      await db.prepare(statement).run();
  const auth = await createLoginAuth(db, configuration).$context;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(configuration.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  for (const owner of ["qa-home-a", "qa-home-b"]) {
    await db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
      )
      .bind(owner, owner, `${owner}@example.invalid`)
      .run();
    await db
      .prepare(
        "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
      )
      .bind(owner)
      .run();
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address) VALUES(?,?,'mailbox','gmail',?,?)",
      )
      .bind(`c-${owner}`, owner, owner, `${owner}-mail@example.invalid`)
      .run();
    const session = await auth.internalAdapter.createSession(owner, false);
    if (!session) throw new Error("Missing signed-session positive control");
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(session.token),
    );
    cookies.set(
      owner,
      `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`,
    );
  }
  for (const [id, date, amount, state] of [
    ["history", "2026-01-10", 12000, "paid"],
    ["same-a", "2026-10-10", 2490, "paid"],
    ["same-b", "2026-10-10", 2490, "paid"],
    ["unpaid", "2026-10-10", 8000, "unpaid"],
    ["blocked", "2026-10-10", 2000, "unknown"],
    ["missing", "2026-10-10", null, "unknown"],
  ] as const) {
    await db
      .prepare(
        "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,category,payment_state) VALUES(?,'qa-home-a',?,?,?, ?,?,'shopping',?)",
      )
      .bind(
        id,
        `QA ${id}`,
        `qa ${id}`,
        date,
        amount,
        amount === null ? null : "EUR",
        state,
      )
      .run();
    await evidence(
      "qa-home-a",
      id,
      `o-${id}`,
      state === "unpaid" ? "invoice" : "receipt",
    );
  }
  await evidence("qa-home-a", "history", "pending-refund", "refund", "pending");
  await evidence(
    "qa-home-a",
    "history",
    "completed-refund",
    "refund",
    "completed",
  );
  await event(
    "qa-home-a",
    "history",
    "o-history",
    "old-pay",
    "payment",
    12000,
    "2026-01-10",
  );
  await event(
    "qa-home-a",
    "history",
    "completed-refund",
    "current-refund",
    "refund",
    3000,
    "2026-10-10",
  );
  for (const id of ["same-a", "same-b"])
    await event(
      "qa-home-a",
      id,
      `o-${id}`,
      `pay-${id}`,
      "payment",
      2490,
      "2026-10-10",
    );
  await event(
    "qa-home-a",
    "blocked",
    "o-blocked",
    "blocked-cash",
    "payment",
    2000,
    "2026-10-10",
    0,
  );
  await db
    .prepare(
      "INSERT INTO review_items(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,created_at) VALUES('review-blocked','qa-home-a','o-blocked','o-blocked','blocked','ambiguous-event','financial',0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('private-b','qa-home-b','QA other owner','qa other owner','2026-10-10',99999,'EUR','paid')",
    )
    .run();
});
async function request(
  path: string,
  owner = "qa-home-a",
  extra: Record<string, string> = {},
) {
  const meter = createInvocationDatabase(env.DB, 40);
  const response = await app.request(
    `${configuration.origin}/api/purchases${path}`,
    { headers: { Cookie: cookies.get(owner) ?? "", ...extra } },
    { ...bindings, DB: meter.db },
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  return response;
}
const period = "from=2026-10-01&to=2026-10-31";
it("UI-03 opaque pagination rejects an impossible calendar date inside a real cursor", async () => {
  const first = (await (await request("?limit=1")).json()) as {
    nextCursor: string;
  };
  expect(first.nextCursor).toBeTruthy();
  const decoded = JSON.parse(
    atob(first.nextCursor.replace(/-/g, "+").replace(/_/g, "/")),
  );
  decoded.date = "2026-02-30";
  const invalid = btoa(JSON.stringify(decoded))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  expect((await request(`?limit=1&cursor=${invalid}`)).status).toBe(400);
});
it("HOME-02/04 period cash and lifecycle history stay distinct; pending refunds and unpaid totals add nothing", async () => {
  const summary = await (await request(`/summary?${period}`)).json();
  expect(summary).toMatchObject({
    totals: [
      {
        currency: "EUR",
        paidMinor: "4980",
        refundedMinor: "3000",
        netMinor: "1980",
      },
    ],
    recordCount: 6,
    unpaidCount: 1,
    unknownCount: 2,
    excludedEntryCount: 1,
    missingCurrencyCount: 1,
    conversion: "not_configured",
  });
  const detail = (await (await request(`/history?${period}`)).json()) as {
    purchase: unknown;
    timeline: Array<{
      observationId: string;
      refundEvidence: string;
      events: unknown[];
    }>;
  };
  expect(detail.purchase).toMatchObject({
    documentTotalMinor: "12000",
    lifecycle: [
      { paidMinor: "12000", refundedMinor: "3000", netMinor: "9000" },
    ],
    period: [{ paidMinor: "0", refundedMinor: "3000", netMinor: "-3000" }],
  });
  expect(
    detail.timeline.find((entry) => entry.observationId === "pending-refund"),
  ).toMatchObject({ refundEvidence: "pending", events: [] });
});
it("UI-03 stable date plus ID cursor visits every tie once and binds the selected filter", async () => {
  let cursor: string | null = null;
  const ids: string[] = [];
  for (let page = 0; page < 7; page++) {
    const result = (await (
      await request(`?${period}&limit=1${cursor ? `&cursor=${cursor}` : ""}`)
    ).json()) as { rows: Array<{ id: string }>; nextCursor: string | null };
    ids.push(...result.rows.map((row) => row.id));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  expect(ids).toEqual([
    "blocked",
    "missing",
    "same-a",
    "same-b",
    "unpaid",
    "history",
  ]);
  const first = (await (await request("?limit=1")).json()) as {
    nextCursor: string;
  };
  expect(
    (await request(`?limit=1&q=history&cursor=${first.nextCursor}`)).status,
  ).toBe(400);
});
it("HOME-03/05/06 unknown metadata remains null and review does not suppress existing eligible money or invent original retrieval", async () => {
  const missing = await (await request("/missing")).json();
  expect(missing).toMatchObject({
    purchase: {
      currency: null,
      documentTotalMinor: null,
      lifecycle: [],
      period: [],
    },
  });
  const detail = (await (await request("/history")).json()) as {
    timeline: Array<{ source: unknown }>;
  };
  expect(
    detail.timeline.every((entry) =>
      JSON.stringify(entry.source).includes('"originalAvailable":false'),
    ),
  ).toBe(true);
  expect(detail.timeline[0]?.source).toMatchObject({
    reason: "retrieval_not_implemented",
  });
  expect(JSON.stringify(detail)).not.toMatch(
    /credential|quote|raw_body|model_transcript|provider_message_id/,
  );
  const summary = await (
    await request(`/summary?${period}&reviewState=clear`)
  ).json();
  expect(summary).toMatchObject({
    reviewCount: 0,
    totals: [{ netMinor: "1980" }],
  });
});
it("tenant and origin authorization remain independent of disabled processing configuration", async () => {
  expect((await request("/private-b")).status).toBe(404);
  const b = (await (await request("", "qa-home-b")).json()) as {
    rows: Array<{ id: string }>;
  };
  expect(b.rows.map((row) => row.id)).toEqual(["private-b"]);
  for (const path of [
    "?userId=qa-home-b",
    "?from=2026-02-30",
    "?q=a&q=b",
    "/summary?cursor=anything",
  ])
    expect((await request(path)).status).toBe(400);
  expect(
    (
      await request("", "qa-home-a", {
        Origin: "https://attacker.example.invalid",
      })
    ).status,
  ).toBe(403);
  expect((await request("", "no-session")).status).toBe(401);
  expect((await request("?q=history")).status).toBe(200);
});

it("UI-01 actual Worker entry point serves signed-session purchases before the generic auth fallback", async () => {
  const response = await worker.fetch(
    new Request(`${configuration.origin}/api/purchases?q=history`, {
      headers: { Cookie: cookies.get("qa-home-a") ?? "" },
    }),
    bindings,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    rows: [{ id: "history", merchant: "QA history" }],
  });
});
it("actual Worker routes disabled AI settings through its specific safe handler without any model request", async () => {
  const response = await worker.fetch(
    new Request(`${configuration.origin}/api/ai/settings`, {
      headers: { Cookie: cookies.get("qa-home-a") ?? "" },
    }),
    bindings,
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    error: { code: "unavailable" },
  });
});
it("HOME-05 actual review endpoint retains exact missing field names without disclosing incomplete guesses", async () => {
  await db
    .prepare(
      "INSERT INTO review_items(id,user_id,document_id,purchase_id,reason,blocking_scope,created_at,missing_fields_json) VALUES('qa-missing-question','qa-home-a','o-missing','missing','incomplete-financial-facts','financial',0,'[\"currency\"]')",
    )
    .run();
  const meter = createInvocationDatabase(env.DB, 40);
  const response = await worker.fetch(
    new Request(`${configuration.origin}/api/purchase-reviews?limit=25`, {
      headers: { Cookie: cookies.get("qa-home-a") ?? "" },
    }),
    { ...bindings, DB: meter.db },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as {
    reviews: Array<{
      id: string;
      documentId: string;
      purchaseId: string;
      reason: string;
      missingFields: string[];
      sourceContext: {
        mailboxAddress: string;
        receivedAt: number;
        provider: string;
        available: boolean;
      };
    }>;
  };
  expect(body.reviews.find((r) => r.id === "qa-missing-question")).toEqual({
    id: "qa-missing-question",
    sourceMessageId: "o-missing",
    documentId: "o-missing",
    purchaseId: "missing",
    reason: "incomplete-financial-facts",
    sourceContext: {
      mailboxAddress: "qa-home-a-mail@example.invalid",
      receivedAt: 0,
      provider: "gmail",
      available: true,
    },
    missingFields: ["currency"],
  });
  expect(JSON.stringify(body)).not.toMatch(
    /merchant|totalMinor|quote|transcript|credential/,
  );
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("HOME-02/LIFECYCLE-02 concurrent refund produces export totals derived from the exported cash facts", async () => {
  let interleaved = false;
  const { db: faulted } = faultingDatabase(fixtureDatabase, [
    {
      on: "all",
      fire: async ({ proceed }) => {
        const result = await proceed();
        interleaved = true;
        await event(
          "qa-home-a",
          "history",
          "completed-refund",
          "qa-concurrent-refund",
          "refund",
          1000,
          "2026-10-12",
        );
        return result;
      },
    },
  ]);
  const tenant = { userId: "qa-home-a", authority: "session" } as TenantContext;
  const snapshot = await createPurchaseViewReader(faulted).exportSnapshot(
    tenant,
    {
      q: "history",
      from: "2026-10-01",
      to: "2026-10-31",
    },
  );
  expect(interleaved).toBe(true);
  expect(
    snapshot.ledgerEntries
      .filter((entry) => entry.kind === "refund")
      .map((entry) => entry.minor)
      .sort(),
  ).toEqual(["1000", "3000"]);
  expect(snapshot.purchases).toHaveLength(1);
  expect(snapshot.purchases[0]).toMatchObject({
    lifecycle: [
      {
        currency: "EUR",
        paidMinor: "12000",
        refundedMinor: "4000",
        netMinor: "8000",
      },
    ],
    period: [
      {
        currency: "EUR",
        paidMinor: "0",
        refundedMinor: "4000",
        netMinor: "-4000",
      },
    ],
  });
  expect(snapshot.summary).toMatchObject({
    totals: [
      {
        currency: "EUR",
        paidMinor: "0",
        refundedMinor: "4000",
        netMinor: "-4000",
      },
    ],
    recordCount: 1,
  });
});
