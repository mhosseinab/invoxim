import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
  AcceptedImportInput,
  DiscoveryProviderPort,
  TenantContext,
} from "@invoxim/core";
import { DiscoveryError } from "@invoxim/core";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { createGmailDiscovery } from "../../../packages/adapters/src/discovery/gmail";
import { createGmailDiscoveryProviderFactory } from "../../../packages/adapters/src/discovery/provider-factory";
import { createDiscoveryService } from "../../../packages/adapters/src/discovery/service";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import {
  GMAIL_AUTHORIZATION_SCOPES,
  type GmailConfiguration,
} from "../../../packages/adapters/src/mailbox/configuration";
import {
  createCredentialCipher,
  encodeBase64url,
} from "../../../packages/adapters/src/security/cipher";
import { planDiscoveryRange } from "../../../packages/core/src/discovery/calendar";
import { createInvocationDatabase } from "../src/invocation-database";
import { createJobRuntime } from "../src/job-runtime";

const db = env.DB;

it.each([
  [
    "spring DST",
    "2026-03-30T12:00:00+02:00",
    "2025-03-30T12:00:00+02:00",
    "2026-02-28T12:00:00+01:00",
  ],
  [
    "leap month-end",
    "2024-02-29T12:00:00+01:00",
    "2023-02-28T12:00:00+01:00",
    "2024-01-30T12:00:00+01:00",
  ],
  [
    "skipped recent wall time",
    "2026-04-28T02:30:00+02:00",
    "2025-04-28T02:30:00+02:00",
    "2026-03-29T03:30:00+02:00",
  ],
  [
    "repeated recent wall time",
    "2026-11-24T02:30:00+01:00",
    "2025-11-24T02:30:00+01:00",
    "2026-10-25T02:30:00+02:00",
  ],
] as const)(
  "RECENT-01 exact calendar slices preserve approved interval across %s",
  (_name, cutoff, start, recent) => {
    const plan = planDiscoveryRange({
      cutoffMs: Date.parse(cutoff),
      timezone: "Europe/Vienna",
    });
    expect(plan.range).toEqual({
      startMs: Date.parse(start),
      cutoffMs: Date.parse(cutoff),
      timezone: "Europe/Vienna",
    });
    expect(plan.recent).toEqual({ ...plan.range, startMs: Date.parse(recent) });
    expect(plan.older).toEqual({ ...plan.range, cutoffMs: Date.parse(recent) });
    expect(plan.older?.cutoffMs).toBe(plan.recent.startMs);
    expect(plan.recent.cutoffMs).toBe(plan.range.cutoffMs);
  },
);
it("RECENT-02 a shorter explicitly approved interval has no older slice or expanded range", () => {
  const startMs = Date.parse("2026-03-25T13:00:00Z"),
    cutoffMs = Date.parse("2026-04-01T13:00:00Z");
  const plan = planDiscoveryRange({
    startMs,
    cutoffMs,
    timezone: "Europe/Vienna",
  });
  expect(plan.range).toEqual({ startMs, cutoffMs, timezone: "Europe/Vienna" });
  expect(plan.recent).toEqual(plan.range);
  expect(plan.older).toBeNull();
});
it.each(["invalid-zone", "Europe/Vienna"])(
  "untrusted invalid calendar inputs fail closed (%s)",
  (timezone) => {
    expect(() =>
      planDiscoveryRange({
        cutoffMs: Date.parse("2026-04-01T13:00:00Z"),
        startMs: Date.parse("2026-04-01T13:00:00Z"),
        timezone,
      }),
    ).toThrow("INVALID_RANGE");
  },
);

afterEach(() => vi.restoreAllMocks());
function providerResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
) {
  const requests: URL[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== "https://gmail.googleapis.com" ||
      !url.pathname.startsWith("/gmail/v1/users/me/")
    )
      throw new Error("Unexpected synthetic discovery destination");
    requests.push(url);
    return Response.json(body, { status, headers });
  });
  return requests;
}
it("GMAIL-07 a provider-deleted source yields unavailable metadata instead of transient retry", async () => {
  providerResponse(
    { error: { code: 404, message: "synthetic source removed" } },
    404,
  );
  await expect(
    createGmailDiscovery("synthetic-token").metadata(
      "gone-source",
      "filtered",
      new AbortController().signal,
    ),
  ).resolves.toMatchObject({ id: "gone-source", available: false });
});
it("GMAIL-02 opaque history cursors preserve large values and collapse overlapping change references", async () => {
  const cursor = "900719925474099312345678901234567890";
  const requests = providerResponse({
    historyId: "900719925474099312345678901234567891",
    history: [
      {
        messages: [{ id: "overlap" }],
        messagesAdded: [
          { message: { id: "overlap" } },
          { message: { id: "new-source" } },
        ],
        labelsAdded: [{ message: { id: "new-source" } }],
        messagesDeleted: [{ message: { id: "deleted-source" } }],
      },
    ],
  });
  const page = await createGmailDiscovery("synthetic-token").history({
    historyId: cursor,
    signal: new AbortController().signal,
  });
  expect(requests[0]?.searchParams.get("startHistoryId")).toBe(cursor);
  expect(page.historyId).toBe("900719925474099312345678901234567891");
  expect(page.ids.sort()).toEqual(["new-source", "overlap"]);
  expect(page.deletedIds).toEqual(["deleted-source"]);
});
it("GMAIL-03 expired provider history reports bounded recovery reason", async () => {
  providerResponse(
    { error: { code: 404, message: "synthetic expired history" } },
    404,
  );
  await expect(
    createGmailDiscovery("synthetic-token").history({
      historyId: "123456",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({
    code: "HISTORY_EXPIRED",
    message: "HISTORY_EXPIRED",
  });
});
it("GMAIL-05 Retry-After is preserved as a bounded delay without leaking provider body", async () => {
  providerResponse(
    { error: { message: "synthetic-sensitive-rate-detail" } },
    429,
    { "Retry-After": "120" },
  );
  await expect(
    createGmailDiscovery("synthetic-token").list({
      range: {
        startMs: Date.parse("2026-09-01T00:00:00Z"),
        cutoffMs: Date.parse("2026-10-01T00:00:00Z"),
        timezone: "UTC",
      },
      queryMode: "filtered",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({
    code: "RATE_LIMITED",
    message: "RATE_LIMITED",
    retryAfterMs: 120000,
  });
});
it("GMAIL-08 metadata-only selection retains unknown-language candidates without returning private headers", async () => {
  const requests = providerResponse({
    id: "unknown-source",
    internalDate: "1790812800000",
    labelIds: ["ARCHIVED_CUSTOM"],
    payload: {
      headers: [
        { name: "Subject", value: "synthetic-private-unknown-language" },
        { name: "From", value: "synthetic-private-sender@example.invalid" },
      ],
      body: { data: "synthetic-private-body" },
    },
  });
  const metadata = await createGmailDiscovery("synthetic-token").metadata(
    "unknown-source",
    "filtered",
    new AbortController().signal,
  );
  expect(metadata).toMatchObject({
    id: "unknown-source",
    available: true,
    excluded: false,
    candidate: "unknown",
  });
  expect(JSON.stringify(metadata)).not.toContain("synthetic-private");
  expect(requests[0]?.searchParams.get("format")).toBe("metadata");
  expect(requests[0]?.searchParams.get("fields")).not.toMatch(
    /body|snippet|raw/,
  );
  expect(requests[0]?.searchParams.getAll("metadataHeaders")).toEqual([
    "Subject",
    "From",
  ]);
});
it("GMAIL-08 filtered discovery includes archive and labels without Inbox-only restriction", async () => {
  const requests = providerResponse({
    messages: [{ id: "archived-source" }, { id: "custom-label-source" }],
    nextPageToken: "synthetic-next",
  });
  const page = await createGmailDiscovery("synthetic-token").list({
    range: { startMs: 10000, cutoffMs: 20000, timezone: "UTC" },
    queryMode: "filtered",
    signal: new AbortController().signal,
  });
  expect(page.ids).toEqual(["archived-source", "custom-label-source"]);
  expect(page.nextPageToken).toBe("synthetic-next");
  expect(requests[0]?.searchParams.get("includeSpamTrash")).toBe("false");
  expect(requests[0]?.searchParams.has("labelIds")).toBe(false);
  expect(requests[0]?.searchParams.get("q")).toContain("after:9 before:21");
  expect(requests[0]?.searchParams.get("q")).toContain("rechnung");
});

const now = Date.parse("2026-10-12T12:00:00Z");
beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
});
async function owner(name: string) {
  const tenant = { userId: name, authority: "session" } as TenantContext;
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
    )
    .bind(name, name, `${name}@example.invalid`)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,timezone,created_at,updated_at) VALUES(?,'UTC',0,0)",
    )
    .bind(name)
    .run();
  const cipher = createCredentialCipher({
    activeVersion: 1,
    keys: { 1: encodeBase64url(new Uint8Array(32).fill(7)) },
  });
  const sealed = await cipher.seal(
    tenant,
    { entityId: `conn-${name}`, purpose: "mailbox-credentials" },
    {
      accessToken: "synthetic-discovery-access",
      refreshToken: "synthetic-discovery-refresh",
      expiresAt: now + 3600000,
    },
  );
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes,credential_ciphertext,credential_key_version,credential_version) VALUES(?,?,'mailbox','gmail',?,?,?,?,1,1)",
    )
    .bind(
      `conn-${name}`,
      name,
      `subject-${name}`,
      `${name}-mail@example.invalid`,
      JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
      sealed,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES(?,?,?,1,'synthetic-approved','synthetic-local',1,0,1)",
    )
    .bind(`consent-${name}`, name, `conn-${name}`)
    .run();
  return tenant;
}
function accepted(
  tenant: TenantContext,
  extra: Partial<AcceptedImportInput> = {},
): AcceptedImportInput {
  return {
    connectionId: `conn-${tenant.userId}`,
    generation: 1,
    consentId: `consent-${tenant.userId}`,
    fingerprint: `request-${tenant.userId}`,
    cutoffMs: Date.parse("2026-10-01T00:00:00Z"),
    timezone: "UTC",
    queryMode: "filtered",
    ...extra,
  };
}
function pageProvider(
  anchor: () => Promise<string> = async () => "900719925474099312345",
): DiscoveryProviderPort {
  return {
    anchor,
    async list() {
      return { ids: [] };
    },
    async metadata(id) {
      return {
        id,
        receivedAtMs: 0,
        available: true,
        excluded: false,
        candidate: "unknown",
      };
    },
    async history() {
      return { ids: [], historyId: "900719925474099312346" };
    },
  };
}
function service(provider = pageProvider(), readiness = true, headroom = 40) {
  return createDiscoveryService(db, {
    providers: {
      async open() {
        return provider;
      },
    },
    readiness: {
      async allow() {
        return readiness;
      },
    },
    remainingStatements: () => headroom,
    clock: () => now,
  });
}
it("GMAIL-01/RECENT-06 accepted import freezes full slices and independent live anchor without claiming completion", async () => {
  const tenant = await owner("import-positive");
  const request = accepted(tenant);
  const first = await service().beginAcceptedImport(tenant, request);
  const replay = await service().beginAcceptedImport(tenant, request);
  expect(replay.importRunId).toBe(first.importRunId);
  const run = await db
    .prepare(
      "SELECT stage,frozen_start,frozen_cutoff FROM import_runs WHERE user_id=? AND id=?",
    )
    .bind(tenant.userId, first.importRunId)
    .first();
  expect(run).toMatchObject({
    stage: "discovering_recent",
    frozen_start: "2025-10-01T00:00:00.000Z",
    frozen_cutoff: "2026-10-01T00:00:00.000Z",
  });
  const slices = (
    await db
      .prepare(
        "SELECT slice_key,stage,frozen_start,frozen_cutoff,history_cursor FROM sync_states WHERE user_id=? ORDER BY slice_key",
      )
      .bind(tenant.userId)
      .all()
  ).results;
  expect(slices).toContainEqual(
    expect.objectContaining({
      slice_key: "recent",
      stage: "queued",
      frozen_start: "2026-09-01T00:00:00.000Z",
      frozen_cutoff: "2026-10-01T00:00:00.000Z",
    }),
  );
  expect(slices).toContainEqual(
    expect.objectContaining({
      slice_key: "older",
      stage: "waiting_recent",
      frozen_start: "2025-10-01T00:00:00.000Z",
      frozen_cutoff: "2026-09-01T00:00:00.000Z",
    }),
  );
  expect(slices).toContainEqual(
    expect.objectContaining({
      slice_key: "live",
      history_cursor: "900719925474099312345",
    }),
  );
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE user_id=?")
      .bind(tenant.userId)
      .first("count"),
  ).toBe(1);
});
it("conflicting simultaneous range requests cannot both succeed under one idempotency fingerprint", async () => {
  const tenant = await owner("import-conflict");
  const results = await Promise.allSettled([
    service().beginAcceptedImport(tenant, accepted(tenant)),
    service().beginAcceptedImport(
      tenant,
      accepted(tenant, { startMs: Date.parse("2026-06-01T00:00:00Z") }),
    ),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const failures = results.filter((result) => result.status === "rejected");
  expect(failures).toHaveLength(1);
  if (failures[0]?.status !== "rejected")
    throw new Error("Missing conflicting request rejection");
  expect(failures[0].reason).toMatchObject({ code: "CONFLICT" });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM import_runs WHERE user_id=?")
      .bind(tenant.userId)
      .first("count"),
  ).toBe(1);
});
it("consent revoked during anchor lookup cannot activate scheduling or commit a run", async () => {
  const tenant = await owner("import-revoked");
  const provider = pageProvider(async () => {
    await db
      .prepare("UPDATE processing_consents SET revoked_at=? WHERE user_id=?")
      .bind(now, tenant.userId)
      .run();
    return "900719925474099312345";
  });
  await expect(
    service(provider).beginAcceptedImport(tenant, accepted(tenant)),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM import_runs WHERE user_id=?")
      .bind(tenant.userId)
      .first("count"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT scheduling_state FROM connections WHERE user_id=?")
      .bind(tenant.userId)
      .first("scheduling_state"),
  ).toBe("awaiting_import");
});
it("profile timezone changed during anchor lookup cannot commit a stale calendar range", async () => {
  const tenant = await owner("import-timezone");
  const provider = pageProvider(async () => {
    await db
      .prepare("UPDATE profiles SET timezone='Europe/Vienna' WHERE user_id=?")
      .bind(tenant.userId)
      .run();
    return "900719925474099312345";
  });
  await expect(
    service(provider).beginAcceptedImport(tenant, accepted(tenant)),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM import_runs WHERE user_id=?")
      .bind(tenant.userId)
      .first("count"),
  ).toBe(0);
});
it("unready processing or insufficient statement headroom performs no provider request or durable import", async () => {
  const tenant = await owner("import-unready");
  let opened = false;
  const provider = pageProvider(async () => {
    opened = true;
    return "123456";
  });
  await expect(
    service(provider, false).beginAcceptedImport(tenant, accepted(tenant)),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    service(provider, true, 0).beginAcceptedImport(tenant, accepted(tenant)),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(opened).toBe(false);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE user_id=?")
      .bind(tenant.userId)
      .first("count"),
  ).toBe(0);
});
it("future-dated processing consent cannot authorize anchor access or durable work", async () => {
  const tenant = await owner("import-future-consent");
  await db
    .prepare("UPDATE processing_consents SET accepted_at=? WHERE user_id=?")
    .bind(now + 1, tenant.userId)
    .run();
  let anchored = false;
  await expect(
    service(
      pageProvider(async () => {
        anchored = true;
        return "123456";
      }),
    ).beginAcceptedImport(tenant, accepted(tenant)),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(anchored).toBe(false);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM import_runs WHERE user_id=?")
      .bind(tenant.userId)
      .first("count"),
  ).toBe(0);
});
it("GMAIL-05 a two-hour numeric Retry-After floor is never shortened to one hour", async () => {
  providerResponse({ error: { message: "synthetic rate limit" } }, 429, {
    "Retry-After": "7200",
  });
  await expect(
    createGmailDiscovery("synthetic-token").list({
      range: { startMs: 10000, cutoffMs: 20000, timezone: "UTC" },
      queryMode: "filtered",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 7200000 });
});
it("GMAIL-05 a two-hour HTTP-date Retry-After floor is never shortened to one hour", async () => {
  const retryDate = new Date(Date.now() + 7200000).toUTCString();
  providerResponse({ error: { message: "synthetic rate limit" } }, 429, {
    "Retry-After": retryDate,
  });
  try {
    await createGmailDiscovery("synthetic-token").list({
      range: { startMs: 10000, cutoffMs: 20000, timezone: "UTC" },
      queryMode: "filtered",
      signal: new AbortController().signal,
    });
    throw new Error("Expected provider rate limit");
  } catch (cause) {
    expect(cause).toMatchObject({ code: "RATE_LIMITED" });
    if (!(cause instanceof Error) || !("retryAfterMs" in cause))
      throw new Error("Missing retry floor");
    expect(cause.retryAfterMs).toBeGreaterThanOrEqual(7199000);
  }
});

const discoveryCipher = createCredentialCipher({
  activeVersion: 1,
  keys: { 1: encodeBase64url(new Uint8Array(32).fill(7)) },
});
const factoryConfiguration: GmailConfiguration = {
  provider: "gmail",
  oauthProvider: "google",
  scopes: GMAIL_AUTHORIZATION_SCOPES,
  login: {
    origin: "https://synthetic.example",
    secret: "synthetic-discovery-login-secret-never-production",
    googleClientId: "synthetic-login-client",
    googleClientSecret: "synthetic-login-secret",
    allowedEmails: ["synthetic-discovery-login@example.invalid"],
  },
  clientId: "synthetic-mail-client",
  clientSecret: "synthetic-mail-client-secret",
  limit: 3,
  callback: "https://synthetic.example/api/oauth/mailbox/gmail/callback",
  cipher: discoveryCipher,
};
function afterSecondCredentialRead(action: () => Promise<void>): D1Database {
  let reads = 0;
  function wrap(
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (key === "first")
          return async (column?: string) => {
            const result =
              column === undefined
                ? await target.first()
                : await target.first(column);
            if (
              sql.startsWith("SELECT credential_ciphertext AS") &&
              ++reads === 2
            )
              await action();
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const observed = createInvocationDatabase(env.DB, 40).db;
  return new Proxy(observed, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
async function expiredCredential(
  tenant: TenantContext,
  generation = 1,
  version = 1,
) {
  const ciphertext = await discoveryCipher.seal(
    tenant,
    { entityId: `conn-${tenant.userId}`, purpose: "mailbox-credentials" },
    {
      accessToken: "synthetic-expired-access",
      refreshToken: `synthetic-refresh-generation-${generation}`,
      expiresAt: Date.now() - 1000,
    },
  );
  await db
    .prepare(
      "UPDATE connections SET generation=?,credential_version=?,credential_ciphertext=?,credential_key_version=1 WHERE user_id=?",
    )
    .bind(generation, version, ciphertext, tenant.userId)
    .run();
  return ciphertext;
}
function refreshTransport(tenant: TenantContext) {
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    if (url === "https://oauth2.googleapis.com/token")
      return Response.json({
        access_token: "synthetic-refreshed-access",
        expires_in: 3600,
        token_type: "Bearer",
      });
    if (url === "https://openidconnect.googleapis.com/v1/userinfo")
      return Response.json({
        sub: `subject-${tenant.userId}`,
        email: `${tenant.userId}-mail@example.invalid`,
        email_verified: true,
      });
    throw new Error("Unexpected synthetic refresh endpoint");
  });
  return requests;
}
it("factory abort during completed vault read prevents starting refresh HTTP", async () => {
  const tenant = await owner("factory-abort");
  await expiredCredential(tenant);
  const controller = new AbortController();
  const requests = refreshTransport(tenant);
  const delayed = afterSecondCredentialRead(async () => {
    controller.abort();
  });
  await expect(
    createGmailDiscoveryProviderFactory(delayed, factoryConfiguration).open(
      tenant,
      { connectionId: `conn-${tenant.userId}`, generation: 1 },
      controller.signal,
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(requests).toEqual([]);
  expect(
    await db
      .prepare("SELECT credential_version FROM connections WHERE user_id=?")
      .bind(tenant.userId)
      .first("credential_version"),
  ).toBe(1);
});
it("factory old-generation snapshot cannot refresh or mutate a reconnected newer generation", async () => {
  const tenant = await owner("factory-generation");
  await expiredCredential(tenant);
  const requests = refreshTransport(tenant);
  let replacement = "";
  const delayed = afterSecondCredentialRead(async () => {
    replacement = await expiredCredential(tenant, 2, 2);
  });
  await expect(
    createGmailDiscoveryProviderFactory(delayed, factoryConfiguration).open(
      tenant,
      { connectionId: `conn-${tenant.userId}`, generation: 1 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  expect(requests).toEqual([]);
  expect(
    await db
      .prepare(
        "SELECT generation,credential_version,credential_ciphertext FROM connections WHERE user_id=?",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual({
    generation: 2,
    credential_version: 2,
    credential_ciphertext: replacement,
  });
});

const jobPolicy = {
  dispatchLimit: 50,
  scheduleLimit: 50,
  tenantConcurrency: 2,
  globalConcurrency: 20,
  maxAttempts: 3,
  leaseMs: 300000,
  redeliveryMs: 60000,
  queryLimit: 40,
};
async function pageTurn(
  tenant: TenantContext,
  provider: DiscoveryProviderPort,
  options: { database?: D1Database; at?: number; slice?: string } = {},
) {
  const at = options.at ?? now;
  const slice = options.slice ?? "recent";
  const ready = await db
    .prepare(
      "SELECT j.id FROM jobs j JOIN sync_states s ON s.user_id=j.user_id AND s.id=j.sync_state_id WHERE j.user_id=? AND s.slice_key=? AND j.status IN ('ready','retry_wait') AND j.dispatch_at<=? ORDER BY j.dispatch_at,j.id LIMIT 1",
    )
    .bind(tenant.userId, slice, at)
    .first<{ id: string }>();
  if (!ready) throw new Error("No runnable synthetic discovery job");
  const invocation = createInvocationDatabase(options.database ?? env.DB, 40);
  const store = createJobStore(invocation.db, {
    policy: jobPolicy,
    clock: () => at,
  });
  const lease = await store.claim(ready.id);
  if (!lease) throw new Error("Synthetic discovery lease unavailable");
  const pages = createDiscoveryService(invocation.db, {
    providers: {
      async open() {
        return provider;
      },
    },
    readiness: {
      async allow() {
        return true;
      },
    },
    remainingStatements: invocation.remainingStatements,
    clock: () => at,
  });
  const outcome = await pages.runPage(lease, {
    signal: new AbortController().signal,
    checkpoint: () => store.checkpoint(lease),
  });
  return { outcome, invocation, store, lease };
}
async function liveJob(tenant: TenantContext, id: string) {
  const state = await db
    .prepare("SELECT id FROM sync_states WHERE user_id=? AND slice_key='live'")
    .bind(tenant.userId)
    .first<{ id: string }>();
  if (!state) throw new Error("Missing live state");
  expect(
    await createJobStore(db, {
      policy: jobPolicy,
      clock: () => now,
    }).enqueue(tenant, {
      id,
      connectionId: `conn-${tenant.userId}`,
      consentId: `consent-${tenant.userId}`,
      generation: 1,
      syncStateId: state.id,
      type: "sync",
      dedupeKey: id,
      priority: 0,
    }),
  ).toBe(true);
  return state.id;
}
it("RECENT-03/04 bounded page buffers retain exact range checks and publish the provider cursor only after staging", async () => {
  const tenant = await owner("page-buffer");
  const run = await service().beginAcceptedImport(tenant, accepted(tenant));
  let lists = 0;
  const provider = pageProvider();
  provider.list = async () => {
    lists++;
    return lists === 1
      ? {
          ids: ["recent-a", "cutoff-excluded", "recent-b", "older-excluded"],
          nextPageToken: "opaque-next-page",
        }
      : { ids: ["recent-a"] };
  };
  provider.metadata = async (id) => ({
    id,
    available: true,
    excluded: false,
    candidate: "matched",
    receivedAtMs:
      id === "recent-a"
        ? Date.parse("2026-09-01T00:00:00Z")
        : id === "recent-b"
          ? Date.parse("2026-09-30T23:59:59.999Z")
          : id === "cutoff-excluded"
            ? Date.parse("2026-10-01T00:00:00Z")
            : Date.parse("2026-08-31T23:59:59.999Z"),
  });
  const first = await pageTurn(tenant, provider);
  expect(first.outcome).toEqual({ kind: "completed" });
  expect(first.invocation.executedStatements()).toBeLessThanOrEqual(40);
  let state = await db
    .prepare(
      "SELECT page_token,pending_ids,pending_next_token FROM sync_states WHERE user_id=? AND slice_key='recent'",
    )
    .bind(tenant.userId)
    .first<{
      page_token: string | null;
      pending_ids: string | null;
      pending_next_token: string | null;
    }>();
  expect(state?.page_token).toBeNull();
  expect(state?.pending_next_token).toBe("opaque-next-page");
  expect(state?.pending_ids).not.toBeNull();
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM source_messages WHERE user_id=?")
      .bind(tenant.userId)
      .first("count"),
  ).toBe(2);
  const second = await pageTurn(tenant, provider);
  expect(second.outcome).toEqual({ kind: "completed" });
  expect(lists).toBe(1);
  state = await db
    .prepare(
      "SELECT page_token,pending_ids,pending_next_token FROM sync_states WHERE user_id=? AND slice_key='recent'",
    )
    .bind(tenant.userId)
    .first();
  expect(state).toMatchObject({
    page_token: "opaque-next-page",
    pending_ids: null,
  });
  expect((await pageTurn(tenant, provider)).outcome).toEqual({
    kind: "completed",
  });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE user_id=? AND type='source-extract'",
      )
      .bind(tenant.userId)
      .first("count"),
  ).toBe(2);
  const progress = await service().progress(tenant, run.importRunId);
  expect(progress.discoveryComplete).toBe(false);
  expect(progress.processingComplete).toBe(false);
  expect(progress.counts.processed).toBe(0);
});
it("RECENT-09 late D1 constraint failure rolls back source staging, outbox and cursor together", async () => {
  const tenant = await owner("page-rollback");
  await service().beginAcceptedImport(tenant, accepted(tenant));
  const provider = pageProvider();
  provider.list = async () => ({
    ids: ["rollback-source"],
    nextPageToken: "rollback-next",
  });
  provider.metadata = async (id) => ({
    id,
    receivedAtMs: Date.parse("2026-09-15T00:00:00Z"),
    available: true,
    excluded: false,
    candidate: "matched",
  });
  const failing = new Proxy(createInvocationDatabase(env.DB, 40).db, {
    get(target, key) {
      if (key === "batch")
        return (statements: D1PreparedStatement[]) =>
          target.batch([
            ...statements,
            target
              .prepare(
                "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
              )
              .bind(tenant.userId),
          ]);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = await pageTurn(tenant, provider, { database: failing });
  expect(result.outcome).toEqual({ kind: "retry", code: "transient" });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM source_messages WHERE user_id=?")
      .bind(tenant.userId)
      .first("count"),
  ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE user_id=? AND type='source-extract'",
      )
      .bind(tenant.userId)
      .first("count"),
  ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT discovery_version,page_token FROM sync_states WHERE user_id=? AND slice_key='recent'",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual({ discovery_version: 0, page_token: null });
  expect(await result.store.finish(result.lease, result.outcome)).toBe(true);
  expect(
    (await pageTurn(tenant, provider, { at: now + 1001 })).outcome,
  ).toEqual({ kind: "completed" });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM source_messages WHERE user_id=?")
      .bind(tenant.userId)
      .first("count"),
  ).toBe(1);
});
it("disconnect generation changed during metadata access cannot stage a source or advance cursor", async () => {
  const tenant = await owner("page-generation");
  await service().beginAcceptedImport(tenant, accepted(tenant));
  const provider = pageProvider();
  provider.list = async () => ({ ids: ["stale-source"] });
  provider.metadata = async (id) => {
    await db
      .prepare("UPDATE connections SET generation=generation+1 WHERE user_id=?")
      .bind(tenant.userId)
      .run();
    return {
      id,
      receivedAtMs: Date.parse("2026-09-15T00:00:00Z"),
      available: true,
      excluded: false,
      candidate: "matched",
    };
  };
  expect((await pageTurn(tenant, provider)).outcome).toEqual({
    kind: "paused",
    code: "auth",
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM source_messages WHERE user_id=?")
      .bind(tenant.userId)
      .first("count"),
  ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT discovery_version FROM sync_states WHERE user_id=? AND slice_key='recent'",
      )
      .bind(tenant.userId)
      .first("discovery_version"),
  ).toBe(0);
});
it("GMAIL-05 durable rate delay preserves page checkpoint while another tenant progresses", async () => {
  const delayed = await owner("page-rate");
  await service().beginAcceptedImport(delayed, accepted(delayed));
  const rate = pageProvider();
  rate.list = async () => {
    throw new DiscoveryError("RATE_LIMITED", 120000);
  };
  expect((await pageTurn(delayed, rate)).outcome).toEqual({
    kind: "completed",
  });
  expect(
    await db
      .prepare(
        "SELECT retry_at,page_token FROM sync_states WHERE user_id=? AND slice_key='recent'",
      )
      .bind(delayed.userId)
      .first(),
  ).toEqual({ retry_at: now + 120000, page_token: null });
  const continuation = await db
    .prepare(
      "SELECT dispatch_at FROM jobs WHERE user_id=? AND status='ready' AND type='discover'",
    )
    .bind(delayed.userId)
    .first<{ dispatch_at: number }>();
  expect(continuation?.dispatch_at).toBe(now + 120000);
  const other = await owner("page-other");
  await service().beginAcceptedImport(other, accepted(other));
  const provider = pageProvider();
  provider.list = async () => ({ ids: ["other-source"] });
  provider.metadata = async (id) => ({
    id,
    receivedAtMs: Date.parse("2026-09-15T00:00:00Z"),
    available: true,
    excluded: false,
    candidate: "unknown",
  });
  expect((await pageTurn(other, provider)).outcome).toEqual({
    kind: "completed",
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM source_messages WHERE user_id=?")
      .bind(other.userId)
      .first("count"),
  ).toBe(1);
});
it("GMAIL-03 expired history preserves its anchor until bounded approved-range recovery is durable", async () => {
  const tenant = await owner("page-recovery");
  await service().beginAcceptedImport(tenant, accepted(tenant));
  const live = await liveJob(tenant, "live-recovery");
  const provider = pageProvider(async () => "900719925474099399999");
  provider.history = async () => {
    throw new DiscoveryError("HISTORY_EXPIRED");
  };
  let recoveryRange: { startMs: number; cutoffMs: number } | undefined;
  provider.list = async (input) => {
    recoveryRange = input.range;
    expect(input.queryMode).toBe("filtered");
    return { ids: [] };
  };
  expect((await pageTurn(tenant, provider, { slice: "live" })).outcome).toEqual(
    { kind: "completed" },
  );
  expect(
    await db
      .prepare(
        "SELECT stage,coverage_code,history_cursor,recovery_anchor FROM sync_states WHERE user_id=? AND id=?",
      )
      .bind(tenant.userId, live)
      .first(),
  ).toEqual({
    stage: "recovering",
    coverage_code: "recovering_history",
    history_cursor: "900719925474099312345",
    recovery_anchor: "900719925474099399999",
  });
  expect((await pageTurn(tenant, provider, { slice: "live" })).outcome).toEqual(
    { kind: "completed" },
  );
  expect(recoveryRange).toMatchObject({
    startMs: Date.parse("2025-10-01T00:00:00Z"),
    cutoffMs: now,
  });
  expect(
    await db
      .prepare(
        "SELECT history_cursor,recovery_anchor,coverage_code FROM sync_states WHERE user_id=? AND id=?",
      )
      .bind(tenant.userId, live)
      .first(),
  ).toEqual({
    history_cursor: "900719925474099399999",
    recovery_anchor: null,
    coverage_code: "candidate_unknown",
  });
});
it("native consumption, expired-credential refresh and discovery make durable progress within one shared forty-statement invocation budget", async () => {
  const tenant = await owner("shared-factory-budget");
  await service().beginAcceptedImport(tenant, accepted(tenant));
  await expiredCredential(tenant);
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url.origin + url.pathname);
    if (url.href === "https://oauth2.googleapis.com/token")
      return Response.json({
        access_token: "synthetic-new-budget-access",
        expires_in: 3600,
        token_type: "Bearer",
      });
    if (url.href === "https://openidconnect.googleapis.com/v1/userinfo")
      return Response.json({
        sub: `subject-${tenant.userId}`,
        email: `${tenant.userId}-mail@example.invalid`,
        email_verified: true,
      });
    if (url.origin !== "https://gmail.googleapis.com")
      throw new Error("Unexpected synthetic budget destination");
    if (url.pathname === "/gmail/v1/users/me/messages")
      return Response.json({
        messages: [{ id: "budget-receipt-a" }, { id: "budget-receipt-b" }],
      });
    if (url.pathname.startsWith("/gmail/v1/users/me/messages/")) {
      expect(url.searchParams.get("format")).toBe("metadata");
      const id = url.pathname.split("/").at(-1);
      return Response.json({
        id,
        internalDate: String(Date.parse("2026-09-15T00:00:00Z")),
        labelIds: ["ARCHIVED"],
        payload: { headers: [{ name: "Subject", value: "Synthetic receipt" }] },
      });
    }
    throw new Error("Unexpected synthetic Gmail budget endpoint");
  });
  const ready = await db
    .prepare(
      "SELECT id FROM jobs WHERE user_id=? AND type='discover' AND status='ready'",
    )
    .bind(tenant.userId)
    .first<{ id: string }>();
  if (!ready) throw new Error("Missing budget job");
  const at = Date.now();
  const invocation = createInvocationDatabase(env.DB, 40);
  const store = createJobStore(invocation.db, {
    policy: jobPolicy,
    clock: () => at,
  });
  const pages = createDiscoveryService(invocation.db, {
    providers: createGmailDiscoveryProviderFactory(
      invocation.db,
      factoryConfiguration,
    ),
    readiness: {
      async allow() {
        return true;
      },
    },
    remainingStatements: invocation.remainingStatements,
    clock: () => at,
  });
  const runtime = createJobRuntime({
    store,
    clock: () => at,
    queue: {
      async send() {
        throw new Error("Unexpected native consumption dispatch");
      },
    },
    handler: { run: (lease, control) => pages.runPage(lease, control) },
  });
  const batch = createMessageBatch("synthetic-native-budget", [
    {
      id: "budget-native-message",
      timestamp: new Date(),
      attempts: 1,
      body: { schemaVersion: 1, jobId: ready.id },
    },
  ]);
  await runtime.queue(batch);
  const nativeResult = await getQueueResult(batch, createExecutionContext());
  console.info(
    JSON.stringify({
      budgetStatements: invocation.executedStatements(),
      nativeResult,
      requests,
    }),
  );
  expect(invocation.executedStatements()).toBeLessThanOrEqual(40);
  expect(nativeResult.explicitAcks).toEqual(["budget-native-message"]);
  expect(nativeResult.retryMessages).toEqual([]);
  expect(requests).toContain("https://oauth2.googleapis.com/token");
  expect(requests).toContain(
    "https://openidconnect.googleapis.com/v1/userinfo",
  );
  const staged = await db
    .prepare("SELECT COUNT(*) AS count FROM source_messages WHERE user_id=?")
    .bind(tenant.userId)
    .first<number>("count");
  if (staged === null) throw new Error("Missing staged count");
  expect(staged).toBeGreaterThanOrEqual(1);
  expect(staged).toBeLessThanOrEqual(2);
  expect(
    await db
      .prepare("SELECT status FROM jobs WHERE id=?")
      .bind(ready.id)
      .first("status"),
  ).toBe("completed");
  expect(
    await db
      .prepare(
        "SELECT discovery_version FROM sync_states WHERE user_id=? AND slice_key='recent'",
      )
      .bind(tenant.userId)
      .first("discovery_version"),
  ).toBe(1);
  if (staged === 1) {
    expect(
      await db
        .prepare(
          "SELECT pending_ids FROM sync_states WHERE user_id=? AND slice_key='recent'",
        )
        .bind(tenant.userId)
        .first("pending_ids"),
    ).toBe(JSON.stringify(["budget-receipt-b"]));
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM jobs WHERE user_id=? AND type='discover' AND status='ready'",
        )
        .bind(tenant.userId)
        .first("count"),
    ).toBe(1);
  }
  console.info(
    `QA_SHARED_INVOCATION_STATEMENTS=${invocation.executedStatements()}`,
  );
});

it("RECENT-09 committed discovery survives missing ACK and native duplicate delivery without repeating provider work", async () => {
  const tenant = await owner("commit-before-ack");
  await service().beginAcceptedImport(tenant, accepted(tenant));
  const provider = pageProvider();
  provider.list = async () => ({ ids: ["durable-receipt"] });
  provider.metadata = async (id) => ({
    id,
    available: true,
    excluded: false,
    candidate: "matched",
    receivedAtMs: Date.parse("2026-09-15T00:00:00Z"),
  });
  // Direct execution commits the page without any queue ACK transport: crash boundary.
  const committed = await pageTurn(tenant, provider);
  expect(committed.outcome).toEqual({ kind: "completed" });
  const invocation = createInvocationDatabase(env.DB, 40);
  const store = createJobStore(invocation.db, {
    policy: jobPolicy,
    clock: () => now,
  });
  let replayHandlerReached = false;
  const replay = createJobRuntime({
    store,
    clock: () => now,
    queue: {
      async send() {
        throw new Error("Unexpected duplicate dispatch");
      },
    },
    handler: {
      async run() {
        replayHandlerReached = true;
        throw new Error("Duplicate completed job must not invoke provider");
      },
    },
  });
  const batch = createMessageBatch("synthetic-discovery", [
    {
      id: "duplicate-after-crash",
      timestamp: new Date(),
      attempts: 2,
      body: { schemaVersion: 1, jobId: committed.lease.jobId },
    },
  ]);
  await replay.queue(batch);
  const result = await getQueueResult(batch, createExecutionContext());
  expect(result.explicitAcks).toEqual(["duplicate-after-crash"]);
  expect(replayHandlerReached).toBe(false);
  expect(result.retryMessages).toEqual([]);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM source_messages WHERE user_id=?")
      .bind(tenant.userId)
      .first("count"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE user_id=? AND type='source-extract'",
      )
      .bind(tenant.userId)
      .first("count"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT discovery_version FROM sync_states WHERE user_id=? AND slice_key='recent'",
      )
      .bind(tenant.userId)
      .first("discovery_version"),
  ).toBe(1);
  expect(invocation.executedStatements()).toBeLessThanOrEqual(40);
});
it("GMAIL-07 deleted provider source retains accepted purchase and exact ledger facts", async () => {
  const tenant = await owner("deleted-accepted-source");
  await service().beginAcceptedImport(tenant, accepted(tenant));
  const provider = pageProvider();
  provider.list = async () => ({ ids: ["accepted-original"] });
  provider.metadata = async (id) => ({
    id,
    available: true,
    excluded: false,
    candidate: "matched",
    receivedAtMs: Date.parse("2026-09-15T00:00:00Z"),
  });
  expect((await pageTurn(tenant, provider)).outcome).toEqual({
    kind: "completed",
  });
  const source = await db
    .prepare(
      "SELECT id FROM source_messages WHERE user_id=? AND provider_message_id='accepted-original'",
    )
    .bind(tenant.userId)
    .first<{ id: string }>();
  if (!source) throw new Error("Missing synthetic accepted source");
  await db.batch([
    db
      .prepare(
        "UPDATE source_messages SET processing_status='processed' WHERE user_id=? AND id=?",
      )
      .bind(tenant.userId, source.id),
    db
      .prepare(
        "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length,parse_state) VALUES('retained-document',?,?,'0',?,'text/plain',10,'extracted')",
      )
      .bind(tenant.userId, source.id, "a".repeat(64)),
    db
      .prepare(
        "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('retained-observation',?,'retained-document',0,'retained-proof',1,'explicitly-paid',?,'accepted')",
      )
      .bind(
        tenant.userId,
        JSON.stringify({
          schemaVersion: 1,
          merchant: "Synthetic accepted merchant",
          date: "2026-09-15",
          totalMinor: "12345",
          currency: "EUR",
        }),
      ),
    db
      .prepare(
        "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('retained-purchase',?,'Synthetic accepted merchant','Synthetic accepted merchant','2026-09-15',12345,'EUR','paid')",
      )
      .bind(tenant.userId),
    db
      .prepare(
        "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,'retained-purchase','retained-observation','primary')",
      )
      .bind(tenant.userId),
    db
      .prepare(
        "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES('retained-payment',?,'retained-purchase','retained-observation','retained-business-payment','payment',12345,'EUR','2026-09-15','document',1)",
      )
      .bind(tenant.userId),
  ]);
  await liveJob(tenant, "deleted-source-live");
  provider.history = async () => ({
    ids: [],
    deletedIds: ["accepted-original"],
    historyId: "90000000000000009999",
  });
  expect((await pageTurn(tenant, provider, { slice: "live" })).outcome).toEqual(
    { kind: "completed" },
  );
  expect(
    await db
      .prepare(
        "SELECT available,processing_status FROM source_messages WHERE user_id=? AND id=?",
      )
      .bind(tenant.userId, source.id)
      .first(),
  ).toEqual({ available: 0, processing_status: "processed" });
  expect(
    await db
      .prepare(
        "SELECT CAST(total_minor AS TEXT) AS total,currency,payment_state FROM purchases WHERE user_id=?",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual({ total: "12345", currency: "EUR", payment_state: "paid" });
  expect(
    await db
      .prepare(
        "SELECT CAST(amount_minor AS TEXT) AS amount,currency,eligible FROM ledger_entries WHERE user_id=?",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual({ amount: "12345", currency: "EUR", eligible: 1 });
});
it("GMAIL-02 new mail during backfill uses the initial independent live anchor and deduplicates overlapping message IDs", async () => {
  const tenant = await owner("new-mail-during-backfill");
  const anchor = "90000000000000000001";
  await service(pageProvider(async () => anchor)).beginAcceptedImport(
    tenant,
    accepted(tenant),
  );
  const provider = pageProvider(async () => anchor);
  provider.list = async () => ({ ids: ["existing-backfill-source"] });
  provider.metadata = async (id) => ({
    id,
    available: true,
    excluded: false,
    candidate: "unknown",
    receivedAtMs:
      id === "arrived-after-cutoff"
        ? Date.parse("2026-10-02T00:00:00Z")
        : Date.parse("2026-09-15T00:00:00Z"),
  });
  expect((await pageTurn(tenant, provider)).outcome).toEqual({
    kind: "completed",
  });
  await liveJob(tenant, "live-during-older-backfill");
  provider.history = async (input) => {
    expect(input.historyId).toBe(anchor);
    return {
      ids: ["existing-backfill-source", "arrived-after-cutoff"],
      historyId: "90000000000000000002",
    };
  };
  expect((await pageTurn(tenant, provider, { slice: "live" })).outcome).toEqual(
    { kind: "completed" },
  );
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM source_messages WHERE user_id=?")
      .bind(tenant.userId)
      .first("count"),
  ).toBe(2);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE user_id=? AND type='source-extract'",
      )
      .bind(tenant.userId)
      .first("count"),
  ).toBe(2);
  expect(
    await db
      .prepare(
        "SELECT history_cursor,pending_ids FROM sync_states WHERE user_id=? AND slice_key='live'",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual({ history_cursor: "90000000000000000002", pending_ids: null });
  expect(
    await db
      .prepare(
        "SELECT stage FROM sync_states WHERE user_id=? AND slice_key='older'",
      )
      .bind(tenant.userId)
      .first("stage"),
  ).not.toBe("completed");
});
it("switching an existing live discovery query mode fails before provider access and preserves its checkpoint", async () => {
  const tenant = await owner("mode-transition");
  await service().beginAcceptedImport(tenant, accepted(tenant));
  await db
    .prepare(
      "UPDATE sync_states SET pending_ids=? WHERE user_id=? AND slice_key='live'",
    )
    .bind(JSON.stringify(["retained-live-reference"]), tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized,query_mode) VALUES(?,?,?,1,'synthetic-approved','synthetic-local',1,0,1,'broad')",
    )
    .bind("broad-consent", tenant.userId, `conn-${tenant.userId}`)
    .run();
  let anchorReached = false;
  const provider = pageProvider(async () => {
    anchorReached = true;
    return "900719925474099312399";
  });
  await expect(
    service(provider).beginAcceptedImport(
      tenant,
      accepted(tenant, {
        consentId: "broad-consent",
        fingerprint: "explicit-broad-request",
        queryMode: "broad",
      }),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(anchorReached).toBe(false);
  expect(
    await db
      .prepare(
        "SELECT query_mode,history_cursor,pending_ids FROM sync_states WHERE user_id=? AND slice_key='live'",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual({
    query_mode: "filtered",
    history_cursor: "900719925474099312345",
    pending_ids: JSON.stringify(["retained-live-reference"]),
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM import_runs WHERE user_id=?")
      .bind(tenant.userId)
      .first("count"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE user_id=? AND type='discover'",
      )
      .bind(tenant.userId)
      .first("count"),
  ).toBe(1);
  const sameMode = await service().beginAcceptedImport(
    tenant,
    accepted(tenant, { fingerprint: "new-same-mode-request" }),
  );
  expect(sameMode.importRunId).toEqual(expect.any(String));
  expect(
    await db
      .prepare(
        "SELECT query_mode,history_cursor,pending_ids FROM sync_states WHERE user_id=? AND slice_key='live'",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual({
    query_mode: "filtered",
    history_cursor: "900719925474099312345",
    pending_ids: JSON.stringify(["retained-live-reference"]),
  });
  const firstBroad = await owner("first-broad-mode");
  await db
    .prepare(
      "UPDATE processing_consents SET query_mode='broad' WHERE user_id=?",
    )
    .bind(firstBroad.userId)
    .run();
  const firstBroadRun = await service().beginAcceptedImport(
    firstBroad,
    accepted(firstBroad, { queryMode: "broad" }),
  );
  expect(firstBroadRun.importRunId).toEqual(expect.any(String));
  expect(
    await db
      .prepare(
        "SELECT query_mode FROM sync_states WHERE user_id=? AND slice_key='live'",
      )
      .bind(firstBroad.userId)
      .first("query_mode"),
  ).toBe("broad");
});
it("completed recovery bounds cannot expand a later narrower ordinary live import", async () => {
  const tenant = await owner("idle-recovery-range");
  await service().beginAcceptedImport(tenant, accepted(tenant));
  await db
    .prepare(
      "UPDATE import_runs SET started_at=started_at-1000 WHERE user_id=?",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "UPDATE sync_states SET stage='idle',frozen_start='2025-10-01T00:00:00.000Z',frozen_cutoff='2026-10-01T00:00:00.000Z' WHERE user_id=? AND slice_key='live'",
    )
    .bind(tenant.userId)
    .run();
  await service().beginAcceptedImport(
    tenant,
    accepted(tenant, {
      fingerprint: "approved-narrower-range",
      startMs: Date.parse("2026-09-20T00:00:00Z"),
    }),
  );
  await liveJob(tenant, "narrower-live-job");
  const provider = pageProvider();
  provider.history = async () => ({
    ids: ["outside-new-approved-start", "inside-new-approved-start"],
    historyId: "900719925474099312399",
  });
  provider.metadata = async (id) => ({
    id,
    available: true,
    excluded: false,
    candidate: "matched",
    receivedAtMs: Date.parse(
      id === "outside-new-approved-start"
        ? "2026-09-10T00:00:00Z"
        : "2026-09-25T00:00:00Z",
    ),
  });
  expect((await pageTurn(tenant, provider, { slice: "live" })).outcome).toEqual(
    { kind: "completed" },
  );
  expect(
    (
      await db
        .prepare(
          "SELECT provider_message_id FROM source_messages WHERE user_id=? ORDER BY provider_message_id",
        )
        .bind(tenant.userId)
        .all<{ provider_message_id: string }>()
    ).results,
  ).toEqual([{ provider_message_id: "inside-new-approved-start" }]);
});
it("active recovery rejects a new approved range before provider access and preserves pending recovery", async () => {
  const tenant = await owner("active-recovery-range");
  await service().beginAcceptedImport(tenant, accepted(tenant));
  await db
    .prepare(
      "UPDATE sync_states SET stage='recovering',frozen_start='2025-10-01T00:00:00.000Z',frozen_cutoff='2026-10-01T00:00:00.000Z',pending_ids=?,recovery_anchor='900719925474099312398' WHERE user_id=? AND slice_key='live'",
    )
    .bind(JSON.stringify(["pending-recovery-id"]), tenant.userId)
    .run();
  const before = await db
    .prepare(
      "SELECT stage,frozen_start,frozen_cutoff,pending_ids,history_cursor,recovery_anchor FROM sync_states WHERE user_id=? AND slice_key='live'",
    )
    .bind(tenant.userId)
    .first();
  let anchorReached = false;
  await expect(
    service(
      pageProvider(async () => {
        anchorReached = true;
        return "900719925474099312399";
      }),
    ).beginAcceptedImport(
      tenant,
      accepted(tenant, {
        fingerprint: "unsupported-recovery-range-change",
        startMs: Date.parse("2026-09-20T00:00:00Z"),
      }),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(anchorReached).toBe(false);
  expect(
    await db
      .prepare(
        "SELECT stage,frozen_start,frozen_cutoff,pending_ids,history_cursor,recovery_anchor FROM sync_states WHERE user_id=? AND slice_key='live'",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual(before);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM import_runs WHERE user_id=?")
      .bind(tenant.userId)
      .first("count"),
  ).toBe(1);
});
it.each(["recent", "live"] as const)(
  "repeated submitted %s page token cannot commit cursor progress or duplicate work",
  async (slice) => {
    const tenant = await owner(`repeated-page-${slice}`);
    await service().beginAcceptedImport(tenant, accepted(tenant));
    if (slice === "live") await liveJob(tenant, `loop-live-${slice}`);
    const provider = pageProvider();
    const response = (input: { pageToken?: string }) => ({
      ids: [input.pageToken ? "loop-new-source" : "loop-initial-source"],
      nextPageToken: "same-provider-token",
      historyId: "900719925474099312399",
    });
    provider.list = async (input) => response(input);
    provider.history = async (input) => response(input);
    provider.metadata = async (id) => ({
      id,
      available: true,
      excluded: false,
      candidate: "matched",
      receivedAtMs: Date.parse("2026-09-15T00:00:00Z"),
    });
    expect((await pageTurn(tenant, provider, { slice })).outcome).toEqual({
      kind: "completed",
    });
    const before = await db
      .prepare(
        "SELECT page_token,history_cursor,discovery_version,pending_ids FROM sync_states WHERE user_id=? AND slice_key=?",
      )
      .bind(tenant.userId, slice)
      .first();
    expect((await pageTurn(tenant, provider, { slice })).outcome).toEqual({
      kind: "retry",
      code: "transient",
    });
    expect(
      await db
        .prepare(
          "SELECT page_token,history_cursor,discovery_version,pending_ids FROM sync_states WHERE user_id=? AND slice_key=?",
        )
        .bind(tenant.userId, slice)
        .first(),
    ).toEqual(before);
    expect(
      (
        await db
          .prepare(
            "SELECT provider_message_id FROM source_messages WHERE user_id=?",
          )
          .bind(tenant.userId)
          .all<{ provider_message_id: string }>()
      ).results,
    ).toEqual([{ provider_message_id: "loop-initial-source" }]);
    const other = await owner(`loop-unaffected-${slice}`);
    await service().beginAcceptedImport(other, accepted(other));
    expect((await pageTurn(other, pageProvider())).outcome).toEqual({
      kind: "completed",
    });
  },
);
