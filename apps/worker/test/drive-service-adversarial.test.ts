import { env } from "cloudflare:workers";
import {
  createCredentialCipher,
  createCredentialVault,
  createLoginAuth,
  createOAuthStateStore,
  createProfileService,
  encodeBase64url,
  type LoginConfiguration,
} from "@invoxim/adapters";
import type {
  ArchiveAuthorization,
  ArchiveAuthorizationPort,
  ArchiveSession,
} from "@invoxim/core";
import { beforeAll, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { DRIVE_AUTHORIZATION_SCOPES } from "../../../packages/adapters/src/drive/configuration";
import { createDriveService } from "../../../packages/adapters/src/drive/service";
import type { DriveServiceConfiguration } from "../../../packages/adapters/src/drive/service-types";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;

const login: LoginConfiguration = {
  origin: "https://synthetic.example",
  secret: "synthetic-drive-qa-login-secret-1234567890",
  googleClientId: "synthetic-google-login",
  googleClientSecret: "synthetic-login-secret",
  allowedEmails: [],
};
const config: DriveServiceConfiguration = {
  provider: "google-drive",
  oauthProvider: "google",
  callback: `${login.origin}/api/oauth/storage/google-drive/callback`,
  cipher: createCredentialCipher({
    activeVersion: 1,
    keys: { 1: encodeBase64url(new Uint8Array(32).fill(17)) },
  }),
  scopes: DRIVE_AUTHORIZATION_SCOPES,
};
beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((v) => v.trim()))
      await db.prepare(statement).run();
});

async function signedSession(userId: string): Promise<ArchiveSession> {
  const auth = createLoginAuth(db, login);
  const context = await auth.$context;
  const row = await context.internalAdapter.createSession(userId, false);
  if (!row)
    throw new Error("Positive fixture requires a real application session");
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
    new TextEncoder().encode(row.token),
  );
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${row.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
  const current = await createProfileService(db, auth, login).current(
    new Headers({ Cookie: cookie }),
  );
  if (!current)
    throw new Error("Server must verify the signed Google-login actor");
  return {
    tenant: current.tenant,
    sessionId: current.session.id,
    createdAtMs: current.session.createdAt.getTime(),
  };
}
async function actor(name: string) {
  const id = `qa-drive-${name}`,
    email = `${id}@example.invalid`;
  login.allowedEmails.push(email);
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)",
    )
    .bind(id, "Synthetic Google login", email, Date.now(), Date.now())
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
    )
    .bind(id, Date.now(), Date.now())
    .run();
  const session = await signedSession(id);
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes,credential_ciphertext,credential_key_version,credential_version,scheduling_state) VALUES('mail-b',?,'mailbox','gmail','independent-mail-b','mail-b@example.invalid',?,'synthetic-mail-cipher',1,1,'awaiting_import')",
    )
    .bind(
      id,
      JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
    )
    .run();
  return session;
}
function provider(
  subject = "drive-d",
  beforeExchange: () => Promise<void> = async () => {},
): ArchiveAuthorizationPort {
  return {
    authorize: vi.fn(
      async (input) =>
        `https://accounts.google.com/o/oauth2/v2/auth?state=${input.state}`,
    ),
    exchange: vi.fn(async (): Promise<ArchiveAuthorization> => {
      await beforeExchange();
      return {
        identity: { subject, address: `${subject}@example.invalid` },
        credentials: {
          accessToken: `synthetic-${subject}-access`,
          refreshToken: `synthetic-${subject}-refresh`,
          expiresAt: Date.now() + 3600000,
        },
        canArchiveFiles: true,
      };
    }),
    refresh: vi.fn(async (current) => current),
  };
}
function invocation(port: ArchiveAuthorizationPort) {
  const meter = createInvocationDatabase(env.DB, 40);
  return { service: createDriveService(meter.db, config, port), meter };
}
async function begin(
  session: ArchiveSession,
  port: ArchiveAuthorizationPort,
  id?: string,
) {
  const current = invocation(port);
  const response = await current.service.start(session, id);
  const state = new URL(response.authorizationUrl).searchParams.get("state");
  if (!state)
    throw new Error("Positive start must return actual server-created state");
  expect(current.meter.executedStatements()).toBeLessThanOrEqual(40);
  return state;
}
async function grant(session: ArchiveSession, port = provider()) {
  const state = await begin(session, port),
    current = invocation(port);
  const result = await current.service.complete(session, {
    state,
    code: "synthetic-code",
  });
  expect(current.meter.executedStatements()).toBeLessThanOrEqual(40);
  return result;
}
async function snapshot(session: ArchiveSession) {
  const u = session.tenant.userId;
  return {
    connections: (
      await db
        .prepare("SELECT * FROM connections WHERE user_id=? ORDER BY id")
        .bind(u)
        .all()
    ).results,
    settings: (
      await db
        .prepare("SELECT * FROM archive_settings WHERE user_id=?")
        .bind(u)
        .all()
    ).results,
    jobs: (
      await db
        .prepare("SELECT * FROM jobs WHERE user_id=? ORDER BY id")
        .bind(u)
        .all()
    ).results,
  };
}
it("DRIVE-01 owner and initiating session bind storage consent without consuming another actor's state", async () => {
  const a = await actor("actor-a"),
    b = await actor("actor-b"),
    port = provider(),
    state = await begin(a, port);
  const before = await snapshot(b),
    wrong = invocation(port);
  await expect(
    wrong.service.complete(b, { state, code: "synthetic-code" }),
  ).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(await snapshot(b)).toEqual(before);
  expect(port.exchange).not.toHaveBeenCalled();
  const sameAccountOtherSession = await signedSession(a.tenant.userId),
    swapped = invocation(port);
  await expect(
    swapped.service.complete(sameAccountOtherSession, {
      state,
      code: "synthetic-code",
    }),
  ).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(port.exchange).not.toHaveBeenCalled();
  const positive = invocation(port);
  expect(
    await positive.service.complete(a, { state, code: "synthetic-code" }),
  ).toMatchObject({ provider: "google-drive", archivingEnabled: false });
  for (const x of [wrong, swapped, positive])
    expect(x.meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("DRIVE-01 independent Drive D grant leaves mailbox B and archive settings unchanged and projects no credentials", async () => {
  const a = await actor("independent"),
    before = await snapshot(a),
    port = provider("independent-drive-d"),
    result = await grant(a, port);
  expect(result).toMatchObject({
    kind: "storage",
    provider: "google-drive",
    address: "independent-drive-d@example.invalid",
    archivingEnabled: false,
  });
  const after = await snapshot(a);
  expect(after.connections.filter((row) => row.kind === "mailbox")).toEqual(
    before.connections,
  );
  expect(after.settings).toEqual(before.settings);
  expect(after.jobs).toEqual([]);
  const publicList = invocation(port),
    projection = await publicList.service.list(a.tenant);
  const encoded = JSON.stringify(projection);
  for (const privateField of [
    "synthetic-independent-drive-d-access",
    "synthetic-independent-drive-d-refresh",
    "credential_ciphertext",
    "credential_key_version",
  ])
    expect(encoded).not.toContain(privateField);
  const secret = await createCredentialVault(db, config.cipher).read(
    a.tenant,
    { kind: "connection", id: result.id, generation: result.generation },
    result.credentialVersion,
  );
  expect(secret?.secret).toMatchObject({
    accessToken: "synthetic-independent-drive-d-access",
    refreshToken: "synthetic-independent-drive-d-refresh",
  });
  expect(publicList.meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("DRIVE-01 denial and replay make no grant and invoke no exchange", async () => {
  const a = await actor("denial"),
    port = provider(),
    state = await begin(a, port),
    before = await snapshot(a),
    deny = invocation(port);
  await expect(
    deny.service.complete(a, { state, denied: true }),
  ).rejects.toMatchObject({ code: "DENIED" });
  expect(await snapshot(a)).toEqual(before);
  const replay = invocation(port);
  await expect(
    replay.service.complete(a, { state, code: "synthetic-code" }),
  ).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(port.exchange).not.toHaveBeenCalled();
  for (const x of [deny, replay])
    expect(x.meter.executedStatements()).toBeLessThanOrEqual(40);
});
for (const change of ["session-deleted", "profile-deleting"] as const)
  it(`DRIVE-01 exchange cannot commit after ${change}`, async () => {
    const a = await actor(change),
      before = await snapshot(a);
    const port = provider("awaited-drive", async () => {
      if (change === "session-deleted")
        await db
          .prepare("DELETE FROM session WHERE id=?")
          .bind(a.sessionId)
          .run();
      else
        await db
          .prepare("UPDATE profiles SET status='deleting' WHERE user_id=?")
          .bind(a.tenant.userId)
          .run();
    });
    const state = await begin(a, port),
      current = invocation(port);
    await expect(
      current.service.complete(a, { state, code: "synthetic-code" }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(port.exchange).toHaveBeenCalledTimes(1);
    expect(await snapshot(a)).toEqual(before);
    expect(current.meter.executedStatements()).toBeLessThanOrEqual(40);
  });
it("DRIVE-01 native one-hour recency cannot be bypassed by caller createdAt and accepts the exact boundary", async () => {
  const a = await actor("recency"),
    port = provider(),
    now = Date.now(),
    clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    await db
      .prepare("UPDATE session SET createdAt=? WHERE id=?")
      .bind(now - 3600001, a.sessionId)
      .run();
    const rejected = invocation(port);
    await expect(
      rejected.service.start({ ...a, createdAtMs: now }),
    ).rejects.toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    expect(port.authorize).not.toHaveBeenCalled();
    await db
      .prepare("UPDATE session SET createdAt=? WHERE id=?")
      .bind(now - 3600000, a.sessionId)
      .run();
    const positive = invocation(port);
    expect(
      await positive.service.start({ ...a, createdAtMs: now }),
    ).toMatchObject({ authorizationUrl: expect.any(String) });
    expect(port.authorize).toHaveBeenCalledTimes(1);
    await db
      .prepare("UPDATE session SET expiresAt=? WHERE id=?")
      .bind(now - 1, a.sessionId)
      .run();
    const expired = invocation(port);
    await expect(
      expired.service.start({ ...a, createdAtMs: now }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(port.authorize).toHaveBeenCalledTimes(1);
    for (const x of [rejected, positive, expired])
      expect(x.meter.executedStatements()).toBeLessThanOrEqual(40);
  } finally {
    clock.mockRestore();
  }
});

it("DRIVE-01 a mailbox-purpose OAuth state cannot authorize storage or be consumed by it", async () => {
  const a = await actor("purpose"),
    port = provider();
  const stateMeter = createInvocationDatabase(env.DB, 40);
  const stateStore = createOAuthStateStore(stateMeter.db, config.cipher, {
    callbacks: {
      mailbox: { google: `${login.origin}/api/oauth/mailbox/gmail/callback` },
      storage: { google: config.callback },
    },
  });
  const state = await stateStore.create(a.tenant, {
    sessionId: a.sessionId,
    purpose: "mailbox",
    provider: "google",
    pkceVerifier: "s".repeat(43),
  });
  const before = (
    await db
      .prepare("SELECT * FROM oauth_states WHERE user_id=? ORDER BY state_hash")
      .bind(a.tenant.userId)
      .all()
  ).results;
  const current = invocation(port);
  await expect(
    current.service.complete(a, { state: state.state, code: "synthetic-code" }),
  ).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(port.exchange).not.toHaveBeenCalled();
  expect(
    (
      await db
        .prepare(
          "SELECT * FROM oauth_states WHERE user_id=? ORDER BY state_hash",
        )
        .bind(a.tenant.userId)
        .all()
    ).results,
  ).toEqual(before);
  for (const meter of [stateMeter, current.meter])
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("DRIVE-01 duplicate new subject consent conflicts while explicit reconnect is the positive", async () => {
  const a = await actor("duplicate"),
    port = provider("duplicate-drive"),
    existing = await grant(a, port),
    before = await snapshot(a);
  const state = await begin(a, port),
    duplicate = invocation(port);
  await expect(
    duplicate.service.complete(a, { state, code: "synthetic-code" }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await snapshot(a)).toEqual(before);
  const explicitState = await begin(a, port, existing.id),
    positive = invocation(port);
  expect(
    await positive.service.complete(a, {
      state: explicitState,
      code: "synthetic-code",
    }),
  ).toMatchObject({
    id: existing.id,
    credentialVersion: existing.credentialVersion + 1,
  });
  expect(
    (await snapshot(a)).connections.filter((row) => row.kind === "storage"),
  ).toHaveLength(1);
  for (const x of [duplicate, positive])
    expect(x.meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("DRIVE-01 reconnect cannot substitute another provider identity", async () => {
  const a = await actor("mismatch"),
    existing = await grant(a, provider("original-drive")),
    port = provider("substituted-drive"),
    state = await begin(a, port, existing.id),
    before = await snapshot(a),
    current = invocation(port);
  await expect(
    current.service.complete(a, { state, code: "synthetic-code" }),
  ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  expect(await snapshot(a)).toEqual(before);
  expect(current.meter.executedStatements()).toBeLessThanOrEqual(40);
});
async function selected(
  session: ArchiveSession,
  id: string,
  generation: number,
) {
  await db
    .prepare(
      "INSERT INTO archive_settings(user_id,enabled,version,connection_id,connection_generation,disclosure_version,accepted_at) VALUES(?,1,1,?,?,1,?)",
    )
    .bind(session.tenant.userId, id, generation, Date.now())
    .run();
}
it("DRIVE-01 a newer same-destination consent cannot be cleared by an older reconnect prompt", async () => {
  const a = await actor("newer-consent"),
    port = provider("selected-drive"),
    existing = await grant(a, port);
  await selected(a, existing.id, existing.generation);
  const state = await begin(a, port, existing.id);
  await db
    .prepare(
      "UPDATE archive_settings SET version=2,accepted_at=accepted_at+1 WHERE user_id=?",
    )
    .bind(a.tenant.userId)
    .run();
  const before = await snapshot(a),
    current = invocation(port);
  await expect(
    current.service.complete(a, { state, code: "synthetic-code" }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await snapshot(a)).toEqual(before);
  const freshState = await begin(a, port, existing.id),
    positive = invocation(port);
  expect(
    await positive.service.complete(a, {
      state: freshState,
      code: "synthetic-code",
    }),
  ).toMatchObject({
    id: existing.id,
    credentialVersion: existing.credentialVersion + 1,
    archivingEnabled: false,
  });
  expect((await snapshot(a)).settings).toEqual([
    expect.objectContaining({
      enabled: 0,
      version: 3,
      connection_id: null,
      connection_generation: null,
      disclosure_version: null,
      accepted_at: null,
    }),
  ]);
  for (const x of [current, positive])
    expect(x.meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("DRIVE-01 unrelated selected destination changes do not clear or block this grant", async () => {
  const a = await actor("other-destination"),
    port = provider("drive-first"),
    first = await grant(a, port),
    other = await grant(a, provider("drive-second"));
  await selected(a, other.id, other.generation);
  const state = await begin(a, port, first.id);
  await db
    .prepare(
      "UPDATE archive_settings SET version=2,accepted_at=accepted_at+1 WHERE user_id=?",
    )
    .bind(a.tenant.userId)
    .run();
  const settings = (await snapshot(a)).settings,
    current = invocation(port);
  expect(
    await current.service.complete(a, { state, code: "synthetic-code" }),
  ).toMatchObject({
    id: first.id,
    credentialVersion: first.credentialVersion + 1,
  });
  expect((await snapshot(a)).settings).toEqual(settings);
  expect(current.meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("DRIVE-06 precise storage disconnect fences pending reconnect and leaves other owner and mailbox intact", async () => {
  const a = await actor("disconnect-a"),
    b = await actor("disconnect-b"),
    port = provider("disconnect-drive"),
    own = await grant(a, port),
    other = await grant(b, provider("disconnect-drive"));
  const state = await begin(a, port, own.id),
    beforeOther = await snapshot(b),
    beforeMail = (await snapshot(a)).connections.filter(
      (row) => row.kind === "mailbox",
    );
  const wrong = invocation(port);
  await expect(
    wrong.service.disconnect(a, other.id, {
      generation: other.generation,
      credentialVersion: other.credentialVersion,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await snapshot(b)).toEqual(beforeOther);
  const current = invocation(port);
  await current.service.disconnect(a, own.id, {
    generation: own.generation,
    credentialVersion: own.credentialVersion,
  });
  expect(
    (await snapshot(a)).connections.filter((row) => row.kind === "mailbox"),
  ).toEqual(beforeMail);
  expect(await snapshot(b)).toEqual(beforeOther);
  const pending = invocation(port);
  await expect(
    pending.service.complete(a, { state, code: "synthetic-code" }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(
    (await snapshot(a)).connections.filter((row) => row.kind === "storage"),
  ).toEqual([
    expect.objectContaining({
      state: "disconnected",
      generation: own.generation + 1,
      credential_ciphertext: null,
    }),
  ]);
  for (const x of [wrong, current, pending])
    expect(x.meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("DRIVE-01 expired server intent refuses exchange while the login session remains valid", async () => {
  const a = await actor("expired-intent"),
    port = provider(),
    state = await begin(a, port),
    before = await snapshot(a);
  await db
    .prepare("UPDATE oauth_states SET expires_at=? WHERE user_id=?")
    .bind(Date.now() - 1, a.tenant.userId)
    .run();
  const current = invocation(port);
  await expect(
    current.service.complete(a, { state, code: "synthetic-code" }),
  ).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(port.exchange).not.toHaveBeenCalled();
  expect(await snapshot(a)).toEqual(before);
  expect(current.meter.executedStatements()).toBeLessThanOrEqual(40);
});
