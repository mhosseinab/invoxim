import { env } from "cloudflare:workers";
import {
  createLoginAuth,
  encodeBase64url,
  issueWorkspaceMutationToken,
  loginConfiguration,
} from "@invoxim/adapters";
import { afterEach, expect, it, vi } from "vitest";
import {
  DRIVE_AUTHORIZATION_SCOPES,
  driveConfiguration,
} from "../../../packages/adapters/src/drive/configuration";
import worker from "../src/index";
import { createInvocationDatabase } from "../src/invocation-database";
import { owner, installOnboardingQaHooks } from "./onboarding-qa-fixture";

installOnboardingQaHooks();

const db = env.DB;

afterEach(() => vi.restoreAllMocks());
async function fixture(name: string) {
  const current = await owner(name, `mail-${name}`);
  const bindings = {
    DB: env.DB,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://storage-route.example.invalid",
    AUTH_SECRET: "synthetic-storage-route-signing-secret-1234567890",
    AUTH_GOOGLE_CLIENT_ID: "synthetic-login",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic-login-secret",
    AUTH_ALLOWED_EMAILS: JSON.stringify([current.loginEmail]),
    DRIVE_ENABLED: "true",
    DRIVE_CLIENT_ID: "synthetic-drive.apps.googleusercontent.com",
    DRIVE_CLIENT_SECRET: "synthetic-drive-secret",
    CREDENTIAL_KEYRING: JSON.stringify({
      activeVersion: 1,
      keys: { 1: encodeBase64url(new Uint8Array(32).fill(6)) },
    }),
  };
  const login = loginConfiguration(bindings);
  if (!login || !driveConfiguration(bindings))
    throw new Error("Synthetic route configuration invalid");
  const context = await createLoginAuth(db, login).$context;
  const signingSecret = login.secret;
  async function signedSession() {
    const session = await context.internalAdapter.createSession(
      current.tenant.userId,
      false,
    );
    if (!session) throw new Error("Synthetic real session missing");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(session.token),
    );
    return {
      session,
      cookie: `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`,
    };
  }
  return {
    current,
    bindings,
    login,
    ...(await signedSession()),
    signedSession,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function request(
  f: Fixture,
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
  overrides: Partial<typeof f.bindings> = {},
  headers: Record<string, string> = {},
) {
  const meter = createInvocationDatabase(env.DB, 40);
  const response = await worker.fetch(
    new Request(`${f.login.origin}${path}`, {
      method,
      headers: {
        Cookie: f.cookie,
        Origin: f.login.origin,
        "Content-Type": "application/json",
        ...(token ? { "X-Workspace-Token": token } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...f.bindings, ...overrides, DB: meter.db },
  );
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response;
}
async function settings(
  f: Fixture,
  overrides: Partial<typeof f.bindings> = {},
) {
  const response = await request(
    f,
    "/api/storage/settings",
    "GET",
    undefined,
    undefined,
    overrides,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    authorizationAvailable: boolean;
    archivingAvailable: boolean;
    mutationToken: string;
    connections: { id: string; configured: boolean }[];
    settings: { enabled: boolean; version: number };
  };
}
async function start(f: Fixture) {
  const view = await settings(f);
  const response = await request(
    f,
    "/api/connections/storage/google-drive/start",
    "POST",
    {},
    view.mutationToken,
  );
  expect(response.status).toBe(200);
  const value = (await response.json()) as { authorizationUrl: string };
  const url = new URL(value.authorizationUrl),
    state = url.searchParams.get("state");
  if (!state) throw new Error("Synthetic storage state missing");
  expect(url.searchParams.get("scope")?.split(" ")).toContain(
    "https://www.googleapis.com/auth/drive.file",
  );
  return state;
}
async function storageConnection(f: Fixture) {
  const id = `storage-${f.current.tenant.userId}`;
  const config = driveConfiguration(f.bindings);
  if (!config) throw new Error("Synthetic fixture cipher missing");
  const sealed = await config.cipher.seal(
    f.current.tenant,
    { entityId: id, purpose: "storage-credentials" },
    {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: Date.now() + 60000,
    },
  );
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state,scopes,credential_ciphertext,credential_key_version,credential_version) VALUES(?,?,'storage','google-drive',?,'drive-d@example.test','connected',?,?,1,1)",
    )
    .bind(
      id,
      f.current.tenant.userId,
      id,
      JSON.stringify(DRIVE_AUTHORIZATION_SCOPES),
      sealed,
    )
    .run();
  return id;
}
it("storage settings issue a private session-bound token without claiming a working archive", async () => {
  const f = await fixture("storage-route-view");
  const value = await settings(f);
  expect(value).toMatchObject({
    authorizationAvailable: true,
    archivingAvailable: false,
    connections: [],
    settings: { enabled: false, version: 0 },
  });
  expect(value.mutationToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  expect(JSON.stringify(value)).not.toContain("synthetic-drive-secret");
});
it("actual storage start creates only storage-purpose state and never reads mail or schedules work", async () => {
  const f = await fixture("storage-route-start");
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected synthetic remote request"));
  await start(f);
  expect(fetch).not.toHaveBeenCalled();
  expect(
    await db
      .prepare("SELECT purpose,provider FROM oauth_states WHERE user_id=?")
      .bind(f.current.tenant.userId)
      .first(),
  ).toEqual({ purpose: "storage", provider: "google" });
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM jobs WHERE user_id=?")
      .bind(f.current.tenant.userId)
      .first<number>("n"),
  ).toBe(0);
});
it("actor A form under actor B cookie cannot start Drive authorization", async () => {
  const a = await fixture("storage-route-actor-a"),
    b = await fixture("storage-route-actor-b");
  const token = (await settings(a)).mutationToken;
  expect(
    (
      await request(
        b,
        "/api/connections/storage/google-drive/start",
        "POST",
        {},
        token,
      )
    ).status,
  ).toBe(403);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM oauth_states WHERE user_id=?")
      .bind(b.current.tenant.userId)
      .first<number>("n"),
  ).toBe(0);
});
it("missing or another mutation purpose cannot authorize storage changes", async () => {
  const f = await fixture("storage-route-purpose");
  const wrong = await issueWorkspaceMutationToken(
    { userId: f.current.tenant.userId, sessionId: f.session.id },
    f.login.secret,
  );
  for (const token of [undefined, wrong])
    expect(
      (
        await request(
          f,
          "/api/connections/storage/google-drive/start",
          "POST",
          {},
          token,
        )
      ).status,
    ).toBe(403);
});
it("storage mutation validates exact origin and strict body without minting state", async () => {
  const f = await fixture("storage-route-input"),
    token = (await settings(f)).mutationToken;
  expect(
    (
      await request(
        f,
        "/api/connections/storage/google-drive/start",
        "POST",
        {},
        token,
        {},
        { Origin: "https://other.example.invalid" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        f,
        "/api/connections/storage/google-drive/start",
        "POST",
        { userId: "other" },
        token,
      )
    ).status,
  ).toBe(400);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM oauth_states WHERE user_id=?")
      .bind(f.current.tenant.userId)
      .first<number>("n"),
  ).toBe(0);
});
it("denied callback consumes its storage state and redirects only a safe status", async () => {
  const f = await fixture("storage-route-denied"),
    state = await start(f);
  const path = `/api/oauth/storage/google-drive/callback?state=${state}&error=access_denied&error_description=synthetic-private-description`;
  const response = await request(f, path);
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(
    `${f.login.origin}/settings?storage=denied`,
  );
  expect((await request(f, path)).headers.get("location")).toBe(
    `${f.login.origin}/settings?storage=invalid_state`,
  );
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM connections WHERE user_id=? AND kind='storage'",
      )
      .bind(f.current.tenant.userId)
      .first<number>("n"),
  ).toBe(0);
});
it("callback requires the initiating actor and session without consuming another actor state", async () => {
  const a = await fixture("storage-route-callback-a"),
    b = await fixture("storage-route-callback-b"),
    state = await start(a);
  const path = `/api/oauth/storage/google-drive/callback?state=${state}&error=access_denied`;
  expect((await request(b, path)).headers.get("location")).toBe(
    `${b.login.origin}/settings?storage=invalid_state`,
  );
  const newer = await a.signedSession();
  expect(
    (await request({ ...a, ...newer }, path)).headers.get("location"),
  ).toBe(`${a.login.origin}/settings?storage=invalid_state`);
  expect(
    await db
      .prepare("SELECT consumed_at FROM oauth_states WHERE user_id=?")
      .bind(a.current.tenant.userId)
      .first<number | null>("consumed_at"),
  ).toBeNull();
});
it("contradictory callback fields are refused before consuming state", async () => {
  const f = await fixture("storage-route-callback-fields"),
    state = await start(f);
  const response = await request(
    f,
    `/api/oauth/storage/google-drive/callback?state=${state}&code=synthetic&error=denied`,
  );
  expect(response.headers.get("location")).toBe(
    `${f.login.origin}/settings?storage=invalid_state`,
  );
  expect(
    await db
      .prepare("SELECT consumed_at FROM oauth_states WHERE user_id=?")
      .bind(f.current.tenant.userId)
      .first<number | null>("consumed_at"),
  ).toBeNull();
});
it("disabled provider still allows local private metadata and precise disconnect", async () => {
  const f = await fixture("storage-route-disabled"),
    id = await storageConnection(f);
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Local unlink must not call a provider"));
  const value = await settings(f, { DRIVE_ENABLED: "false" });
  expect(value.authorizationAvailable).toBe(false);
  expect(value.connections).toEqual([
    expect.objectContaining({ id, configured: true }),
  ]);
  expect(
    (
      await request(
        f,
        `/api/connections/storage/${id}`,
        "DELETE",
        { generation: 1, credentialVersion: 1 },
        value.mutationToken,
        { DRIVE_ENABLED: "false" },
      )
    ).status,
  ).toBe(204);
  expect(
    await db
      .prepare(
        "SELECT state,generation,credential_ciphertext FROM connections WHERE user_id=? AND id=?",
      )
      .bind(f.current.tenant.userId, id)
      .first(),
  ).toEqual({
    state: "disconnected",
    generation: 2,
    credential_ciphertext: null,
  });
  expect(
    await db
      .prepare("SELECT state FROM connections WHERE user_id=? AND id=?")
      .bind(f.current.tenant.userId, `mail-${f.current.tenant.userId}`)
      .first<string>("state"),
  ).toBe("connected");
  expect(fetch).not.toHaveBeenCalled();
});
it("an old actual database session cannot mutate storage with a newly minted token", async () => {
  const f = await fixture("storage-route-old-session");
  await db
    .prepare("UPDATE session SET createdAt=? WHERE id=?")
    .bind(Date.now() - 3601000, f.session.id)
    .run();
  const token = (await settings(f)).mutationToken;
  expect(
    (
      await request(
        f,
        "/api/connections/storage/google-drive/start",
        "POST",
        {},
        token,
      )
    ).status,
  ).toBe(403);
});
it("one tenant cannot disconnect another tenant's storage even with its own valid token", async () => {
  const a = await fixture("storage-route-unlink-a"),
    b = await fixture("storage-route-unlink-b"),
    id = await storageConnection(a);
  expect(
    (
      await request(
        b,
        `/api/connections/storage/${id}`,
        "DELETE",
        { generation: 1, credentialVersion: 1 },
        (await settings(b)).mutationToken,
      )
    ).status,
  ).toBe(404);
  expect(
    await db
      .prepare("SELECT state FROM connections WHERE user_id=? AND id=?")
      .bind(a.current.tenant.userId, id)
      .first<string>("state"),
  ).toBe("connected");
});
it("disabling stored archive consent is precise and works independently of provider configuration", async () => {
  const f = await fixture("storage-route-disable"),
    id = await storageConnection(f);
  await db
    .prepare(
      "INSERT INTO archive_settings(user_id,enabled,version,connection_id,connection_generation,disclosure_version,accepted_at) VALUES(?,1,1,?,1,1,0)",
    )
    .bind(f.current.tenant.userId, id)
    .run();
  const token = (await settings(f, { DRIVE_ENABLED: "false" })).mutationToken;
  expect(
    (
      await request(
        f,
        "/api/storage/settings/disable",
        "POST",
        { expectedVersion: 0 },
        token,
        { DRIVE_ENABLED: "false" },
      )
    ).status,
  ).toBe(409);
  const response = await request(
    f,
    "/api/storage/settings/disable",
    "POST",
    { expectedVersion: 1 },
    token,
    { DRIVE_ENABLED: "false" },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    enabled: false,
    version: 2,
    connectionId: null,
  });
  expect(
    await db
      .prepare("SELECT state FROM connections WHERE user_id=? AND id=?")
      .bind(f.current.tenant.userId, id)
      .first<string>("state"),
  ).toBe("connected");
});

it("actual signed Google Drive callback stores independent identity with no archive work", async () => {
  const f = await fixture("storage-route-signed"),
    state = await start(f);
  const nonce = await db
    .prepare(
      "SELECT nonce FROM oauth_states WHERE user_id=? AND consumed_at IS NULL",
    )
    .bind(f.current.tenant.userId)
    .first<string>("nonce");
  if (!nonce) throw new Error("Synthetic nonce not persisted");
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair)) throw new Error("Synthetic RSA pair missing");
  const encode = (value: unknown) =>
    encodeBase64url(new TextEncoder().encode(JSON.stringify(value)));
  const now = Math.floor(Date.now() / 1000),
    subject = "synthetic-drive-route-subject-d";
  const text = `${encode({ alg: "RS256", kid: "synthetic-route-key", typ: "JWT" })}.${encode({ iss: "https://accounts.google.com", sub: subject, aud: f.bindings.DRIVE_CLIENT_ID, nonce, iat: now, exp: now + 3600, email: "Drive-D@example.test", email_verified: true })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(text),
  );
  const jwt = `${text}.${encodeBase64url(new Uint8Array(signature))}`,
    key = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (!("kty" in key)) throw new Error("Synthetic JWK export failed");
  const jwk = { kty: key.kty, n: key.n, e: key.e };
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (value) => {
    const url = value instanceof Request ? value.url : String(value);
    calls.push(url);
    if (url === "https://oauth2.googleapis.com/token")
      return Response.json({
        access_token: "synthetic-route-access",
        refresh_token: "synthetic-route-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: DRIVE_AUTHORIZATION_SCOPES.join(" "),
        id_token: jwt,
      });
    if (url === "https://www.googleapis.com/oauth2/v3/certs")
      return Response.json({
        keys: [
          {
            kty: jwk.kty,
            n: jwk.n,
            e: jwk.e,
            kid: "synthetic-route-key",
            alg: "RS256",
            use: "sig",
          },
        ],
      });
    if (url === "https://openidconnect.googleapis.com/v1/userinfo")
      return Response.json({
        sub: subject,
        email: "drive-d@example.test",
        email_verified: true,
      });
    throw new Error("Unexpected synthetic route destination");
  });
  const response = await request(
    f,
    `/api/oauth/storage/google-drive/callback?state=${state}&code=synthetic-code`,
  );
  expect(response.status).toBe(302);
  const destination = new URL(response.headers.get("location") ?? "");
  expect(destination.origin).toBe(f.login.origin);
  expect(destination.pathname).toBe("/settings");
  expect(destination.searchParams.get("storage")).toBe("connected");
  const id = destination.searchParams.get("connectionId");
  expect(id).toBeTruthy();
  const connection = await db
    .prepare(
      "SELECT user_id,provider_subject,display_address,credential_ciphertext FROM connections WHERE user_id=? AND id=? AND kind='storage'",
    )
    .bind(f.current.tenant.userId, id)
    .first<{
      user_id: string;
      provider_subject: string;
      display_address: string;
      credential_ciphertext: string;
    }>();
  expect(connection).toMatchObject({
    user_id: f.current.tenant.userId,
    provider_subject: subject,
    display_address: "drive-d@example.test",
  });
  expect(connection?.credential_ciphertext).not.toContain(
    "synthetic-route-access",
  );
  expect(calls).toEqual([
    "https://oauth2.googleapis.com/token",
    "https://www.googleapis.com/oauth2/v3/certs",
    "https://openidconnect.googleapis.com/v1/userinfo",
  ]);
  expect((await settings(f)).settings.enabled).toBe(false);
  for (const table of ["jobs", "source_messages"])
    expect(
      await db
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`)
        .bind(f.current.tenant.userId)
        .first<number>("n"),
    ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM archive_settings WHERE user_id=? AND enabled=1",
      )
      .bind(f.current.tenant.userId)
      .first<number>("n"),
  ).toBe(0);
});

it("the canonical connections collection includes mailbox and storage metadata with OAuth providers disabled", async () => {
  const f = await fixture("storage-route-collection"),
    id = await storageConnection(f);
  const response = await request(
    f,
    "/api/connections",
    "GET",
    undefined,
    undefined,
    { DRIVE_ENABLED: "false" },
  );
  expect(response.status).toBe(200);
  const value = (await response.json()) as {
    connections: { id: string; kind: string }[];
    hasMore: boolean;
  };
  expect(value.connections).toHaveLength(2);
  expect(value.connections).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id, kind: "storage" }),
      expect.objectContaining({
        id: `mail-${f.current.tenant.userId}`,
        kind: "mailbox",
      }),
    ]),
  );
  expect(value.hasMore).toBe(false);
  expect(JSON.stringify(value)).not.toContain("synthetic-encrypted-token");
});
it("the connections collection cannot include another tenant's storage", async () => {
  const a = await fixture("storage-route-collection-a"),
    b = await fixture("storage-route-collection-b"),
    id = await storageConnection(a);
  const response = await request(b, "/api/connections");
  expect(response.status).toBe(200);
  const value = (await response.json()) as { connections: { id: string }[] };
  expect(value.connections.map((item) => item.id)).not.toContain(id);
  expect(value.connections.map((item) => item.id)).toEqual([
    `mail-${b.current.tenant.userId}`,
  ]);
});
