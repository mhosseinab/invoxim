import { env } from "cloudflare:workers";
import type {
  MailboxAuthorizationPort,
  MailboxSession,
  TenantContext,
} from "@invoxim/core";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import {
  GMAIL_AUTHORIZATION_SCOPES,
  type GmailBindings,
  type GmailConfiguration,
} from "../../../packages/adapters/src/mailbox/configuration";
import { createGmailAuthorization } from "../../../packages/adapters/src/mailbox/gmail";
import { createMailboxService } from "../../../packages/adapters/src/mailbox/service";
import {
  createCredentialCipher,
  encodeBase64url,
} from "../../../packages/adapters/src/security/cipher";
import { createMailboxRoutes } from "../src/mailbox-routes";

const db = env.DB;

const authorization = () =>
  createGmailAuthorization({
    clientId: "synthetic-mail-client",
    clientSecret: "synthetic-mail-client-secret",
  });
const requiredScopes =
  "openid email profile https://www.googleapis.com/auth/gmail.readonly";
const current = {
  accessToken: "synthetic-old-access",
  refreshToken: "synthetic-old-refresh",
  expiresAt: 0,
};
const expectedIdentity = {
  subject: "mailbox-subject-b",
  address: "mailbox-b@example.invalid",
};
afterEach(() => vi.restoreAllMocks());
function provider(
  token: unknown,
  identity: unknown = {
    sub: expectedIdentity.subject,
    email: expectedIdentity.address,
    email_verified: true,
  },
  status = 200,
  jwks?: unknown,
  beforeToken?: () => Promise<void>,
) {
  const requests: { url: string; method: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    requests.push({ url, method });
    if (
      url === "https://www.googleapis.com/oauth2/v3/certs" &&
      method === "GET" &&
      jwks
    )
      return Response.json(jwks);
    if (url === "https://oauth2.googleapis.com/token" && method === "POST") {
      await beforeToken?.();
      return Response.json(token, { status });
    }
    if (
      url === "https://openidconnect.googleapis.com/v1/userinfo" &&
      method === "GET"
    )
      return Response.json(identity);
    throw new Error("Synthetic transport rejected unexpected destination");
  });
  return requests;
}
function token(extra: Record<string, unknown> = {}) {
  return {
    access_token: "synthetic-new-access",
    expires_in: 3600,
    token_type: "Bearer",
    scope: requiredScopes,
    ...extra,
  };
}

it.each([
  "openid email profile",
  `${requiredScopes} https://www.googleapis.com/auth/gmail.modify`,
])(
  "partial or broader granted scope cannot authorize mailbox read (%s)",
  async (scope) => {
    const requests = provider(
      token({
        scope,
        refresh_token: "synthetic-refresh",
        id_token: "synthetic-unverified-placeholder",
      }),
    );
    await expect(
      authorization().exchange({
        code: "synthetic-code",
        verifier: "synthetic-verifier",
        nonce: "synthetic-nonce",
        callback: "https://synthetic.example/api/oauth/mailbox/gmail/callback",
      }),
    ).rejects.toMatchObject({ code: "MISSING_PERMISSION" });
    expect(requests).toEqual([
      { url: "https://oauth2.googleapis.com/token", method: "POST" },
    ]);
  },
);
it("refresh rejects another provider subject without accepting replacement credentials", async () => {
  provider(token(), {
    sub: "wrong-subject",
    email: "wrong@example.invalid",
    email_verified: true,
  });
  await expect(
    authorization().refresh(current, expectedIdentity),
  ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  expect(current.refreshToken).toBe("synthetic-old-refresh");
});
it("invalid_grant is a controlled reconnect result with no provider detail reflected", async () => {
  provider(
    {
      error: "invalid_grant",
      error_description: "synthetic-sensitive-provider-detail",
    },
    undefined,
    400,
  );
  await expect(
    authorization().refresh(current, expectedIdentity),
  ).rejects.toMatchObject({
    code: "RECONNECT_REQUIRED",
    message: "RECONNECT_REQUIRED",
  });
});
it("a successful refresh retains omitted refresh tokens and only visits control-plane endpoints", async () => {
  const requests = provider(token());
  const result = await authorization().refresh(current, expectedIdentity);
  expect(result).toMatchObject({
    accessToken: "synthetic-new-access",
    refreshToken: "synthetic-old-refresh",
  });
  expect(result.expiresAt).toBeGreaterThan(Date.now());
  expect(requests).toEqual([
    { url: "https://oauth2.googleapis.com/token", method: "POST" },
    { url: "https://openidconnect.googleapis.com/v1/userinfo", method: "GET" },
  ]);
});
it("oversized provider JSON fails before accepting credentials", async () => {
  provider(token({ padding: "x".repeat(65537) }));
  await expect(
    authorization().refresh(current, expectedIdentity),
  ).rejects.toMatchObject({ code: "UNAVAILABLE", message: "UNAVAILABLE" });
});

const configuration: GmailConfiguration = {
  provider: "gmail",
  oauthProvider: "google",
  scopes: GMAIL_AUTHORIZATION_SCOPES,
  login: {
    origin: "https://synthetic.example",
    secret: "synthetic-mail-qa-login-secret-never-production",
    googleClientId: "synthetic-login-client",
    googleClientSecret: "synthetic-login-secret",
    allowedEmails: [
      "mail-owner-a@example.invalid",
      "mail-owner-z@example.invalid",
      "mail-signed-a@example.invalid",
      "mail-race-a@example.invalid",
      "mail-expire-a@example.invalid",
    ],
  },
  clientId: "synthetic-mail-client",
  clientSecret: "synthetic-mail-client-secret",
  limit: 3,
  callback: "https://synthetic.example/api/oauth/mailbox/gmail/callback",
  cipher: createCredentialCipher({
    activeVersion: 1,
    keys: { 1: encodeBase64url(new Uint8Array(32).fill(9)) },
  }),
};
beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
  for (const user of [
    "mail-owner-a",
    "mail-owner-z",
    "mail-signed-a",
    "mail-race-a",
    "mail-expire-a",
  ]) {
    await db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
      )
      .bind(user, user, `${user}@example.invalid`)
      .run();
    await db
      .prepare(
        "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
      )
      .bind(user)
      .run();
    await db
      .prepare(
        "INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        `session-${user}`,
        user,
        `synthetic-token-${user}`,
        Date.now() + 3600000,
        Date.now(),
        Date.now(),
      )
      .run();
  }
});
function session(user = "mail-owner-a"): MailboxSession {
  return {
    tenant: { userId: user, authority: "session" } as TenantContext,
    sessionId: `session-${user}`,
    createdAtMs: Date.now(),
  };
}
function verifiedProvider(
  subject = "mailbox-subject-b",
  address = "mailbox-b@example.invalid",
): MailboxAuthorizationPort {
  return {
    async authorize(input) {
      return `https://accounts.google.com/o/oauth2/v2/auth?state=${input.state}&nonce=${input.nonce}`;
    },
    async exchange() {
      return {
        identity: { subject, address },
        credentials: {
          accessToken: "synthetic-access",
          refreshToken: "synthetic-refresh",
          expiresAt: Date.now() + 3600000,
        },
        canReadMessages: true,
      };
    },
    async refresh(credentials) {
      return {
        ...credentials,
        accessToken: "synthetic-refreshed",
        expiresAt: Date.now() + 3600000,
      };
    },
  };
}
async function connect(
  service: ReturnType<typeof createMailboxService>,
  owner: MailboxSession,
  connectionId?: string,
) {
  const start = await service.start(owner, connectionId);
  return service.complete(owner, {
    state: new URL(start.authorizationUrl).searchParams.get("state") ?? "",
    code: "synthetic-code",
  });
}

it("independent mailbox B is stored only in login A workspace and remains awaiting explicit Start", async () => {
  const service = createMailboxService(db, configuration, verifiedProvider());
  const connected = await connect(service, session());
  expect(connected).toMatchObject({
    address: "mailbox-b@example.invalid",
    state: "connected",
    schedulingState: "awaiting_import",
    configured: true,
  });
  expect(
    (await service.list(session("mail-owner-z").tenant)).connections,
  ).toEqual([]);
  const stored = await db
    .prepare("SELECT user_id,credential_ciphertext FROM connections WHERE id=?")
    .bind(connected.id)
    .first<{ user_id: string; credential_ciphertext: string }>();
  expect(stored?.user_id).toBe("mail-owner-a");
  expect(stored?.credential_ciphertext).not.toContain("synthetic-refresh");
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jobs").first("count"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM source_messages")
      .first("count"),
  ).toBe(0);
});

it("disconnected mailbox reactivation cannot bypass the configured connection cap", async () => {
  const owner = session("mail-owner-z");
  const firstService = createMailboxService(
    db,
    { ...configuration, limit: 1 },
    verifiedProvider("cap-first", "first@example.invalid"),
  );
  const first = await connect(firstService, owner);
  await firstService.disconnect(owner, first.id, {
    generation: first.generation,
    credentialVersion: first.credentialVersion,
  });
  const otherService = createMailboxService(
    db,
    { ...configuration, limit: 1 },
    verifiedProvider("cap-second", "second@example.invalid"),
  );
  await connect(otherService, owner);
  await expect(connect(firstService, owner, first.id)).rejects.toMatchObject({
    code: "LIMIT_REACHED",
  });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM connections WHERE user_id=? AND state='connected'",
      )
      .bind(owner.tenant.userId)
      .first("count"),
  ).toBe(1);
});

function encoded(value: unknown) {
  return encodeBase64url(new TextEncoder().encode(JSON.stringify(value)));
}
let signingKeys: CryptoKeyPair | undefined;
async function signedIdentity(
  nonce: string,
  extra: Record<string, unknown> = {},
) {
  if (!signingKeys) {
    const generated = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    if (!("privateKey" in generated))
      throw new Error("Synthetic signing key unavailable");
    signingKeys = generated;
  }
  const claims = {
    iss: "https://accounts.google.com",
    aud: configuration.clientId,
    sub: "signed-mailbox-b",
    email: "signed-mailbox-b@example.invalid",
    email_verified: true,
    nonce,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...extra,
  };
  const message = `${encoded({ alg: "RS256", kid: "synthetic-mail-qa", typ: "JWT" })}.${encoded(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKeys.privateKey,
    new TextEncoder().encode(message),
  );
  const jwk = await crypto.subtle.exportKey("jwk", signingKeys.publicKey);
  return {
    jwt: `${message}.${encodeBase64url(new Uint8Array(signature))}`,
    jwks: {
      keys: [{ ...jwk, kid: "synthetic-mail-qa", alg: "RS256", use: "sig" }],
    },
    claims,
  };
}
const routeBindings: GmailBindings = {
  DB: env.DB,
  AUTH_ENABLED: "true",
  AUTH_ORIGIN: configuration.login.origin,
  AUTH_SECRET: configuration.login.secret,
  AUTH_GOOGLE_CLIENT_ID: configuration.login.googleClientId,
  AUTH_GOOGLE_CLIENT_SECRET: configuration.login.googleClientSecret,
  AUTH_ALLOWED_EMAILS: JSON.stringify(configuration.login.allowedEmails),
  GMAIL_ENABLED: "true",
  GMAIL_CLIENT_ID: configuration.clientId,
  GMAIL_CLIENT_SECRET: configuration.clientSecret,
  CREDENTIAL_KEYRING: JSON.stringify({
    activeVersion: 1,
    keys: { 1: encodeBase64url(new Uint8Array(32).fill(9)) },
  }),
};
async function signedCookie(user: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(configuration.login.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const raw = `synthetic-token-${user}`;
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(raw),
  );
  return `__Secure-better-auth.session_token=${encodeURIComponent(`${raw}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`)}`;
}
async function routeStart(user = "mail-signed-a", body: unknown = {}) {
  const cookie = await signedCookie(user);
  const response = await createMailboxRoutes().request(
    `${configuration.login.origin}/api/connections/mailbox/gmail/start`,
    {
      method: "POST",
      headers: {
        cookie,
        Origin: configuration.login.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    routeBindings,
  );
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { authorizationUrl: string };
  return { url: new URL(payload.authorizationUrl), cookie };
}
async function routeCallback(
  start: Awaited<ReturnType<typeof routeStart>>,
  code = "synthetic-code",
) {
  return createMailboxRoutes().request(
    `${configuration.callback}?state=${start.url.searchParams.get("state")}&code=${code}`,
    { headers: { cookie: start.cookie } },
    routeBindings,
  );
}

it("actual signed Google mailbox callback binds B to login A and state replay cannot modify credentials", async () => {
  const start = await routeStart();
  const signed = await signedIdentity(
    start.url.searchParams.get("nonce") ?? "",
  );
  const requests = provider(
    token({ id_token: signed.jwt, refresh_token: "synthetic-signed-refresh" }),
    {
      sub: signed.claims.sub,
      email: signed.claims.email,
      email_verified: true,
    },
    200,
    signed.jwks,
  );
  const response = await routeCallback(start);
  expect(response.status).toBe(302);
  const redirect = new URL(response.headers.get("location") ?? "");
  expect(redirect.origin + redirect.pathname).toBe(
    "https://synthetic.example/onboarding/review",
  );
  expect(redirect.searchParams.get("mailbox")).toBe("connected");
  const row = await db
    .prepare(
      "SELECT id,user_id,scheduling_state,credential_version,credential_ciphertext FROM connections WHERE provider_subject='signed-mailbox-b'",
    )
    .first<{
      id: string;
      user_id: string;
      scheduling_state: string;
      credential_version: number;
      credential_ciphertext: string;
    }>();
  expect(row).toMatchObject({
    user_id: "mail-signed-a",
    scheduling_state: "awaiting_import",
    credential_version: 1,
  });
  expect(redirect.searchParams.get("connectionId")).toBe(row?.id);
  expect(row?.credential_ciphertext).not.toContain("synthetic-signed-refresh");
  const replay = await routeCallback(start);
  expect(replay.headers.get("location")).toBe(
    "https://synthetic.example/onboarding/review?mailbox=unavailable",
  );
  expect(
    await db
      .prepare(
        "SELECT credential_version FROM connections WHERE provider_subject='signed-mailbox-b'",
      )
      .first("credential_version"),
  ).toBe(1);
  expect(
    requests.every((request) =>
      [
        "https://oauth2.googleapis.com/token",
        "https://www.googleapis.com/oauth2/v3/certs",
        "https://openidconnect.googleapis.com/v1/userinfo",
      ].includes(request.url),
    ),
  ).toBe(true);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM source_messages")
      .first("count"),
  ).toBe(0);
});
it.each([
  ["nonce", { nonce: "wrong-nonce" }],
  ["audience", { aud: "wrong-client" }],
  ["issuer", { iss: "https://wrong.invalid" }],
  ["expiry", { exp: 1 }],
  ["email verification", { email_verified: false }],
] as const)(
  "signed mailbox identity with invalid %s cannot create a connection",
  async (_name, extra) => {
    const start = await routeStart();
    const signed = await signedIdentity(
      start.url.searchParams.get("nonce") ?? "",
      extra,
    );
    provider(
      token({
        id_token: signed.jwt,
        refresh_token: "synthetic-sensitive-refresh",
      }),
      {
        sub: signed.claims.sub,
        email: signed.claims.email,
        email_verified: true,
      },
      200,
      signed.jwks,
    );
    const before = await db
      .prepare("SELECT COUNT(*) AS count FROM connections")
      .first("count");
    const response = await routeCallback(start);
    expect(response.headers.get("location")).not.toBe(
      "https://synthetic.example/onboarding/review?mailbox=connected",
    );
    expect(response.headers.get("location")).not.toContain(
      "synthetic-sensitive-refresh",
    );
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM connections")
        .first("count"),
    ).toBe(before);
  },
);

it("session expiry during signed token exchange prevents connection persistence", async () => {
  const start = await routeStart("mail-expire-a");
  const signed = await signedIdentity(
    start.url.searchParams.get("nonce") ?? "",
    { sub: "expired-mailbox", email: "expired-mailbox@example.invalid" },
  );
  provider(
    token({ id_token: signed.jwt, refresh_token: "synthetic-expired-refresh" }),
    {
      sub: signed.claims.sub,
      email: signed.claims.email,
      email_verified: true,
    },
    200,
    signed.jwks,
    async () => {
      await db
        .prepare(
          "UPDATE session SET expiresAt=0 WHERE id='session-mail-expire-a'",
        )
        .run();
    },
  );
  const response = await routeCallback(start);
  expect(
    new URL(response.headers.get("location") ?? "").searchParams.get("mailbox"),
  ).toBe("unavailable");
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM connections WHERE user_id='mail-expire-a'",
      )
      .first("count"),
  ).toBe(0);
});

it("wrong-account reconnect cannot overwrite accepted credentials", async () => {
  const original = await db
    .prepare(
      "SELECT id,credential_version,credential_ciphertext FROM connections WHERE user_id='mail-owner-a' AND provider_subject='mailbox-subject-b'",
    )
    .first<{
      id: string;
      credential_version: number;
      credential_ciphertext: string;
    }>();
  if (!original) throw new Error("Missing original synthetic connection");
  const wrong = createMailboxService(
    db,
    configuration,
    verifiedProvider("wrong-reconnect-subject", "wrong@example.invalid"),
  );
  await expect(connect(wrong, session(), original.id)).rejects.toMatchObject({
    code: "ACCOUNT_MISMATCH",
  });
  expect(
    await db
      .prepare(
        "SELECT credential_version,credential_ciphertext FROM connections WHERE id=?",
      )
      .bind(original.id)
      .first(),
  ).toEqual({
    credential_version: original.credential_version,
    credential_ciphertext: original.credential_ciphertext,
  });
});
it("same-account reconnect can preserve an omitted existing refresh token", async () => {
  const original = await db
    .prepare(
      "SELECT id FROM connections WHERE user_id='mail-owner-a' AND provider_subject='mailbox-subject-b'",
    )
    .first<{ id: string }>();
  if (!original) throw new Error("Missing connection");
  const providerWithoutRefresh = verifiedProvider();
  providerWithoutRefresh.exchange = async () => ({
    identity: expectedIdentity,
    credentials: {
      accessToken: "synthetic-reconnect-access",
      expiresAt: Date.now() + 3600000,
    },
    canReadMessages: true,
  });
  const service = createMailboxService(
    db,
    configuration,
    providerWithoutRefresh,
  );
  const connected = await connect(service, session(), original.id);
  expect(connected.schedulingState).toBe("awaiting_import");
  const ciphertext = await db
    .prepare("SELECT credential_ciphertext FROM connections WHERE id=?")
    .bind(original.id)
    .first<string>("credential_ciphertext");
  if (!ciphertext) throw new Error("Missing envelope");
  expect(
    await configuration.cipher.open(
      session().tenant,
      { entityId: original.id, purpose: "mailbox-credentials" },
      ciphertext,
    ),
  ).toMatchObject({
    accessToken: "synthetic-reconnect-access",
    refreshToken: "synthetic-refresh",
  });
});
it("fresh mailbox authorization without refresh token leaves no connection", async () => {
  const missing = verifiedProvider(
    "no-refresh-subject",
    "no-refresh@example.invalid",
  );
  missing.exchange = async () => ({
    identity: {
      subject: "no-refresh-subject",
      address: "no-refresh@example.invalid",
    },
    credentials: {
      accessToken: "synthetic-access",
      expiresAt: Date.now() + 3600000,
    },
    canReadMessages: true,
  });
  await expect(
    connect(createMailboxService(db, configuration, missing), session()),
  ).rejects.toMatchObject({ code: "MISSING_REFRESH_TOKEN" });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM connections WHERE provider_subject='no-refresh-subject'",
      )
      .first("count"),
  ).toBe(0);
});
it("concurrent refresh and disconnect cannot resurrect cleared credentials", async () => {
  const owner = session("mail-race-a");
  const verified = verifiedProvider("race-subject", "race@example.invalid");
  let enteredResolve: () => void = () => {};
  let releaseResolve: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  verified.refresh = async (credentials) => {
    enteredResolve();
    await release;
    return {
      ...credentials,
      accessToken: "synthetic-stale-access",
      expiresAt: Date.now() + 3600000,
    };
  };
  const service = createMailboxService(db, configuration, verified);
  const connection = await connect(service, owner);
  const inFlight = service.refresh(owner.tenant, connection.id);
  // Attach the rejection assertion before releasing the deliberately suspended provider response.
  const outcome = expect(inFlight).rejects.toMatchObject({ code: "CONFLICT" });
  await entered;
  await expect(
    service.refresh(owner.tenant, connection.id),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await service.disconnect(owner, connection.id, {
    generation: connection.generation,
    credentialVersion: connection.credentialVersion,
  });
  releaseResolve();
  await outcome;
  expect(
    await db
      .prepare(
        "SELECT state,generation,credential_version,credential_ciphertext,credential_key_version FROM connections WHERE id=?",
      )
      .bind(connection.id)
      .first(),
  ).toEqual({
    state: "disconnected",
    generation: 2,
    credential_version: 2,
    credential_ciphertext: null,
    credential_key_version: null,
  });
});

it("mailbox intent cannot contain a connection without nonnull generation and version", async () => {
  const owner = session();
  const service = createMailboxService(db, configuration, verifiedProvider());
  const start = await service.start(owner);
  const state = start.authorizationUrl.split("state=")[1]?.split("&")[0];
  if (!state) throw new Error("Missing synthetic state");
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const original = await db
    .prepare("SELECT id FROM connections WHERE user_id=? LIMIT 1")
    .bind(owner.tenant.userId)
    .first<{ id: string }>();
  if (!original) throw new Error("Missing connection");
  await expect(
    db
      .prepare(
        "UPDATE mailbox_oauth_intents SET connection_id=?,connection_generation=NULL,credential_version=NULL WHERE user_id=? AND state_hash=?",
      )
      .bind(original.id, owner.tenant.userId, hash)
      .run(),
  ).rejects.toThrow();
});
it("public mailbox service strips unexpected driver data from errors", async () => {
  const secret = "synthetic-sensitive-driver-detail";
  const failing = {
    prepare() {
      throw new Error(secret);
    },
  } as unknown as D1Database;
  const service = createMailboxService(
    failing,
    configuration,
    verifiedProvider(),
  );
  try {
    await service.list(session().tenant);
    throw new Error("Expected service rejection");
  } catch (cause) {
    expect(cause).toMatchObject({
      code: "UNAVAILABLE",
      message: "UNAVAILABLE",
    });
    expect(String(cause)).not.toContain(secret);
    if (cause instanceof Error) expect(cause.stack).not.toContain(secret);
    expect(JSON.stringify(cause)).not.toContain(secret);
  }
});

it("disconnect after credential reread prevents the pending provider refresh call", async () => {
  const owner = session("mail-race-a");
  const attempts: string[] = [];
  const verified = verifiedProvider(
    "checkpoint-subject",
    "checkpoint@example.invalid",
  );
  verified.refresh = async (credentials) => {
    attempts.push(credentials.refreshToken ?? "");
    return {
      ...credentials,
      accessToken: "synthetic-disallowed-stale-refresh",
      expiresAt: Date.now() + 3600000,
    };
  };
  const original = createMailboxService(db, configuration, verified);
  const connection = await connect(original, owner);
  let enteredResolve: () => void = () => {};
  let releaseResolve: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
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
          return async (...args: unknown[]) => {
            const column = args[0];
            const result =
              typeof column === "string"
                ? await target.first(column)
                : await target.first();
            if (
              sql.startsWith("SELECT id,provider,provider_subject") &&
              ++reads === 2
            ) {
              enteredResolve();
              await release;
            }
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const delayed = new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const pending = createMailboxService(
    delayed,
    configuration,
    verified,
  ).refresh(owner.tenant, connection.id);
  const rejected = expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
  await entered;
  expect(reads).toBe(2);
  await original.disconnect(owner, connection.id, {
    generation: connection.generation,
    credentialVersion: connection.credentialVersion,
  });
  releaseResolve();
  await rejected;
  expect(attempts).toEqual([]);
  expect(
    await db
      .prepare("SELECT state,credential_ciphertext FROM connections WHERE id=?")
      .bind(connection.id)
      .first(),
  ).toEqual({ state: "disconnected", credential_ciphertext: null });
});
