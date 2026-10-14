import { env } from "cloudflare:workers";
import { createLoginAuth, type LoginConfiguration } from "@invoxim/adapters";
import type { JobLease, LifecycleSession, TenantContext } from "@invoxim/core";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { createLifecycleCleanup } from "../../../packages/adapters/src/lifecycle/cleanup";
import type { LifecycleBindings } from "../../../packages/adapters/src/lifecycle/configuration";
import { createDeletionJournal } from "../../../packages/adapters/src/lifecycle/journal";
import { createLifecycleRepository } from "../../../packages/adapters/src/lifecycle/repository";
import { createPipelineRepository } from "../../../packages/adapters/src/pipeline/repository";
import worker from "../src/index";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;

const configuration: LoginConfiguration = {
  origin: "https://qa-lifecycle.example.invalid",
  secret: "synthetic-lifecycle-secret-never-production-12345",
  googleClientId: "synthetic",
  googleClientSecret: "synthetic",
  allowedEmails: ["qa@example.invalid"],
};
const bindings: LifecycleBindings = {
  DB: env.DB,
  AUTH_ENABLED: "true",
  AUTH_ORIGIN: configuration.origin,
  AUTH_SECRET: configuration.secret,
  AUTH_GOOGLE_CLIENT_ID: configuration.googleClientId,
  AUTH_GOOGLE_CLIENT_SECRET: configuration.googleClientSecret,
  AUTH_ALLOWED_EMAILS: JSON.stringify(["qa@example.invalid"]),
  LIFECYCLE_ENABLED: "true",
};
const policy = {
  dispatchLimit: 1,
  scheduleLimit: 1,
  tenantConcurrency: 1,
  globalConcurrency: 2,
  maxAttempts: 3,
  leaseMs: 300000,
  redeliveryMs: 1000,
};
beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((s) => s.trim()))
      await db.prepare(statement).run();
});
afterEach(() => vi.restoreAllMocks());
async function seed(name: string, merchant = "QA shared purchase") {
  const now = Date.now();
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)',
    )
    .bind(name, name, `${name}@example.invalid`, now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
    )
    .bind(name, now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO ai_settings(user_id,mode,provider_id,model_id,config_version,revision,consent_version) VALUES(?,'hosted','synthetic','small','qa-v1',1,1)",
    )
    .bind(name)
    .run();
  const auth = await createLoginAuth(db, {
      ...configuration,
      allowedEmails: [`${name}@example.invalid`],
    }).$context,
    saved = await auth.internalAdapter.createSession(name, false);
  if (!saved) throw new Error("Missing lifecycle session positive control");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(configuration.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(saved.token),
  );
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${saved.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
  const tenant = { userId: name, authority: "session" } as TenantContext;
  const session: LifecycleSession = {
    tenant,
    sessionId: saved.id,
    authenticatedAt: now,
  };
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES(?,?,?,'qa shared purchase','2026-10-10',10000,'EUR','paid')",
    )
    .bind(`p-${name}`, name, merchant)
    .run();
  const record = {
    merchant,
    documentDate: "2026-10-10",
    eventDate: "2026-10-10",
    currency: "EUR",
    total: "100.00",
    tax: null,
    invoiceNumber: "I1",
    orderReference: "ORDER-1",
    paymentReference: "PAY-1",
    refundReference: null,
    category: "shopping",
    paymentEvidence: "explicitly-paid",
    refundEvidence: "none",
    paymentMethodHint: "card",
    recurringCadence: "unknown",
    paymentAmount: "100.00",
    refundAmount: null,
    storeCreditAmount: null,
    provenance: [],
  };
  for (const suffix of ["a", "b"]) {
    const c = `c-${name}-${suffix}`,
      o = `o-${name}-${suffix}`;
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,credential_ciphertext,credential_key_version,credential_version,scheduling_state) VALUES(?,?,'mailbox','gmail',?,?,'synthetic-opaque-ciphertext',1,1,'active')",
      )
      .bind(c, name, c, `${suffix}@example.invalid`)
      .run();
    await db
      .prepare(
        "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized,accepted_configuration_digest) VALUES(?,?,?,1,'synthetic','local',1,0,1,?)",
      )
      .bind(`pc-${c}`, name, c, "f".repeat(64))
      .run();
    await db
      .prepare(
        "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,?, ?,0,1)",
      )
      .bind(o, name, c, o)
      .run();
    await db
      .prepare(
        "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES(?,?,?,'body',?,'text/plain',10)",
      )
      .bind(o, name, o, "a".repeat(64))
      .run();
    await db
      .prepare(
        "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,structured_fields,review_state) VALUES(?,?,?,0,'qa-v1',1,'explicitly-paid',?,?,'accepted')",
      )
      .bind(
        o,
        name,
        o,
        JSON.stringify({
          schemaVersion: 1,
          merchant,
          date: "2026-10-10",
          totalMinor: "10000",
          currency: "EUR",
        }),
        JSON.stringify({ schemaVersion: 1, documentType: "receipt", record }),
      )
      .run();
    await db
      .prepare(
        "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,?,?,'document')",
      )
      .bind(name, `p-${name}`, o)
      .run();
  }
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES(?,?,?,?,'qa-payment','payment',10000,'EUR','2026-10-10','explicit-event-date',1)",
    )
    .bind(`e-${name}`, name, `p-${name}`, `o-${name}-a`)
    .run();
  return { name, session, cookie };
}
async function request(
  owner: Awaited<ReturnType<typeof seed>>,
  path: string,
  method = "GET",
  body?: unknown,
  extra: Partial<LifecycleBindings> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  let mutationHeaders: Record<string, string> = {};
  if (method !== "GET") {
    const capabilities = await request(
      owner,
      "/lifecycle/capabilities",
      "GET",
      undefined,
      extra,
    );
    expect(capabilities.status).toBe(200);
    const payload = (await capabilities.json()) as { mutationToken?: unknown };
    if (typeof payload.mutationToken !== "string")
      throw new Error("Lifecycle read-issued mutation token missing");
    mutationHeaders = { "X-Workspace-Token": payload.mutationToken };
  }
  // Each HTTP invocation has its own native query budget, including the token read.
  const meter = createInvocationDatabase(env.DB, 40);
  const response = await worker.fetch(
    new Request(`${configuration.origin}/api${path}`, {
      method,
      headers: {
        Cookie: owner.cookie,
        ...(method !== "GET"
          ? {
              Origin: configuration.origin,
              "Content-Type": "application/json",
              "Idempotency-Key": "qa-command-1234567890",
            }
          : {}),
        ...mutationHeaders,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    {
      ...bindings,
      ...extra,
      AUTH_ALLOWED_EMAILS: JSON.stringify([`${owner.name}@example.invalid`]),
      DB: meter.db,
    },
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  return response;
}
function csvRows(input: string) {
  const rows: string[][] = [],
    cells: string[] = [];
  let cell = "",
    quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') {
      if (quoted && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else if ((c === "\r" || c === "\n") && !quoted) {
      if (c === "\r" && input[i + 1] === "\n") i++;
      cells.push(cell);
      rows.push([...cells]);
      cells.length = 0;
      cell = "";
    } else cell += c;
  }
  if (cell || cells.length) {
    cells.push(cell);
    rows.push(cells);
  }
  return rows;
}
async function leasedSource(
  owner: Awaited<ReturnType<typeof seed>>,
): Promise<JobLease> {
  const connection = `c-${owner.name}-a`,
    now = Date.now();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,lease_id,lease_expires_at,fence) VALUES(?,?,?,?,1,'source-extract',?,'leased',?,'old-lease',?,1)",
    )
    .bind(
      `j-${owner.name}`,
      owner.name,
      connection,
      `pc-${connection}`,
      `j-${owner.name}`,
      now,
      now + 300000,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id) VALUES(?,?,?)",
    )
    .bind(owner.name, `j-${owner.name}`, `o-${owner.name}-a`)
    .run();
  return {
    context: { userId: owner.name, authority: "job" } as TenantContext,
    jobId: `j-${owner.name}`,
    connectionId: connection,
    consentId: `pc-${connection}`,
    generation: 1,
    syncStateId: null,
    type: "source-extract",
    leaseId: "old-lease",
    fence: 1,
    expiresAt: now + 300000,
    attempt: 1,
  };
}
it.each(["=CMD()", "+CMD()", "-CMD()", "@CMD()", "\tCMD()", "\rCMD()"])(
  "LIFECYCLE-01 actual CSV neutralizes formula-leading merchant %j while exact cash remains numeric",
  async (merchant) => {
    const owner = await seed(`qa-life-csv-${merchant.charCodeAt(0)}`, merchant);
    const response = await request(
      owner,
      "/export?format=csv&from=2026-10-01&to=2026-10-31",
    );
    expect(response.status).toBe(200);
    const rows = csvRows(await response.text()),
      header = rows[0];
    if (!header) throw new Error("Missing CSV header");
    const merchantColumn = header.indexOf("merchant");
    expect(merchantColumn).toBeGreaterThanOrEqual(0);
    for (const row of rows.slice(1))
      expect(row[merchantColumn]).toBe(`'${merchant}`);
    const cash = rows
      .slice(1)
      .find((row) => row[header.indexOf("entry_id")] === `e-${owner.name}`);
    expect(cash).toBeDefined();
    expect(cash?.[header.indexOf("entry_minor")]).toBe("10000");
    expect(cash?.[header.indexOf("entry_kind")]).toBe("payment");
    expect(cash?.[header.indexOf("event_date")]).toBe("2026-10-10");
    expect(cash?.[header.indexOf("date_basis")]).toBe("explicit-event-date");
    expect(cash?.[header.indexOf("eligible")]).toBe("true");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="purchase-records.csv"',
    );
  },
);
it("LIFECYCLE-02 export shares period/filter oracle with list and summary without exposing other tenants or raw state", async () => {
  const a = await seed("qa-life-export-a"),
    b = await seed("qa-life-export-b", "Private other owner");
  const query = "from=2026-10-01&to=2026-10-31&q=shared";
  const response = await request(a, `/export?format=json&${query}`);
  expect(response.status).toBe(200);
  const output = (await response.json()) as {
    purchases: Array<{ id: string }>;
    summary: unknown;
    ledgerEntries: Array<{ minor: string; kind: string }>;
  };
  expect(output.purchases.map((p) => p.id)).toEqual([`p-${a.name}`]);
  expect(output.summary).toMatchObject({
    totals: [
      {
        currency: "EUR",
        paidMinor: "10000",
        refundedMinor: "0",
        netMinor: "10000",
      },
    ],
    recordCount: 1,
  });
  expect(output.ledgerEntries).toMatchObject([
    { kind: "payment", minor: "10000" },
  ]);
  const text = JSON.stringify(output);
  expect(text).not.toMatch(
    /Private other owner|synthetic-opaque|credential|quote|raw_body|model_transcript/,
  );
  expect(
    (await request(a, "/export?format=json&userId=qa-life-export-b")).status,
  ).toBe(400);
  expect((await request(a, `/purchases/p-${b.name}`)).status).toBe(404);
});
it("LIFECYCLE-03 configured journal refusal atomically disables access but cannot erase before durable acknowledgment; recovery resumes", async () => {
  const owner = await seed("qa-life-journal");
  const lease = await leasedSource(owner);
  const jobStore = createJobStore(db, { policy });
  expect(await jobStore.checkpoint(lease)).toBe(true);
  let acknowledged = false;
  const append = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://deletion-journal.invalid/v1/deletions");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      schemaVersion: 1,
      userId: owner.name,
    });
    expect(String(init?.body)).not.toMatch(
      /email|merchant|credential|10000|quote/,
    );
    return new Response(null, { status: acknowledged ? 204 : 503 });
  });
  const binding: Fetcher = {
    fetch: append,
    connect() {
      throw new Error("Synthetic journal does not expose socket connections");
    },
  };
  const journal = createDeletionJournal(
    binding,
    "synthetic-independent-journal-secret-12345",
  );
  if (!journal) throw new Error("Missing journal positive control");
  const response = await request(
    owner,
    "/account/delete",
    "POST",
    { confirmed: true, version: 1 },
    {
      DELETION_JOURNAL: binding,
      DELETION_JOURNAL_SECRET: "synthetic-independent-journal-secret-12345",
    },
  );
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({
    status: "awaiting_journal",
    accessDisabled: true,
    driveFilesDeleted: false,
  });
  expect(
    await db
      .prepare("SELECT status FROM profiles WHERE user_id=?")
      .bind(owner.name)
      .first("status"),
  ).toBe("deleting");
  expect((await request(owner, "/purchases")).status).toBe(401);
  expect(await jobStore.checkpoint(lease)).toBe(false);
  expect(await jobStore.claim(lease.jobId)).toBeNull();
  expect(
    await createPipelineRepository(db, {
      processingDigest: async () => "f".repeat(64),
    }).stageDocuments(lease, [
      {
        id: "late-account-doc",
        partKey: "late",
        contentHash: "b".repeat(64),
        mime: "text/plain",
        byteLength: 10,
        parseState: "ready",
        parserVersion: "qa-v1",
      },
    ]),
  ).toBe("stale");
  expect(await createLifecycleCleanup(db, null).runOne()).toEqual({
    status: "awaiting_journal",
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM purchases WHERE user_id=?")
      .bind(owner.name)
      .first("n"),
  ).toBe(1);
  acknowledged = true;
  const cleanup = createLifecycleCleanup(db, journal);
  for (let unit = 0; unit < 40; unit++) {
    if ((await cleanup.runOne()).status === "completed") break;
  }
  expect(
    await db
      .prepare('SELECT COUNT(*) n FROM "user" WHERE id=?')
      .bind(owner.name)
      .first("n"),
  ).toBe(0);
  expect(append).toHaveBeenCalledTimes(2);
});
it("LIFECYCLE-03 absent journal, stale authentication, unconfirmed bodies and wrong origins refuse mutations", async () => {
  const owner = await seed("qa-life-rejections");
  expect(
    (
      await request(owner, "/account/delete", "POST", {
        confirmed: true,
        version: 1,
      })
    ).status,
  ).toBe(503);
  expect(
    (
      await request(owner, "/account/delete", "POST", {
        confirmed: false,
        version: 1,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(
        owner,
        "/connections/c-qa-life-rejections-a",
        "DELETE",
        { confirmed: true, generation: 1, credentialVersion: 1 },
        {},
        { Origin: "https://attacker.example.invalid" },
      )
    ).status,
  ).toBe(403);
  await db
    .prepare("UPDATE session SET createdAt=? WHERE id=?")
    .bind(Date.now() - 3600001, owner.session.sessionId)
    .run();
  expect(
    (
      await request(owner, "/account/delete", "POST", {
        confirmed: true,
        version: 1,
      })
    ).status,
  ).toBe(403);
  expect(
    await db
      .prepare("SELECT status FROM profiles WHERE user_id=?")
      .bind(owner.name)
      .first("status"),
  ).toBe("active");
});
it("LIFECYCLE-04 local disconnect preserves shared cash, cancels a leased consumer and is idempotent", async () => {
  const owner = await seed("qa-life-disconnect"),
    connection = `c-${owner.name}-a`;
  const lease = await leasedSource(owner);
  const store = createJobStore(db, { policy });
  expect(await store.checkpoint(lease)).toBe(true);
  const body = { confirmed: true, generation: 1, credentialVersion: 1 };
  const response = await request(
    owner,
    `/connections/${connection}`,
    "DELETE",
    body,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    generation: 2,
    recordsRetained: true,
    localCredentialsRemoved: true,
  });
  expect(await store.checkpoint(lease)).toBe(false);
  expect(
    await createPipelineRepository(db, {
      processingDigest: async () => "f".repeat(64),
    }).stageDocuments(lease, [
      {
        id: "late-doc",
        partKey: "late",
        contentHash: "b".repeat(64),
        mime: "text/plain",
        byteLength: 10,
        parseState: "ready",
        parserVersion: "qa-v1",
      },
    ]),
  ).toBe("stale");
  expect(
    (await request(owner, `/connections/${connection}`, "DELETE", body)).status,
  ).toBe(200);
  expect(
    (
      await request(owner, `/connections/${connection}`, "DELETE", {
        ...body,
        generation: 2,
        credentialVersion: 2,
      })
    ).status,
  ).toBe(409);
  expect(
    await db
      .prepare(
        "SELECT generation,credential_ciphertext FROM connections WHERE user_id=? AND id=?",
      )
      .bind(owner.name, connection)
      .first(),
  ).toEqual({ generation: 2, credential_ciphertext: null });
  expect(
    await db
      .prepare(
        "SELECT CAST(SUM(amount_minor) AS TEXT) total FROM ledger_entries WHERE user_id=? AND eligible=1",
      )
      .bind(owner.name)
      .first("total"),
  ).toBe("10000");
});
it("LIFECYCLE-05 deleting one mailbox keeps the independently supported shared event and rejects stale preview", async () => {
  const owner = await seed("qa-life-source"),
    repo = createLifecycleRepository(db),
    connection = `c-${owner.name}-a`;
  const preview = await repo.preview(owner.session.tenant, connection);
  expect(preview).toMatchObject({
    sources: 1,
    documents: 1,
    observations: 1,
    purchasesRemoved: 0,
    purchasesRetained: 1,
    eventsRemoved: 0,
    eventsRetained: 1,
    driveFilesDeleted: false,
  });
  await expect(
    repo.deleteData(
      owner.session,
      connection,
      {
        confirmed: true,
        generation: 2,
        previewFingerprint: preview.fingerprint,
      },
      "qa-source-command-1234",
    ),
  ).rejects.toThrow();
  await repo.deleteData(
    owner.session,
    connection,
    { confirmed: true, generation: 1, previewFingerprint: preview.fingerprint },
    "qa-source-command-1234",
  );
  const cleanup = createLifecycleCleanup(db, null);
  for (let unit = 0; unit < 30; unit++) {
    if ((await cleanup.runOne()).status === "completed") break;
  }
  expect(
    await db
      .prepare(
        "SELECT observation_id,amount_minor,eligible FROM ledger_entries WHERE user_id=?",
      )
      .bind(owner.name)
      .first(),
  ).toEqual({
    observation_id: `o-${owner.name}-b`,
    amount_minor: 10000,
    eligible: 1,
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM purchases WHERE user_id=?")
      .bind(owner.name)
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM observations WHERE user_id=?")
      .bind(owner.name)
      .first("n"),
  ).toBe(1);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
it("LIFECYCLE-03 independent journal idempotency is tenant scoped and stable for the same marker", async () => {
  const keys: string[] = [];
  const binding: Fetcher = {
    async fetch(_input, init) {
      const key = new Headers(init?.headers).get("idempotency-key");
      if (!key) throw new Error("Missing journal request key");
      keys.push(key);
      return new Response(null, { status: 204 });
    },
    connect() {
      throw new Error("Synthetic journal has no socket API");
    },
  };
  const journal = createDeletionJournal(
    binding,
    "synthetic-independent-journal-secret-12345",
  );
  if (!journal) throw new Error("Missing journal positive control");
  const marker = {
    userId: "qa-life-marker-a",
    requestId: "same-client-key-123456",
    deletedAt: 1000,
  };
  await journal.append(marker);
  await journal.append(marker);
  await journal.append({ ...marker, userId: "qa-life-marker-b" });
  expect(keys[0]).toBe(keys[1]);
  expect(keys[0]).not.toBe(keys[2]);
  expect(keys[0]).not.toBe(marker.requestId);
});

it("LIFECYCLE-02 all source mutations deny another tenant identically to a missing target", async () => {
  const a = await seed("qa-life-cross-a"),
    b = await seed("qa-life-cross-b");
  for (const [suffix, method, body] of [
    ["", "DELETE", { confirmed: true, generation: 1, credentialVersion: 1 }],
    ["/delete-data-preview", "POST", {}],
    [
      "/delete-data",
      "POST",
      { confirmed: true, generation: 1, previewFingerprint: "0".repeat(64) },
    ],
  ] as const) {
    const foreign = await request(
      a,
      `/connections/c-${b.name}-a${suffix}`,
      method,
      body,
    );
    const missing = await request(
      a,
      `/connections/qa-no-such-target${suffix}`,
      method,
      body,
    );
    expect(foreign.status).toBe(missing.status);
    expect(foreign.status).toBeGreaterThanOrEqual(400);
  }
  expect(
    await db
      .prepare(
        "SELECT state,credential_ciphertext,generation FROM connections WHERE user_id=? AND id=?",
      )
      .bind(b.name, `c-${b.name}-a`)
      .first(),
  ).toEqual({
    state: "connected",
    credential_ciphertext: "synthetic-opaque-ciphertext",
    generation: 1,
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM ledger_entries WHERE user_id=?")
      .bind(b.name)
      .first("n"),
  ).toBe(1);
});
it("LIFECYCLE-03 actual scheduler resumes acknowledged deletion under one shared40 meter and respects the disabled flag", async () => {
  const owner = await seed("qa-life-scheduled"),
    repo = createLifecycleRepository(db);
  const marker = await repo.beginDeletion(
    owner.session,
    { confirmed: true, version: 1 },
    {
      userId: owner.name,
      deletedAt: Date.now(),
      requestId: "qa-scheduled-command-1234",
    },
  );
  await repo.acknowledgeJournal(marker);
  const controller: ScheduledController = {
    scheduledTime: Date.now(),
    cron: "*/5 * * * *",
    noRetry() {},
  };
  const disabled = createInvocationDatabase(env.DB, 40);
  await worker.scheduled(controller, {
    ...bindings,
    LIFECYCLE_ENABLED: "false",
    DB: disabled.db,
  });
  expect(
    await db
      .prepare("SELECT stage FROM lifecycle_deletions WHERE user_id=?")
      .bind(owner.name)
      .first("stage"),
  ).toBe(0);
  const enabled = createInvocationDatabase(env.DB, 40);
  await worker.scheduled(controller, { ...bindings, DB: enabled.db });
  expect(
    await db
      .prepare("SELECT stage FROM lifecycle_deletions WHERE user_id=?")
      .bind(owner.name)
      .first<number>("stage"),
  ).toBeGreaterThan(0);
  expect(enabled.executedStatements()).toBeGreaterThan(0);
  expect(enabled.executedStatements()).toBeLessThanOrEqual(40);
  for (let invocation = 0; invocation < 40; invocation++) {
    const left = await db
      .prepare('SELECT COUNT(*) n FROM "user" WHERE id=?')
      .bind(owner.name)
      .first("n");
    if (left === 0) break;
    const meter = createInvocationDatabase(env.DB, 40);
    await worker.scheduled(controller, { ...bindings, DB: meter.db });
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  }
  expect(
    await db
      .prepare('SELECT COUNT(*) n FROM "user" WHERE id=?')
      .bind(owner.name)
      .first("n"),
  ).toBe(0);
});
it("LIFECYCLE-03 every account cleanup unit erases at most 100 purchases before final identity deletion", async () => {
  const owner = await seed("qa-life-bounded-purchases");
  await db.batch(
    Array.from({ length: 104 }, (_, index) =>
      db
        .prepare(
          "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES(?,?,'Bounded','bounded','2026-10-10',100,'EUR','unknown')",
        )
        .bind(`bounded-${index}`, owner.name),
    ),
  );
  await db
    .prepare("UPDATE profiles SET status='deleting' WHERE user_id=?")
    .bind(owner.name)
    .run();
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,stage,journal_ack) VALUES(?,'account',?,'bounded-request',0,0,1)",
    )
    .bind(owner.name, owner.name)
    .run();
  let previous = 105;
  let completed = false;
  for (let unit = 0; unit < 60; unit++) {
    const meter = createInvocationDatabase(env.DB, 40);
    const result = await createLifecycleCleanup(meter.db, null).runOne();
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
    const remaining = await db
      .prepare("SELECT COUNT(*) n FROM purchases WHERE user_id=?")
      .bind(owner.name)
      .first<number>("n");
    if (remaining === null) throw new Error("Missing bounded cleanup count");
    expect(previous - remaining).toBeLessThanOrEqual(100);
    previous = remaining;
    if (result.status === "completed") {
      completed = true;
      break;
    }
  }
  expect(completed).toBe(true);
  expect(previous).toBe(0);
  expect(
    await db
      .prepare('SELECT id FROM "user" WHERE id=?')
      .bind(owner.name)
      .first(),
  ).toBeNull();
});
it.each(["needs_review", "different-evidence"])(
  "LIFECYCLE-05 %s sibling cannot become independent backing for cash",
  async (variant) => {
    const owner = await seed(`qa-life-unbacked-${variant}`);
    if (variant === "needs_review")
      await db
        .prepare(
          "UPDATE observations SET review_state='needs_review' WHERE user_id=? AND id=?",
        )
        .bind(owner.name, `o-${owner.name}-b`)
        .run();
    else {
      await db
        .prepare(
          "UPDATE observations SET structured_fields=NULL WHERE user_id=?",
        )
        .bind(owner.name)
        .run();
      await db
        .prepare(
          "UPDATE observations SET evidence_code='invoice-only' WHERE user_id=? AND id=?",
        )
        .bind(owner.name, `o-${owner.name}-b`)
        .run();
    }
    const repo = createLifecycleRepository(db),
      connection = `c-${owner.name}-a`;
    const preview = await repo.preview(owner.session.tenant, connection);
    expect(preview).toMatchObject({
      eventsRemoved: 1,
      eventsRetained: 0,
      purchasesRetained: 1,
    });
    await repo.deleteData(
      owner.session,
      connection,
      {
        confirmed: true,
        generation: 1,
        previewFingerprint: preview.fingerprint,
      },
      `qa-no-cash-${variant}`,
    );
    const cleanup = createLifecycleCleanup(db, null);
    for (let unit = 0; unit < 30; unit++)
      if ((await cleanup.runOne()).status === "completed") break;
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) n FROM ledger_entries WHERE user_id=? AND eligible=1",
        )
        .bind(owner.name)
        .first("n"),
    ).toBe(0);
  },
);
it("LIFECYCLE-03 unavailable deletion journal cannot starve another tenant's valid dispatch", async () => {
  const deleting = await seed("qa-life-starvation-a"),
    active = await seed("qa-life-starvation-b");
  await createLifecycleRepository(db).beginDeletion(
    deleting.session,
    { confirmed: true, version: 1 },
    {
      userId: deleting.name,
      deletedAt: Date.now(),
      requestId: "qa-starved-marker",
    },
  );
  const connection = `c-${active.name}-a`;
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES(?,?,?,?,1,'source-extract',?,'ready',0)",
    )
    .bind(
      "qa-active-dispatch",
      active.name,
      connection,
      `pc-${connection}`,
      "qa-active-dispatch",
    )
    .run();
  const sent: unknown[] = [];
  const queue: Queue<{ schemaVersion: 1; jobId: string }> = {
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
    send: async (message) => {
      sent.push(message);
      return { metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } } };
    },
    sendBatch: async (messages) => {
      sent.push(...messages);
      return { metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } } };
    },
  };
  const journal: Fetcher = {
    fetch: async () => new Response(null, { status: 503 }),
    connect() {
      throw new Error("No synthetic sockets");
    },
  };
  const meter = createInvocationDatabase(env.DB, 40);
  await worker.scheduled(
    { scheduledTime: Date.now(), cron: "*/5 * * * *", noRetry() {} },
    {
      ...bindings,
      DB: meter.db,
      JOBS_ENABLED: "true",
      JOBS_DISPATCH_LIMIT: "1",
      JOBS_SCHEDULE_LIMIT: "1",
      JOBS: queue,
      DELETION_JOURNAL: journal,
      DELETION_JOURNAL_SECRET: "synthetic-independent-journal-secret-12345",
    },
  );
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  expect(sent).toHaveLength(1);
  expect(
    await db
      .prepare("SELECT status FROM profiles WHERE user_id=?")
      .bind(deleting.name)
      .first("status"),
  ).toBe("deleting");
  expect(
    await db
      .prepare("SELECT journal_ack FROM lifecycle_deletions WHERE user_id=?")
      .bind(deleting.name)
      .first("journal_ack"),
  ).toBe(0);
});
