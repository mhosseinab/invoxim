import { expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { requireFixture } from "../../../packages/testkit/src/fixture-value";
import { createMailboxRoutes } from "../src/mailbox-routes";

it("AUTH-02/ONBOARD-02 mailbox consent requires a verified login session", async () => {
  const response = await createMailboxRoutes().request(
    "https://synthetic.example/api/connections/mailbox/gmail/start",
    {
      method: "POST",
      headers: {
        Origin: "https://synthetic.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  expect(response.status).toBe(401);
});
it("ONBOARD-02 callback cannot attach to an unauthenticated request", async () => {
  const response = await createMailboxRoutes().request(
    "https://synthetic.example/api/oauth/mailbox/gmail/callback?state=forged&code=forged",
  );
  expect(response.status).toBe(401);
});

import { env } from "cloudflare:workers";
import type { GmailBindings, LoginConfiguration } from "@invoxim/adapters";
import {
  createCredentialVault,
  createLoginAuth,
  createMailboxService,
  createProfileService,
  gmailConfiguration,
} from "@invoxim/adapters";
import type { MailboxAuthorizationPort, MailboxSession } from "@invoxim/core";
import { beforeAll, vi } from "vitest";

const db = env.DB;

const login: LoginConfiguration = {
  origin: "https://synthetic.example",
  secret: "synthetic-test-secret-never-use-in-production-123",
  googleClientId: "login-client",
  googleClientSecret: "login-secret",
  allowedEmails: ["login@example.invalid"],
};
const bindings: GmailBindings = {
  DB: env.DB,
  AUTH_ENABLED: "true",
  AUTH_ORIGIN: login.origin,
  AUTH_SECRET: login.secret,
  AUTH_GOOGLE_CLIENT_ID: login.googleClientId,
  AUTH_GOOGLE_CLIENT_SECRET: login.googleClientSecret,
  AUTH_ALLOWED_EMAILS: JSON.stringify(login.allowedEmails),
  GMAIL_ENABLED: "true",
  MAILBOX_LIMIT: "10",
  GMAIL_CLIENT_ID: "mail-client",
  GMAIL_CLIENT_SECRET: "mail-secret",
  CREDENTIAL_KEYRING: JSON.stringify({
    activeVersion: 1,
    keys: {
      1: btoa(String.fromCharCode(...new Uint8Array(32).fill(2)))
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_"),
    },
  }),
};
const configuration = requireFixture(gmailConfiguration(bindings));
let session: MailboxSession;
let cookie: string;
beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)",
    )
    .bind("login-A", "Login A", "login@example.invalid", Date.now(), Date.now())
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
    )
    .bind("login-A", Date.now(), Date.now())
    .run();
  const auth = createLoginAuth(db, login);
  const context = await auth.$context;
  const created = await context.internalAdapter.createSession("login-A", false);
  if (!created) throw new Error("Synthetic session unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(login.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(created.token),
  );
  cookie =
    "__Secure-better-auth.session_token=" +
    encodeURIComponent(
      created.token +
        "." +
        btoa(String.fromCharCode(...new Uint8Array(signed))),
    );
  const current = await createProfileService(db, auth, login).current(
    new Headers({ Cookie: cookie }),
  );
  if (!current) throw new Error("Synthetic session verification failed");
  session = {
    tenant: current.tenant,
    sessionId: current.session.id,
    createdAtMs: current.session.createdAt.getTime(),
  };
});
function provider(subject: string): MailboxAuthorizationPort {
  return {
    authorize: async (input) =>
      `https://accounts.google.com/o/oauth2/v2/auth?state=${input.state}`,
    exchange: async () => ({
      identity: { subject, address: `${subject}@example.invalid` },
      credentials: {
        accessToken: `synthetic-${subject}-access`,
        refreshToken: `synthetic-${subject}-refresh`,
        expiresAt: Date.now() + 300000,
      },
      canReadMessages: true,
    }),
    refresh: async (credentials) => ({
      ...credentials,
      accessToken: "synthetic-refreshed",
    }),
  };
}
async function connect(subject: string) {
  const service = createMailboxService(db, configuration, provider(subject));
  const started = await service.start(session);
  return {
    service,
    connection: await service.complete(session, {
      state: requireFixture(
        new URL(started.authorizationUrl).searchParams.get("state"),
      ),
      code: "synthetic-code",
    }),
  };
}
it("GMAIL-04/ONBOARD-02 login A connects independent mailbox B and C awaiting import with encrypted credentials and no jobs", async () => {
  const b = await connect("mailbox-b");
  const c = await connect("mailbox-c");
  expect(b.connection.address).toBe("mailbox-b@example.invalid");
  expect(c.connection.address).toBe("mailbox-c@example.invalid");
  expect(b.connection.schedulingState).toBe("awaiting_import");
  expect(c.connection.schedulingState).toBe("awaiting_import");
  const stored = await db
    .prepare("SELECT credential_ciphertext,user_id FROM connections WHERE id=?")
    .bind(b.connection.id)
    .first<{
      credential_ciphertext: string;
      user_id: string;
    }>();
  expect(stored?.user_id).toBe("login-A");
  expect(stored?.credential_ciphertext).not.toContain("synthetic-mailbox-b");
  expect((await b.service.list(session.tenant)).connections).toHaveLength(2);
  const jobs = await db
    .prepare("SELECT COUNT(*) AS n FROM processing_consents")
    .first<{
      n: number;
    }>();
  expect(jobs?.n).toBe(0);
  const before = await db
    .prepare("SELECT COUNT(*) AS n FROM source_messages")
    .first<{
      n: number;
    }>();
  expect(before?.n).toBe(0);
});
it("SECRETS-04 refresh serializes before provider HTTP and preserves omitted rotated refresh token via the provider contract", async () => {
  const { connection } = await connect("refresh-box");
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const transport = provider("refresh-box");
  transport.refresh = vi.fn(async (credentials) => {
    release();
    await wait;
    return { ...credentials, accessToken: "synthetic-new-access" };
  });
  const service = createMailboxService(db, configuration, transport);
  const first = service.refresh(session.tenant, connection.id);
  await entered;
  await expect(
    service.refresh(session.tenant, connection.id),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  finish();
  const updated = await first;
  expect(transport.refresh).toHaveBeenCalledTimes(1);
  expect(updated.credentialVersion).toBe(connection.credentialVersion + 1);
  const snapshot = await createCredentialVault(db, configuration.cipher).read(
    session.tenant,
    {
      kind: "connection",
      id: connection.id,
      generation: connection.generation,
    },
  );
  expect(snapshot?.secret).toMatchObject({
    accessToken: "synthetic-new-access",
    refreshToken: "synthetic-refresh-box-refresh",
  });
});
it("GMAIL-04 local disconnect fences credentials, retains source records, and accepts only exact replay", async () => {
  const { service, connection } = await connect("disconnect-box");
  await service.disconnect(session, connection.id, {
    generation: connection.generation,
    credentialVersion: connection.credentialVersion,
  });
  await service.disconnect(session, connection.id, {
    generation: connection.generation,
    credentialVersion: connection.credentialVersion,
  });
  const stored = await db
    .prepare(
      "SELECT state,generation,credential_version,credential_ciphertext FROM connections WHERE id=?",
    )
    .bind(connection.id)
    .first();
  expect(stored).toMatchObject({
    state: "disconnected",
    generation: 2,
    credential_version: 2,
    credential_ciphertext: null,
  });
  await expect(
    service.disconnect(session, connection.id, {
      generation: 9,
      credentialVersion: 9,
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});
