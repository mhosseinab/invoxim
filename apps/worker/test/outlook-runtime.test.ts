import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  createCredentialCipher,
  createLoginAuth,
  loginConfiguration,
} from "@invoxim/adapters";
import {
  onboardingDisclosureSchema,
  onboardingStartResponseSchema,
} from "@invoxim/contracts";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createInvocationDatabase } from "../src/invocation-database";
import { syntheticClassificationBindings } from "./classification-fixture";
import { owner, startBody } from "./onboarding-qa-fixture";
import { routeRequest } from "./support/route";
import { signedSession as signedSessionCookie } from "./support/tenant";
import { useCurrentSchema } from "./support/db";

const db = env.DB;
beforeAll(async () => {
  await useCurrentSchema(db);
});
const keyring = {
  activeVersion: 1,
  keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
};
async function fixture(id: string, expired = false) {
  const session = await owner(id, "outlook", [
    "https://graph.microsoft.com/Mail.Read",
  ]);
  const cipher = await createCredentialCipher(keyring).seal(
    session.tenant,
    { entityId: "outlook", purpose: "mailbox-credentials" },
    {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: Date.now() + (expired ? -1000 : 3600000),
    },
  );
  await db
    .prepare(
      "UPDATE connections SET provider='outlook',provider_subject=?,credential_ciphertext=? WHERE user_id=? AND id='outlook'",
    )
    .bind(
      "https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222/v2.0|synthetic-sub",
      cipher,
      session.tenant.userId,
    )
    .run();
  const queue: Queue = {
    send: vi.fn(async () => ({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    })),
    sendBatch: vi.fn(async () => ({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    })),
    metrics: vi.fn(),
  };
  const bindings = {
    DB: db,
    JOBS: queue,
    JOBS_ENABLED: "true",
    OUTLOOK_ENABLED: "true",
    OUTLOOK_DISCOVERY_ENABLED: "true",
    EXTRACTION_ENABLED: "true",
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://qa-outlook-runtime.example.invalid",
    AUTH_SECRET: "synthetic-outlook-runtime-secret-never-live-12345",
    AUTH_GOOGLE_CLIENT_ID: "synthetic-google-login",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
    AUTH_ALLOWED_EMAILS: JSON.stringify([session.loginEmail]),
    OUTLOOK_CLIENT_ID: "11111111-2222-4333-8444-555555555555",
    OUTLOOK_CLIENT_SECRET: "synthetic-microsoft-secret",
    OUTLOOK_AUTHORITY: "common",
    CREDENTIAL_KEYRING: JSON.stringify(keyring),
    AI_HOSTED_KEY: "synthetic-ai-secret",
    ...syntheticClassificationBindings,
  };
  const login = loginConfiguration(bindings);
  if (!login) throw new Error("Synthetic login configuration missing");
  const context = await createLoginAuth(db, login).$context;
  const signedSession = await context.internalAdapter.createSession(
    session.tenant.userId,
    false,
  );
  if (!signedSession) throw new Error("Missing signed session");
  const cookie = await signedSessionCookie(login.secret, signedSession.token);
  const origin = login.origin;
  const counts: number[] = [];
  async function request(path: string, init: RequestInit = {}, overrides = {}) {
    const { method, body, headers } = init;
    const result = await routeRequest({
      fetch: (request, env) =>
        worker.fetch(request, env as Parameters<typeof worker.fetch>[1]),
      bindings: { ...bindings, ...overrides },
      origin,
      cookie,
      path,
      method: method ?? "GET",
      body: body ?? undefined,
      headers: (headers as Record<string, string>) ?? {},
      limit: 40,
    });
    counts.push(result.statements);
    return result.response;
  }
  async function start() {
    const response = await request(
      "/api/processing-disclosure?connectionId=outlook&timezone=Europe/Vienna",
    );
    expect(response.status).toBe(200);
    const disclosure = onboardingDisclosureSchema.parse(await response.json());
    expect(disclosure.canStartImport).toBe(true);
    const started = await request("/api/onboarding/start-import", {
      method: "POST",
      headers: { "Idempotency-Key": "outlook-runtime-start" },
      body: JSON.stringify(startBody(disclosure)),
    });
    expect(started.status).toBe(200);
    return onboardingStartResponseSchema.parse(await started.json());
  }
  async function consume(jobId: string) {
    const meter = createInvocationDatabase(db, 40);
    const batch = createMessageBatch("synthetic-jobs", [
      {
        id: jobId,
        timestamp: new Date(),
        attempts: 1,
        body: { schemaVersion: 1, jobId },
      },
    ]);
    await worker.queue(batch, { ...bindings, DB: meter.db });
    counts.push(meter.executedStatements());
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
    return getQueueResult(batch, createExecutionContext());
  }
  return { session, bindings, request, start, consume, counts };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await db.prepare("DELETE FROM hosted_ai_cooldowns").run();
});

it("OUTLOOK-01/ONBOARD-04 actual Worker advertises only fully ready providers and starts Outlook without provider content reads", async () => {
  const f = await fixture("outlook-runtime-start");
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No pre-Start network"));
  const config = await f.request("/api/public-config");
  expect(await config.json()).toMatchObject({
    mailProviders: ["outlook"],
    features: { outlook: true },
  });
  for (const override of [
    { OUTLOOK_DISCOVERY_ENABLED: "false" },
    { EXTRACTION_ENABLED: "false" },
    { AI_CLASSIFICATION_ENABLED: "false" },
    { AI: undefined },
    { JOBS_QUERY_LIMIT: "24" },
  ]) {
    const response = await f.request("/api/public-config", {}, override);
    expect(await response.json()).toMatchObject({
      mailProviders: [],
      features: { outlook: false },
    });
  }
  const view = await f.request("/api/onboarding?connectionId=outlook");
  expect(await view.json()).toMatchObject({
    capabilities: { mailboxProviders: ["outlook"] },
  });
  await f.start();
  expect(network).not.toHaveBeenCalled();
  expect(
    await db
      .prepare(
        "SELECT scheduling_state FROM connections WHERE user_id=? AND id='outlook'",
      )
      .bind(f.session.tenant.userId)
      .first("scheduling_state"),
  ).toBe("active");
  expect(
    await db
      .prepare(
        "SELECT slice_key,stage FROM sync_states WHERE user_id=? ORDER BY slice_key",
      )
      .bind(f.session.tenant.userId)
      .all(),
  ).toMatchObject({
    results: [
      { slice_key: "live" },
      { slice_key: "older", stage: "waiting_recent" },
      { slice_key: "recent", stage: "queued" },
    ],
  });
  console.log(
    JSON.stringify({ case: "T17-worker-start", statements: f.counts }),
  );
});

it("OUTLOOK-02 actual Worker queue reaches Graph inventory through encrypted owned credentials within 40 statements", async () => {
  const f = await fixture("outlook-runtime-discovery");
  await f.start();
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.href);
    expect(url.origin).toBe("https://graph.microsoft.com");
    expect(new Headers(init?.headers).get("prefer")).toContain(
      'IdType="ImmutableId"',
    );
    const alias = url.pathname.split("/").at(-1);
    if (!alias) throw new Error("Synthetic folder alias missing");
    return url.pathname === "/v1.0/me/mailFolders"
      ? Response.json({
          value: [
            {
              id: "archive",
              parentFolderId: "root",
              displayName: "Synthetic archive",
              childFolderCount: 0,
              isHidden: false,
            },
          ],
        })
      : Response.json({
          id: `qa-${alias}`,
          parentFolderId: "root",
          displayName: "Synthetic exclusion",
          childFolderCount: 0,
          isHidden: false,
        });
  });
  const job = await db
    .prepare(
      "SELECT id FROM jobs WHERE user_id=? AND type='discover' AND status='ready' ORDER BY priority LIMIT 1",
    )
    .bind(f.session.tenant.userId)
    .first<string>("id");
  expect(job).toBeTruthy();
  if (!job) throw new Error("Synthetic discovery job missing");
  await f.consume(job);
  expect(calls.length).toBeGreaterThan(0);
  expect(
    await db
      .prepare("SELECT status,outcome_code FROM jobs WHERE user_id=? AND id=?")
      .bind(f.session.tenant.userId, job)
      .first(),
  ).toMatchObject({ status: "completed" });
  console.log(
    JSON.stringify({ case: "T17-worker-cold-inventory", statements: f.counts }),
  );
});

function graphTransport(
  events: string[],
  options: {
    revoked?: boolean;
    beforeRead?: (url: URL) => Promise<void>;
    afterFinancial?: () => Promise<void>;
    financial?:
      | "known"
      | "missing-usage"
      | "outage"
      | "timeout"
      | "refusal"
      | "rate-limit";
  } = {},
) {
  const received = new Date(Date.now() - 86400000).toISOString();
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === "https://login.microsoftonline.com") {
        events.push("refresh");
        return options.revoked
          ? Response.json({ error: "invalid_grant" }, { status: 400 })
          : Response.json({
              access_token: "synthetic-refreshed",
              refresh_token: "synthetic-rotated",
              token_type: "Bearer",
              expires_in: 3600,
              scope:
                "openid profile email https://graph.microsoft.com/Mail.Read",
            });
      }
      if (url.pathname === "/oidc/userinfo")
        return Response.json({
          sub: "synthetic-sub",
          email: "outlook@example.invalid",
        });
      if (url.origin === "https://routellm.abacus.ai") {
        events.push("financial");
        await options.afterFinancial?.();
        if (options.financial === "outage")
          throw new Error("Synthetic transport outage");
        if (options.financial === "timeout")
          return new Response(null, { status: 408 });
        if (options.financial === "rate-limit")
          return Response.json(
            { error: { code: "rate_limit" } },
            { status: 429, headers: { "Retry-After": "60" } },
          );
        if (options.financial === "refusal")
          return Response.json({
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: null,
                  refusal: "Synthetic refusal",
                },
              },
            ],
          });
        return Response.json({
          id: "synthetic-completion",
          object: "chat.completion",
          created: 1,
          model: "gpt-6-luna",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  schemaVersion: 1,
                  documentType: "invoice",
                  warnings: [],
                  records: [
                    {
                      merchant: "Synthetic Store",
                      documentDate: "2026-10-13",
                      eventDate: null,
                      currency: "EUR",
                      total: "15.00",
                      tax: null,
                      invoiceNumber: null,
                      orderReference: null,
                      paymentReference: null,
                      refundReference: null,
                      category: "shopping",
                      paymentEvidence: "explicitly-unpaid",
                      refundEvidence: "none",
                      paymentMethodHint: "unknown",
                      recurringCadence: "unknown",
                      paymentAmount: null,
                      refundAmount: null,
                      storeCreditAmount: null,
                      evidence: [
                        { field: "merchant", quote: "Synthetic Store" },
                        { field: "documentDate", quote: "2026-10-13" },
                        { field: "currency", quote: "EUR" },
                        { field: "total", quote: "Total EUR 15.00" },
                        { field: "payment", quote: "Unpaid invoice" },
                      ].map((item) => ({ ...item, inputPartId: "part-0" })),
                    },
                  ],
                }),
              },
              finish_reason: "stop",
            },
          ],
          ...(options.financial === "missing-usage"
            ? {}
            : {
                usage: {
                  prompt_tokens: 20,
                  completion_tokens: 10,
                  total_tokens: 30,
                },
              }),
        });
      }
      expect(url.origin).toBe("https://graph.microsoft.com");
      expect(new Headers(init?.headers).get("prefer")).toContain(
        'IdType="ImmutableId"',
      );
      expect(init?.redirect).toBe("manual");
      await options.beforeRead?.(url);
      if (url.pathname === "/v1.0/me/mailFolders") {
        events.push("inventory");
        return Response.json({
          value: [
            {
              id: "archive",
              parentFolderId: "root",
              displayName: "Synthetic archive",
              childFolderCount: 0,
              isHidden: false,
            },
          ],
        });
      }
      if (
        /\/mailFolders\/(junkemail|deleteditems|drafts|sentitems)$/.test(
          url.pathname,
        )
      ) {
        const alias = url.pathname.split("/").at(-1);
        events.push(`alias:${alias}`);
        return Response.json({
          id: `qa-${alias}`,
          parentFolderId: "root",
          displayName: "Excluded",
          childFolderCount: 0,
          isHidden: false,
        });
      }
      if (url.pathname === "/v1.0/me/mailFolders/archive/messages") {
        expect(url.searchParams.get("$top")).toBe("1");
        expect(new Headers(init?.headers).get("prefer")).toContain(
          "odata.maxpagesize=1",
        );
        events.push("list");
        const cutoff = url.searchParams.get("$filter")?.split(" lt ")[1];
        return Response.json({
          value:
            cutoff && Date.parse(cutoff) > Date.parse(received)
              ? [{ id: "immutable-message" }]
              : [],
        });
      }
      if (url.pathname === "/v1.0/me/mailFolders/archive/messages/delta") {
        events.push("delta");
        return Response.json({
          value: [{ id: "immutable-message" }],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/mailFolders/archive/messages/delta?$deltatoken=opaque%2B%2F%3D",
        });
      }
      if (url.pathname === "/v1.0/me/messages/immutable-message/attachments")
        return Response.json({ value: [] });
      if (url.pathname === "/v1.0/me/messages/immutable-message") {
        if (url.searchParams.get("$select")?.includes("body")) {
          events.push("content");
          return Response.json({
            id: "immutable-message",
            body: {
              contentType: "text",
              content:
                "Synthetic Store\nInvoice 2026-10-13\nTotal EUR 15.00\nUnpaid invoice",
            },
            hasAttachments: false,
          });
        }
        events.push("metadata");
        return Response.json({
          id: "immutable-message",
          parentFolderId: "archive",
          receivedDateTime: received,
          subject: "Synthetic receipt",
          isDraft: false,
        });
      }
      throw new Error(`Unexpected synthetic endpoint: ${url.pathname}`);
    });
}
async function drain(f: Awaited<ReturnType<typeof fixture>>, limit = 30) {
  for (let invocation = 0; invocation < limit; invocation++) {
    const job = await db
      .prepare(
        "SELECT id FROM jobs WHERE user_id=? AND status='ready' AND dispatch_at<=? ORDER BY priority,dispatch_at,id LIMIT 1",
      )
      .bind(f.session.tenant.userId, Date.now())
      .first<string>("id");
    if (!job) {
      const retry = await db
        .prepare(
          "SELECT id FROM jobs WHERE user_id=? AND status='retry_wait' AND retry_count<3 LIMIT 1",
        )
        .bind(f.session.tenant.userId)
        .first<string>("id");
      if (!retry) return;
      await db
        .prepare("UPDATE jobs SET dispatch_at=0 WHERE user_id=? AND id=?")
        .bind(f.session.tenant.userId, retry)
        .run();
      await f.consume(retry);
      continue;
    }
    const result = await f.consume(job);
    if (
      result.retryMessages.length &&
      !(await db
        .prepare(
          "SELECT 1 FROM jobs WHERE user_id=? AND id=? AND status='retry_wait'",
        )
        .bind(f.session.tenant.userId, job)
        .first())
    )
      return;
    if (
      await db
        .prepare(
          "SELECT 1 FROM jobs WHERE user_id=? AND id=? AND status='ready'",
        )
        .bind(f.session.tenant.userId, job)
        .first()
    )
      return;
  }
  throw new Error("Synthetic drain exceeded bounded invocations");
}
it("OUTLOOK-02/04 actual Worker drains archive discovery into mandatory Clef then financial extraction, without duplicate sources", async () => {
  const f = await fixture("outlook-runtime-pipeline");
  const events: string[] = [];
  // Keep the shared fixture implementation separate from this invocation's recording binding.
  f.bindings.AI = {
    run: vi.fn(async () => {
      events.push("clef");
      return {
        model: "clef",
        answers: {
          receipt: { type: "noul", noul: 0.9 },
          category: {
            type: "choice",
            choice: "uncategorized",
            probabilities: { uncategorized: 1 },
            confidence: 1,
          },
        },
        usage: { input_tokens: 10, output_tokens: 0 },
      };
    }),
  };
  await f.start();
  graphTransport(events);
  await drain(f);
  expect(events).toContain("inventory");
  expect(events).toContain("content");
  expect(events.filter((event) => event === "clef")).toHaveLength(1);
  expect(events.filter((event) => event === "financial")).toHaveLength(1);
  expect(events.indexOf("financial")).toBeGreaterThan(events.indexOf("clef"));
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM source_messages WHERE user_id=?")
      .bind(f.session.tenant.userId)
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare("SELECT total_minor,currency FROM purchases WHERE user_id=?")
      .bind(f.session.tenant.userId)
      .all(),
  ).toMatchObject({ results: [{ total_minor: 1500, currency: "EUR" }] });
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM ledger_entries WHERE user_id=?")
      .bind(f.session.tenant.userId)
      .first("n"),
  ).toBe(0);
  const unfinished = await db
    .prepare(
      "SELECT id,status,outcome_code FROM jobs WHERE user_id=? AND status<>'completed'",
    )
    .bind(f.session.tenant.userId)
    .all();
  expect(unfinished.results).toEqual([]);
  console.log(
    JSON.stringify({
      case: "T17-worker-pipeline",
      statements: f.counts,
      events,
    }),
  );
});

it.each([false, true])(
  "OUTLOOK-01/02 refreshed Outlook credentials preserve resumable cold inventory (warm=%s) within shared 40 SQL",
  async (warm) => {
    const f = await fixture(`outlook-runtime-refresh-${warm}`, true);
    await f.start();
    if (warm)
      await db
        .prepare(
          "INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id,excluded_folder_ids) VALUES(?,'outlook',1,'root',NULL,1,NULL,'pending','11111111-1111-4111-8111-111111111111',?)",
        )
        .bind(
          f.session.tenant.userId,
          JSON.stringify([
            "qa-junkemail",
            "qa-deleteditems",
            "qa-drafts",
            "qa-sentitems",
          ]),
        )
        .run();
    const events: string[] = [];
    graphTransport(events);
    await drain(f);
    expect(events.filter((event) => event === "refresh")).toHaveLength(1);
    expect(events).toContain("inventory");
    expect(
      await db
        .prepare(
          "SELECT credential_version FROM connections WHERE user_id=? AND id='outlook'",
        )
        .bind(f.session.tenant.userId)
        .first("credential_version"),
    ).toBe(2);
    expect(
      await db
        .prepare(
          "SELECT id,status,outcome_code FROM jobs WHERE user_id=? AND status IN ('paused_budget','retry_wait','failed')",
        )
        .bind(f.session.tenant.userId)
        .all(),
    ).toMatchObject({ results: [] });
    console.log(
      JSON.stringify({
        case: "T17-worker-refreshed-inventory",
        warm,
        statements: f.counts,
      }),
    );
  },
);

it.each(["revoked", "digest", "settings", "generation", "disconnect"] as const)(
  "OUTLOOK-01 content response after %s cannot reach Clef or persist documents",
  async (change) => {
    const f = await fixture(`outlook-runtime-fence-${change}`);
    await f.start();
    const events: string[] = [];
    let changed = false;
    graphTransport(events, {
      beforeRead: async (url) => {
        if (changed || !url.searchParams.get("$select")?.includes("body"))
          return;
        changed = true;
        const statements = {
          revoked:
            "UPDATE processing_consents SET revoked_at=1 WHERE user_id=?",
          digest:
            "UPDATE processing_consents SET accepted_configuration_digest='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE user_id=?",
          settings:
            "UPDATE ai_settings SET revision=revision+1 WHERE user_id=?",
          generation:
            "UPDATE connections SET generation=generation+1 WHERE user_id=?",
          disconnect:
            "UPDATE connections SET state='disconnected',generation=generation+1 WHERE user_id=?",
        };
        await db
          .prepare(statements[change])
          .bind(f.session.tenant.userId)
          .run();
      },
    });
    await drain(f);
    expect(changed).toBe(true);
    expect(events).not.toContain("financial");
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM documents WHERE user_id=?")
        .bind(f.session.tenant.userId)
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM usage_events WHERE user_id=?")
        .bind(f.session.tenant.userId)
        .first("n"),
    ).toBe(0);
  },
);

it.each([
  "known",
  "missing-usage",
  "outage",
  "timeout",
  "refusal",
  "rate-limit",
] as const)(
  "OUTLOOK-01 mandatory classification and financial %s settle within the actual shared40 SQL",
  async (financial) => {
    const f = await fixture(`outlook-runtime-financial-${financial}`);
    await f.start();
    const events: string[] = [];
    graphTransport(events, { financial });
    await drain(f);
    expect(events.filter((event) => event === "financial")).toHaveLength(1);
    const usage = await db
      .prepare(
        "SELECT state FROM usage_events WHERE user_id=? AND destination_id='abacus-routellm'",
      )
      .bind(f.session.tenant.userId)
      .all();
    expect(usage.results).toEqual([
      { state: financial === "known" ? "known" : "uncertain" },
    ]);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND outcome_code='attempts-exhausted'",
        )
        .bind(f.session.tenant.userId)
        .first("n"),
    ).toBe(0);
    expect(Math.max(...f.counts)).toBeLessThanOrEqual(40);
    console.error(
      JSON.stringify({
        case: "T17-financial-budget",
        financial,
        statements: f.counts,
      }),
    );
  },
);

it("OUTLOOK-02 hourly Worker sync refreshes recursive inventory so new folders enter durable coverage", async () => {
  const f = await fixture("outlook-runtime-inventory-refresh");
  await f.start();
  const events: string[] = [];
  const transport = graphTransport(events);
  const base = transport.getMockImplementation();
  if (!base) throw new Error("Synthetic Graph transport missing");
  let addedFolder = false;
  const nextInventory =
    "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=added%2B%2F%3D";
  transport.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (addedFolder && url.pathname === "/v1.0/me/mailFolders") {
      events.push("inventory");
      if (url.searchParams.has("$skiptoken")) {
        expect(url.href).toBe(nextInventory);
        return Response.json({
          value: [
            {
              id: "new-folder",
              parentFolderId: "root",
              displayName: "New folder",
              childFolderCount: 1,
              isHidden: false,
            },
          ],
        });
      }
      return Response.json({
        value: [
          {
            id: "archive",
            parentFolderId: "root",
            displayName: "Archive",
            childFolderCount: 0,
            isHidden: false,
          },
        ],
        "@odata.nextLink": nextInventory,
      });
    }
    if (url.pathname === "/v1.0/me/mailFolders/new-folder/messages/delta")
      return Response.json({
        value: [],
        "@odata.deltaLink":
          "https://graph.microsoft.com/v1.0/me/mailFolders/new-folder/messages/delta?$deltatoken=new%2B%2F%3D",
      });
    if (url.pathname === "/v1.0/me/mailFolders/new-folder/childFolders")
      return Response.json({
        value: [
          {
            id: "nested-folder",
            parentFolderId: "new-folder",
            displayName: "Nested",
            childFolderCount: 0,
            isHidden: false,
          },
        ],
      });
    if (url.pathname === "/v1.0/me/mailFolders/nested-folder/messages/delta")
      return Response.json({
        value: [],
        "@odata.deltaLink":
          "https://graph.microsoft.com/v1.0/me/mailFolders/nested-folder/messages/delta?$deltatoken=nested%2B%2F%3D",
      });
    if (url.pathname.endsWith("/messages")) return Response.json({ value: [] });
    return base(input, init);
  });
  await drain(f);
  events.length = 0;
  const live = await db
    .prepare(
      "SELECT id FROM sync_states WHERE user_id=? AND scope_key='mailbox' AND slice_key='live'",
    )
    .bind(f.session.tenant.userId)
    .first<string>("id");
  const consent = await db
    .prepare(
      "SELECT id FROM processing_consents WHERE user_id=? AND revoked_at IS NULL",
    )
    .bind(f.session.tenant.userId)
    .first<string>("id");
  for (let cycle = 0; cycle < 2; cycle++) {
    if (cycle === 1) {
      events.length = 0;
      addedFolder = true;
    }
    const id = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at) VALUES(?,?,'outlook',?,1,?,'sync',?,'ready',0)",
      )
      .bind(
        id,
        f.session.tenant.userId,
        consent,
        live,
        `sync:outlook:1:hourly:${cycle}`,
      )
      .run();
    await f.consume(id);
    await drain(f);
  }
  expect(events).toContain("inventory");
  expect(
    await db
      .prepare(
        "SELECT folder_id FROM outlook_folders WHERE user_id=? ORDER BY folder_id",
      )
      .bind(f.session.tenant.userId)
      .all(),
  ).toMatchObject({
    results: [
      { folder_id: "archive" },
      { folder_id: "nested-folder" },
      { folder_id: "new-folder" },
    ],
  });
  expect(
    await db
      .prepare(
        "SELECT history_cursor FROM sync_states WHERE user_id=? AND scope_key='outlook:1:new-folder' AND slice_key='live'",
      )
      .bind(f.session.tenant.userId)
      .first("history_cursor"),
  ).toBe(
    "https://graph.microsoft.com/v1.0/me/mailFolders/new-folder/messages/delta?$deltatoken=new%2B%2F%3D",
  );
  expect(
    await db
      .prepare(
        "SELECT history_cursor FROM sync_states WHERE user_id=? AND scope_key='outlook:1:nested-folder' AND slice_key='live'",
      )
      .bind(f.session.tenant.userId)
      .first("history_cursor"),
  ).toBe(
    "https://graph.microsoft.com/v1.0/me/mailFolders/nested-folder/messages/delta?$deltatoken=nested%2B%2F%3D",
  );
});

async function hourly(f: Awaited<ReturnType<typeof fixture>>, cycle: number) {
  const live = await db
    .prepare(
      "SELECT id FROM sync_states WHERE user_id=? AND scope_key='mailbox' AND slice_key='live'",
    )
    .bind(f.session.tenant.userId)
    .first<string>("id");
  const consent = await db
    .prepare(
      "SELECT id FROM processing_consents WHERE user_id=? AND revoked_at IS NULL",
    )
    .bind(f.session.tenant.userId)
    .first<string>("id");
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at) VALUES(?,?,'outlook',?,1,?,'sync',?,'ready',0)",
    )
    .bind(
      id,
      f.session.tenant.userId,
      consent,
      live,
      `sync:outlook:1:hourly:${cycle}`,
    )
    .run();
  await f.consume(id);
  await drain(f);
}
it("OUTLOOK-02/03/04 second and third hourly rounds poll existing folders with saved opaque delta URLs and create new purchase evidence", async () => {
  const f = await fixture("outlook-runtime-hourly-existing");
  await f.start();
  const events: string[] = [];
  const network = graphTransport(events);
  const base = network.getMockImplementation();
  if (!base) throw new Error("Synthetic Graph transport missing");
  let cycle = 0;
  const deltaUrls: string[] = [];
  network.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const message = cycle === 0 ? "immutable-message" : `new-message-${cycle}`;
    if (url.pathname.endsWith("/messages/delta")) {
      deltaUrls.push(url.href);
      return Response.json({
        value: [{ id: message }],
        "@odata.deltaLink": `https://graph.microsoft.com/v1.0/me/mailFolders/archive/messages/delta?$deltatoken=round${cycle}%2B%2F%3D`,
      });
    }
    if (cycle > 0 && url.pathname === `/v1.0/me/messages/${message}`)
      return Response.json(
        url.searchParams.get("$select")?.includes("body")
          ? {
              id: message,
              body: {
                contentType: "text",
                content: `Synthetic Store\nInvoice 2026-10-13\nTotal EUR 15.00\nUnpaid invoice\nSource ${message}`,
              },
              hasAttachments: false,
            }
          : {
              id: message,
              parentFolderId: "archive",
              receivedDateTime: new Date(Date.now() - 60000).toISOString(),
              subject: "Synthetic receipt",
              isDraft: false,
            },
      );
    if (
      cycle > 0 &&
      url.pathname === `/v1.0/me/messages/${message}/attachments`
    )
      return Response.json({ value: [] });
    return base(input, init);
  });
  await drain(f);
  for (cycle = 0; cycle < 3; cycle++) await hourly(f, cycle);
  expect(deltaUrls).toHaveLength(3);
  expect(deltaUrls[1]).toBe(
    "https://graph.microsoft.com/v1.0/me/mailFolders/archive/messages/delta?$deltatoken=round0%2B%2F%3D",
  );
  expect(deltaUrls[2]).toBe(
    "https://graph.microsoft.com/v1.0/me/mailFolders/archive/messages/delta?$deltatoken=round1%2B%2F%3D",
  );
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM source_messages WHERE user_id=?")
      .bind(f.session.tenant.userId)
      .first("n"),
  ).toBe(3);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM purchases WHERE user_id=?")
      .bind(f.session.tenant.userId)
      .first("n"),
  ).toBe(3);
});

it.each(["settings", "digest", "lease"] as const)(
  "OUTLOOK-01 cached classification followed by %s change before financial transport cannot send or advance",
  async (change) => {
    const f = await fixture(`outlook-runtime-cached-fence-${change}`);
    await f.start();
    const events: string[] = [];
    let changed = false;
    f.bindings.AI = {
      run: async () => {
        events.push("clef");
        return syntheticClassificationBindings.AI.run();
      },
    };
    const changes = {
      settings: "UPDATE ai_settings SET revision=revision+1 WHERE user_id=?",
      digest:
        "UPDATE processing_consents SET accepted_configuration_digest='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE user_id=?",
      lease:
        "UPDATE jobs SET fence=fence+1 WHERE user_id=? AND status='leased'",
    };
    graphTransport(events, {
      beforeRead: async (url) => {
        if (
          changed ||
          !events.includes("clef") ||
          !url.searchParams.get("$select")?.includes("body")
        )
          return;
        changed = true;
        await db.prepare(changes[change]).bind(f.session.tenant.userId).run();
      },
    });
    await drain(f);
    expect(changed).toBe(true);
    expect(events).not.toContain("financial");
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) n FROM usage_events WHERE user_id=? AND destination_id='cloudflare-clef'",
        )
        .bind(f.session.tenant.userId)
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM purchases WHERE user_id=?")
        .bind(f.session.tenant.userId)
        .first("n"),
    ).toBe(0);
  },
);
it.each(["settings", "digest", "lease", "revoked"] as const)(
  "OUTLOOK-01 %s change in financial response cannot cache or create a stale continuation under40 SQL",
  async (change) => {
    const f = await fixture(`outlook-runtime-late-financial-${change}`);
    await f.start();
    const events: string[] = [];
    const changes = {
      settings: "UPDATE ai_settings SET revision=revision+1 WHERE user_id=?",
      digest:
        "UPDATE processing_consents SET accepted_configuration_digest='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE user_id=?",
      lease:
        "UPDATE jobs SET fence=fence+1 WHERE user_id=? AND status='leased'",
      revoked: "UPDATE processing_consents SET revoked_at=1 WHERE user_id=?",
    };
    graphTransport(events, {
      afterFinancial: async () => {
        await db.prepare(changes[change]).bind(f.session.tenant.userId).run();
      },
    });
    await drain(f);
    expect(events.filter((event) => event === "financial")).toHaveLength(1);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) n FROM ai_extractions WHERE user_id=? AND destination_id='abacus-routellm' AND completed_at IS NOT NULL",
        )
        .bind(f.session.tenant.userId)
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) n FROM discovery_source_jobs WHERE user_id=? AND pipeline_stage='reconcile'",
        )
        .bind(f.session.tenant.userId)
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM purchases WHERE user_id=?")
        .bind(f.session.tenant.userId)
        .first("n"),
    ).toBe(0);
    expect(Math.max(...f.counts)).toBeLessThanOrEqual(40);
  },
);
