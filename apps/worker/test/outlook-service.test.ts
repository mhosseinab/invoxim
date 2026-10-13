import { env } from "cloudflare:workers";
import {
  createCredentialCipher,
  createCredentialVault,
  createLoginAuth,
  createMailboxService,
  createProfileService,
  encodeBase64url,
  type LoginConfiguration,
} from "@invoxim/adapters";
import type { MailboxAuthorizationPort, MailboxSession } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import type { MailboxServiceConfiguration } from "../../../packages/adapters/src/mailbox/types";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;

const login: LoginConfiguration = {
  origin: "https://synthetic.example",
  secret: "synthetic-outlook-login-secret-never-production-12345",
  googleClientId: "synthetic-login-client",
  googleClientSecret: "synthetic-login-secret",
  allowedEmails: [
    "qa-outlook-login@example.invalid",
    "qa-outlook-other@example.invalid",
  ],
};
const scopes = ["openid", "profile", "email", "offline_access", "Mail.Read"];
const configuration: MailboxServiceConfiguration = {
  provider: "outlook",
  oauthProvider: "microsoft",
  callback: `${login.origin}/api/oauth/mailbox/outlook/callback`,
  limit: 10,
  scopes,
  cipher: createCredentialCipher({
    activeVersion: 1,
    keys: { 1: encodeBase64url(new Uint8Array(32).fill(7)) },
  }),
};
let session: MailboxSession;
beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('qa-outlook-login','Synthetic Google login',?,1,0,0)",
    )
    .bind(login.allowedEmails[0])
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES('qa-outlook-login',0,0)",
    )
    .run();
  session = await verifiedSession("qa-outlook-login");
});
async function verifiedSession(userId: string): Promise<MailboxSession> {
  const auth = createLoginAuth(db, login);
  const context = await auth.$context;
  const created = await context.internalAdapter.createSession(userId, false);
  if (!created)
    throw new Error("Actual synthetic login session was not created");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(login.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(created.token),
  );
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${created.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
  const current = await createProfileService(db, auth, login).current(
    new Headers({ Cookie: cookie }),
  );
  if (!current)
    throw new Error(
      "Server failed to verify the actual signed Google-login session",
    );
  return {
    tenant: current.tenant,
    sessionId: current.session.id,
    createdAtMs: current.session.createdAt.getTime(),
  };
}
function authorization(subject: string): MailboxAuthorizationPort {
  return {
    authorize: async (input) =>
      `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=${input.state}`,
    exchange: async () => ({
      identity: { subject, address: `${subject}@example.invalid` },
      credentials: {
        accessToken: `synthetic-${subject}-access`,
        refreshToken: `synthetic-${subject}-refresh`,
        expiresAt: Date.now() + 3600000,
      },
      canReadMessages: true,
    }),
    refresh: async (credentials) => ({
      ...credentials,
      accessToken: "synthetic-outlook-refreshed",
    }),
  };
}
function service(subject: string, config = configuration) {
  const meter = createInvocationDatabase(env.DB, 40);
  return {
    mailbox: createMailboxService(meter.db, config, authorization(subject)),
    meter,
  };
}
function stateFrom(url: string) {
  const state = new URL(url).searchParams.get("state");
  if (!state)
    throw new Error(
      "Authorization URL must carry a server-created OAuth state",
    );
  return state;
}
async function connected(subject: string, config = configuration) {
  const begun = service(subject, config);
  const started = await begun.mailbox.start(session);
  expect(begun.meter.executedStatements()).toBeLessThanOrEqual(40);
  const completed = service(subject, config);
  const connection = await completed.mailbox.complete(session, {
    state: stateFrom(started.authorizationUrl),
    code: "synthetic-code",
  });
  expect(completed.meter.executedStatements()).toBeLessThanOrEqual(40);
  return { connection, state: stateFrom(started.authorizationUrl) };
}
it("OUTLOOK-01 Microsoft mailbox consent binds Microsoft state to the verified Google-login session", async () => {
  const { mailbox, meter } = service("outlook-state-b");
  const started = await mailbox.start(session);
  expect(new URL(started.authorizationUrl).hostname).toBe(
    "login.microsoftonline.com",
  );
  expect(
    await db
      .prepare(
        "SELECT provider,purpose,user_id,session_id FROM oauth_states WHERE user_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .bind(session.tenant.userId)
      .first(),
  ).toMatchObject({
    provider: "microsoft",
    purpose: "mailbox",
    user_id: session.tenant.userId,
    session_id: session.sessionId,
  });
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("OUTLOOK-01 login A connects Outlook B as Outlook, awaiting explicit Start with encrypted credentials and no work", async () => {
  const begun = service("outlook-account-b");
  const started = await begun.mailbox.start(session);
  expect(begun.meter.executedStatements()).toBeLessThanOrEqual(40);
  const completed = service("outlook-account-b");
  const connection = await completed.mailbox.complete(session, {
    state: stateFrom(started.authorizationUrl),
    code: "synthetic-code",
  });
  expect(connection).toMatchObject({
    provider: "outlook",
    address: "outlook-account-b@example.invalid",
    schedulingState: "awaiting_import",
    generation: 1,
    credentialVersion: 1,
  });
  expect(
    await db
      .prepare(
        "SELECT provider,user_id,scopes,credential_ciphertext FROM connections WHERE user_id=? AND id=?",
      )
      .bind(session.tenant.userId, connection.id)
      .first(),
  ).toMatchObject({
    provider: "outlook",
    user_id: session.tenant.userId,
    scopes: JSON.stringify(scopes),
    credential_ciphertext: expect.not.stringContaining(
      "synthetic-outlook-account-b",
    ),
  });
  for (const table of ["jobs", "processing_consents", "source_messages"])
    expect(
      await db
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`)
        .bind(session.tenant.userId)
        .first("n"),
    ).toBe(0);
  expect(completed.meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-01 provider-bound state cannot cross providers even when callbacks match, and failed cross-provider use preserves its valid Google intent", async () => {
  const google: MailboxServiceConfiguration = {
    ...configuration,
    provider: "gmail",
    oauthProvider: "google",
    scopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
  };
  // A common callback is permitted by this service port. Provider identity must
  // remain independently bound, rather than relying on distinct URL strings.
  const begun = service("cross-provider", google);
  const started = await begun.mailbox.start(session);
  const state = stateFrom(started.authorizationUrl);
  const wrong = service("cross-provider");
  await expect(
    wrong.mailbox.complete(session, { state, code: "synthetic-code" }),
  ).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(wrong.meter.executedStatements()).toBeLessThanOrEqual(40);
  const valid = service("cross-provider", google);
  expect(
    await valid.mailbox.complete(session, { state, code: "synthetic-code" }),
  ).toMatchObject({ provider: "gmail" });
  expect(valid.meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-01 equal provider subjects remain independent across Gmail and Outlook; callback replay cannot rotate credentials", async () => {
  const google: MailboxServiceConfiguration = {
    ...configuration,
    provider: "gmail",
    oauthProvider: "google",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  };
  const g = await connected("shared-subject", google);
  const m = await connected("shared-subject");
  expect(m.connection.id).not.toBe(g.connection.id);
  const rows = await db
    .prepare(
      "SELECT id,provider,generation,credential_version,credential_ciphertext FROM connections WHERE user_id=? AND provider_subject=? ORDER BY provider",
    )
    .bind(session.tenant.userId, "shared-subject")
    .all();
  expect(rows.results.map((row) => row.provider)).toEqual(["gmail", "outlook"]);
  const replay = service("shared-subject");
  await expect(
    replay.mailbox.complete(session, {
      state: m.state,
      code: "synthetic-code",
    }),
  ).rejects.toMatchObject({ code: "INVALID_STATE" });
  const replayedRows = await db
    .prepare(
      "SELECT id,provider,generation,credential_version,credential_ciphertext FROM connections WHERE user_id=? AND provider_subject=? ORDER BY provider",
    )
    .bind(session.tenant.userId, "shared-subject")
    .all();
  expect(replayedRows.results).toEqual(rows.results);
  expect(replay.meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-01 concurrent refresh is serialized and stale generation cannot reach the Outlook provider", async () => {
  const { connection } = await connected("refresh-serialized");
  let markEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshCalls = 0;
  const port = authorization("refresh-serialized");
  port.refresh = async (credentials) => {
    refreshCalls++;
    markEntered?.();
    await wait;
    return {
      ...credentials,
      accessToken: "synthetic-refreshed-outlook-access",
    };
  };
  const firstMeter = createInvocationDatabase(env.DB, 40);
  const first = createMailboxService(
    firstMeter.db,
    configuration,
    port,
  ).refresh(session.tenant, connection.id, connection.generation);
  await entered;
  const secondMeter = createInvocationDatabase(env.DB, 40);
  await expect(
    createMailboxService(secondMeter.db, configuration, port).refresh(
      session.tenant,
      connection.id,
      connection.generation,
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  release?.();
  expect(await first).toMatchObject({
    provider: "outlook",
    generation: 1,
    credentialVersion: 2,
  });
  const secretMeter = createInvocationDatabase(env.DB, 40);
  const retained = await createCredentialVault(
    secretMeter.db,
    configuration.cipher,
  ).read(
    session.tenant,
    {
      kind: "connection",
      id: connection.id,
      generation: connection.generation,
    },
    2,
  );
  expect(retained?.secret).toMatchObject({
    accessToken: "synthetic-refreshed-outlook-access",
    refreshToken: "synthetic-refresh-serialized-refresh",
  });
  const staleMeter = createInvocationDatabase(env.DB, 40);
  await expect(
    createMailboxService(staleMeter.db, configuration, port).refresh(
      session.tenant,
      connection.id,
      connection.generation + 1,
    ),
  ).rejects.toMatchObject({ code: "RECONNECT_REQUIRED" });
  expect(refreshCalls).toBe(1);
  for (const meter of [firstMeter, secondMeter, staleMeter, secretMeter])
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-01 wrong tenant and a second session cannot consume another session's mailbox state", async () => {
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('qa-outlook-other','Other synthetic owner','qa-outlook-other@example.invalid',1,0,0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES('qa-outlook-other',0,0)",
    )
    .run();
  const other = await verifiedSession("qa-outlook-other");
  const sameOwnerOtherSession = await verifiedSession(session.tenant.userId);
  const begun = service("session-bound");
  const started = await begun.mailbox.start(session);
  const state = stateFrom(started.authorizationUrl);
  for (const wrongSession of [other, sameOwnerOtherSession]) {
    const wrong = service("session-bound");
    await expect(
      wrong.mailbox.complete(wrongSession, { state, code: "synthetic-code" }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(wrong.meter.executedStatements()).toBeLessThanOrEqual(40);
  }
  const valid = service("session-bound");
  const connection = await valid.mailbox.complete(session, {
    state,
    code: "synthetic-code",
  });
  const privateRead = service("session-bound");
  expect(await privateRead.mailbox.list(other.tenant)).toEqual({
    connections: [],
    hasMore: false,
  });
  await expect(
    privateRead.mailbox.refresh(other.tenant, connection.id),
  ).rejects.toMatchObject({ code: "RECONNECT_REQUIRED" });
  expect(privateRead.meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-01 a generation change during reconnect fences the callback before credential replacement", async () => {
  const { connection } = await connected("generation-fenced");
  const begun = service("generation-fenced");
  const started = await begun.mailbox.start(session, connection.id);
  const disconnect = service("generation-fenced");
  await disconnect.mailbox.disconnect(session, connection.id, {
    generation: connection.generation,
    credentialVersion: connection.credentialVersion,
  });
  const before = await db
    .prepare(
      "SELECT state,generation,credential_version,credential_ciphertext FROM connections WHERE user_id=? AND id=?",
    )
    .bind(session.tenant.userId, connection.id)
    .first();
  const stale = service("generation-fenced");
  await expect(
    stale.mailbox.complete(session, {
      state: stateFrom(started.authorizationUrl),
      code: "synthetic-code",
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(
    await db
      .prepare(
        "SELECT state,generation,credential_version,credential_ciphertext FROM connections WHERE user_id=? AND id=?",
      )
      .bind(session.tenant.userId, connection.id)
      .first(),
  ).toEqual(before);
  expect(before).toMatchObject({
    state: "disconnected",
    generation: 2,
    credential_version: 2,
    credential_ciphertext: null,
  });
  for (const meter of [begun.meter, disconnect.meter, stale.meter])
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-01 Outlook completion respects the shared mailbox cap without adding credentials or scheduling work", async () => {
  await connected("cap-outlook");
  await connected("cap-google", {
    ...configuration,
    provider: "gmail",
    oauthProvider: "google",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  });
  const before = await db
    .prepare(
      "SELECT id,credential_ciphertext FROM connections WHERE user_id=? ORDER BY id",
    )
    .bind(session.tenant.userId)
    .all();
  expect(before.results.length).toBeGreaterThan(1);
  const config = { ...configuration, limit: 1 };
  const begun = service("over-limit", config);
  const started = await begun.mailbox.start(session);
  const capped = service("over-limit", config);
  await expect(
    capped.mailbox.complete(session, {
      state: stateFrom(started.authorizationUrl),
      code: "synthetic-code",
    }),
  ).rejects.toMatchObject({ code: "LIMIT_REACHED" });
  const after = await db
    .prepare(
      "SELECT id,credential_ciphertext FROM connections WHERE user_id=? ORDER BY id",
    )
    .bind(session.tenant.userId)
    .all();
  expect(after.results).toEqual(before.results);
  for (const meter of [begun.meter, capped.meter])
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
