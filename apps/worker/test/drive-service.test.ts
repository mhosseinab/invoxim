import { env } from "cloudflare:workers";
import {
  createCredentialVault,
  createLoginAuth,
  createOAuthStateStore,
  createProfileService,
} from "@invoxim/adapters";
import type {
  ArchiveAuthorization,
  ArchiveAuthorizationPort,
  ArchiveSession,
} from "@invoxim/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { driveConfiguration } from "../../../packages/adapters/src/drive/configuration";
import { createDriveConnectionsRepository } from "../../../packages/adapters/src/drive/connections";
import { createDriveService } from "../../../packages/adapters/src/drive/service";
import { encodeBase64url } from "../../../packages/adapters/src/security/cipher";

const db = env.DB;

const bindings = {
  DB: env.DB,
  AUTH_ENABLED: "true",
  AUTH_ORIGIN: "https://synthetic.example",
  AUTH_SECRET: "synthetic-storage-session-secret-1234567890",
  AUTH_GOOGLE_CLIENT_ID: "synthetic-login.apps.googleusercontent.com",
  AUTH_GOOGLE_CLIENT_SECRET: "synthetic-login-secret",
  AUTH_ALLOWED_EMAILS: JSON.stringify(["login-a@example.test"]),
  DRIVE_ENABLED: "true",
  DRIVE_CLIENT_ID: "synthetic-drive.apps.googleusercontent.com",
  DRIVE_CLIENT_SECRET: "synthetic-drive-secret",
  CREDENTIAL_KEYRING: JSON.stringify({
    activeVersion: 1,
    keys: { "1": encodeBase64url(new Uint8Array(32).fill(5)) },
  }),
};
function configurationFixture() {
  const config = driveConfiguration(bindings);
  if (!config) throw new Error("Synthetic storage configuration unavailable");
  return config;
}
const configuration = configurationFixture();
let session: ArchiveSession;
const provider: ArchiveAuthorizationPort = {
  authorize: vi.fn(
    async (input) =>
      `https://accounts.google.com/o/oauth2/v2/auth?state=${input.state}`,
  ),
  exchange: vi.fn(
    async (): Promise<ArchiveAuthorization> => ({
      identity: {
        subject: "synthetic-drive-account-c",
        address: "drive-c@example.test",
      },
      credentials: {
        accessToken: "synthetic-drive-c-access",
        refreshToken: "synthetic-drive-c-refresh",
        expiresAt: Date.now() + 3600000,
      },
      canArchiveFiles: true,
    }),
  ),
  refresh: vi.fn(async (current) => current),
};
beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)",
    )
    .bind(
      "synthetic-storage-user-a",
      "Synthetic Login A",
      "login-a@example.test",
      Date.now(),
      Date.now(),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
    )
    .bind("synthetic-storage-user-a", Date.now(), Date.now())
    .run();
  const login = createLoginAuth(db, configuration.login);
  const context = await login.$context;
  const created = await context.internalAdapter.createSession(
    "synthetic-storage-user-a",
    false,
  );
  if (!created) throw new Error("Synthetic storage session unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(configuration.login.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(created.token),
  );
  const cookie =
    "__Secure-better-auth.session_token=" +
    encodeURIComponent(
      created.token +
        "." +
        btoa(String.fromCharCode(...new Uint8Array(signature))),
    );
  const current = await createProfileService(
    db,
    login,
    configuration.login,
  ).current(new Headers({ Cookie: cookie }));
  if (!current)
    throw new Error("Synthetic storage session verification failed");
  session = {
    tenant: current.tenant,
    sessionId: current.session.id,
    createdAtMs: current.session.createdAt.getTime(),
  };
});
async function hash(state: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
async function seededState() {
  const store = createOAuthStateStore(db, configuration.cipher, {
    callbacks: { storage: { google: configuration.callback } },
  });
  const state = await store.create(session.tenant, {
    sessionId: session.sessionId,
    purpose: "storage",
    provider: "google",
    pkceVerifier: "s".repeat(43),
  });
  await db
    .prepare(
      "INSERT INTO storage_oauth_intents(user_id,state_hash,connection_id,connection_generation,credential_version,archive_settings_version) VALUES(?,?,NULL,NULL,NULL,0)",
    )
    .bind(session.tenant.userId, await hash(state.state))
    .run();
  return state.state;
}
describe("T18 storage grant first proof", () => {
  it("starts one-use storage state bound to the authenticated workspace and independent Drive purpose", async () => {
    const started = await createDriveService(db, configuration, provider).start(
      session,
    );
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    if (!state) throw new Error("Synthetic storage state unavailable");
    const stored = await db
      .prepare(
        "SELECT user_id,session_id,purpose,provider,callback,pkce_ciphertext FROM oauth_states WHERE state_hash=?",
      )
      .bind(await hash(state))
      .first<{
        user_id: string;
        session_id: string;
        purpose: string;
        provider: string;
        callback: string;
        pkce_ciphertext: string;
      }>();
    expect(stored).toMatchObject({
      user_id: session.tenant.userId,
      session_id: session.sessionId,
      purpose: "storage",
      provider: "google",
      callback: configuration.callback,
    });
    expect(stored?.pkce_ciphertext).not.toContain("verifier");
    expect(
      (
        await db.prepare("SELECT COUNT(*) AS n FROM connections").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
  });
  it("completes Drive account C into login A with scoped encrypted credentials and no archive activation or jobs", async () => {
    const state = await seededState();
    const connection = await createDriveService(
      db,
      configuration,
      provider,
    ).complete(session, { state, code: "synthetic-drive-code" });
    expect(connection).toMatchObject({
      provider: "google-drive",
      kind: "storage",
      address: "drive-c@example.test",
      state: "connected",
      configured: true,
      generation: 1,
      credentialVersion: 1,
      archivingEnabled: false,
    });
    const stored = await db
      .prepare(
        "SELECT user_id,provider_subject,credential_ciphertext FROM connections WHERE user_id=? AND id=?",
      )
      .bind(session.tenant.userId, connection.id)
      .first<{
        user_id: string;
        provider_subject: string;
        credential_ciphertext: string;
      }>();
    expect(stored).toMatchObject({
      user_id: session.tenant.userId,
      provider_subject: "synthetic-drive-account-c",
    });
    expect(stored?.credential_ciphertext).not.toContain(
      "synthetic-drive-c-access",
    );
    const snapshot = await createCredentialVault(db, configuration.cipher).read(
      session.tenant,
      {
        kind: "connection",
        id: connection.id,
        generation: connection.generation,
      },
      connection.credentialVersion,
    );
    expect(snapshot?.secret).toMatchObject({
      accessToken: "synthetic-drive-c-access",
      refreshToken: "synthetic-drive-c-refresh",
    });
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM archive_settings WHERE enabled=1")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await db.prepare("SELECT COUNT(*) AS n FROM jobs").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
  });
});

it("local Drive unlink works without an OAuth provider or cipher constructor", async () => {
  const id = "synthetic-local-drive";
  const repository = createDriveConnectionsRepository(db);
  const before = await repository.list(session.tenant);
  const sealed = await configuration.cipher.seal(
    session.tenant,
    { entityId: id, purpose: "storage-credentials" },
    {
      accessToken: "synthetic-local-access",
      refreshToken: "synthetic-local-refresh",
      expiresAt: Date.now() + 60000,
    },
  );
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state,generation,credential_ciphertext,credential_key_version,credential_version) VALUES(?,?,'storage','google-drive','synthetic-local-subject','local-drive@example.test','connected',1,?,1,1)",
    )
    .bind(id, session.tenant.userId, sealed)
    .run();
  const listed = await repository.list(session.tenant);
  expect(listed.connections).toHaveLength(before.connections.length + 1);
  expect(listed.connections).toEqual(
    expect.arrayContaining([
      ...before.connections,
      expect.objectContaining({ id, configured: true }),
    ]),
  );
  await repository.disconnect(session, id, {
    generation: 1,
    credentialVersion: 1,
  });
  const row = await db
    .prepare(
      "SELECT state,generation,credential_version,credential_ciphertext FROM connections WHERE user_id=? AND id=?",
    )
    .bind(session.tenant.userId, id)
    .first();
  expect(row).toEqual({
    state: "disconnected",
    generation: 2,
    credential_version: 2,
    credential_ciphertext: null,
  });
});
