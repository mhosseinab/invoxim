import { env } from "cloudflare:workers";
import type { AuthBindings, LoginConfiguration } from "@invoxim/adapters";
import { createLoginAuth } from "@invoxim/adapters";
import { beforeAll, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { requireFixture } from "../../../packages/testkit/src/fixture-value";
import {
  GOOGLE_TOKEN_ENDPOINT,
  generateSigningKeys,
  googleIdTokenClaims,
  googleTokenResponse,
  signIdToken,
} from "../../../packages/testkit/src/google-token";
import { createAuthRoutes } from "../src/auth-routes";

const db = env.DB;

const configuration: LoginConfiguration = {
  origin: "https://synthetic.example",
  secret: "synthetic-test-secret-never-use-in-production-123",
  googleClientId: "synthetic-client",
  googleClientSecret: "synthetic-client-secret",
  allowedEmails: ["a@example.invalid", "b@example.invalid"],
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
const app = createAuthRoutes();
const auth = createLoginAuth(db, configuration);
const cookies = new Map<string, string>();
beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
  const context = await auth.$context;
  for (const id of ["a", "b"]) {
    await db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)',
      )
      .bind(id, id, `${id}@example.invalid`, Date.now(), Date.now())
      .run();
    await db
      .prepare(
        "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
      )
      .bind(id, Date.now(), Date.now())
      .run();
    const session = await context.internalAdapter.createSession(id, false);
    if (!session) throw new Error("Synthetic session creation failed");
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
      new TextEncoder().encode(session.token),
    );
    const signed = encodeURIComponent(
      session.token +
        "." +
        btoa(String.fromCharCode(...new Uint8Array(signature))),
    );
    cookies.set(id, `__Secure-better-auth.session_token=${signed}`);
  }
});
it("AUTH-01 denies /me without a verified session", async () => {
  const response = await app.request(
    `${configuration.origin}/api/me`,
    {},
    bindings,
  );
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("AUTH-01 rejects unsigned cookie and identity headers", async () => {
  const response = await app.request(
    `${configuration.origin}/api/me?userId=b`,
    {
      headers: {
        "X-User-Id": "b",
        Cookie: "__Secure-better-auth.session_token=forged",
      },
    },
    bindings,
  );
  expect(response.status).toBe(401);
});
it("AUTH-01/05 verified live D1 sessions isolate two profiles despite forged request identity", async () => {
  for (const id of ["a", "b"]) {
    const response = await app.request(
      `${configuration.origin}/api/me?userId=other`,
      {
        headers: {
          Cookie: requireFixture(cookies.get(id)),
          "X-User-Id": "other",
        },
      },
      bindings,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      user: { email: `${id}@example.invalid` },
      settings: { version: 1 },
      capabilities: { mailProviders: [] },
      valuation: { status: "not_configured" },
    });
    expect(JSON.stringify(body)).not.toMatch(/session|token|secret/i);
  }
});
it("AUTH-03 strict tenant preferences are optimistic and reject body identity", async () => {
  const request = (body: unknown) =>
    app.request(
      `${configuration.origin}/api/me`,
      {
        method: "PATCH",
        headers: {
          Cookie: requireFixture(cookies.get("a")),
          Origin: configuration.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      bindings,
    );
  expect(
    (
      await request({
        version: 1,
        timezone: "Europe/Vienna",
        reportingCurrency: "EUR",
        userId: "b",
      })
    ).status,
  ).toBe(400);
  const updated = await request({
    version: 1,
    timezone: "Europe/Vienna",
    reportingCurrency: "EUR",
  });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({
    settings: { version: 2, timezone: "Europe/Vienna" },
  });
  expect(
    (await request({ version: 1, timezone: "UTC", reportingCurrency: "EUR" }))
      .status,
  ).toBe(409);
  const other = await app.request(
    `${configuration.origin}/api/me`,
    { headers: { Cookie: requireFixture(cookies.get("b")) } },
    bindings,
  );
  expect(await other.json()).toMatchObject({
    settings: { version: 1, timezone: "UTC" },
  });
});
it("AUTH-03 denies cross-origin preference mutation and sign-out", async () => {
  for (const path of ["/api/me", "/api/auth/sign-out"]) {
    const response = await app.request(
      configuration.origin + path,
      {
        method: path.endsWith("me") ? "PATCH" : "POST",
        headers: {
          Cookie: requireFixture(cookies.get("b")),
          Origin: "https://evil.invalid",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
      bindings,
    );
    expect(response.status).toBe(403);
  }
});
it("AUTH-05 library logout invalidates live session", async () => {
  const response = await app.request(
    `${configuration.origin}/api/auth/sign-out`,
    {
      method: "POST",
      headers: {
        Cookie: requireFixture(cookies.get("b")),
        Origin: configuration.origin,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    bindings,
  );
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie().join(";")).toMatch(/HttpOnly/i);
  expect(response.headers.getSetCookie().join(";")).toMatch(/Secure/i);
  expect(response.headers.getSetCookie().join(";")).toMatch(/SameSite=Lax/i);
  expect(response.headers.getSetCookie().join(";")).not.toMatch(/Domain=/i);
  expect(
    (
      await app.request(
        `${configuration.origin}/api/me`,
        { headers: { Cookie: requireFixture(cookies.get("b")) } },
        bindings,
      )
    ).status,
  ).toBe(401);
});
it("ONBOARD-01 login provisioning leaves mailbox, consent and job tables empty", async () => {
  for (const table of [
    "connections",
    "processing_consents",
    "import_runs",
    "jobs",
  ])
    expect(
      await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first("count"),
    ).toBe(0);
});
it("AUTH-04 login provider tokens are discarded on create and update", async () => {
  const context = await auth.$context;
  const user = await db
    .prepare('SELECT id FROM "user" WHERE email=?')
    .bind("a@example.invalid")
    .first<string>("id");
  if (!user) throw new Error("Synthetic owner missing");
  const account = await context.internalAdapter.createAccount({
    userId: user,
    providerId: "google",
    accountId: "synthetic-google-a",
    accessToken: "must-not-persist",
    refreshToken: "must-not-persist",
    idToken: "must-not-persist",
  });
  await context.internalAdapter.updateAccount(account.id, {
    accessToken: "new-must-not-persist",
    refreshToken: "new-must-not-persist",
    idToken: "new-must-not-persist",
  });
  const stored = await db
    .prepare(
      'SELECT accessToken,refreshToken,idToken FROM "account" WHERE id=?',
    )
    .bind(account.id)
    .first();
  expect(stored).toEqual({
    accessToken: null,
    refreshToken: null,
    idToken: null,
  });
});
it("AUTH-01 disabled default exposes no login authority", async () => {
  expect(
    (
      await app.request(`${configuration.origin}/api/auth/sign-in/social`, {
        method: "POST",
      })
    ).status,
  ).toBe(503);
  expect((await app.request(`${configuration.origin}/api/me`)).status).toBe(
    401,
  );
});
it("AUTH-03/04/05 ONBOARD-01 signed Google code callback verifies nonce and creates isolated identity without retained tokens", async () => {
  let tokenResponse: Record<string, unknown> | undefined;
  let certResponse: Record<string, unknown> | undefined;
  const fetched: string[] = [];
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      fetched.push(request.url);
      if (
        request.url === "https://www.googleapis.com/oauth2/v3/certs" &&
        request.method === "GET"
      )
        return Response.json(certResponse);
      if (
        request.url === GOOGLE_TOKEN_ENDPOINT &&
        request.method === "POST" &&
        tokenResponse
      )
        return Response.json(tokenResponse);
      throw new Error("Unexpected synthetic OAuth destination");
    });
  try {
    const { keys: keyPair } = await generateSigningKeys();
    const { privateKey, publicKey } = keyPair;
    const jwk = await crypto.subtle.exportKey("jwk", publicKey);
    certResponse = {
      keys: [{ ...jwk, kid: "synthetic-login", alg: "RS256", use: "sig" }],
    };
    const callbackBindings = {
      ...bindings,
      AUTH_ALLOWED_EMAILS: JSON.stringify([
        ...configuration.allowedEmails,
        "google-c@example.invalid",
      ]),
    };
    const start = await app.request(
      `${configuration.origin}/api/auth/sign-in/social`,
      {
        method: "POST",
        headers: {
          Origin: configuration.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "google", disableRedirect: true }),
      },
      callbackBindings,
    );
    expect(start.status).toBe(200);
    const started = (await start.json()) as {
      url: string;
    };
    const authorization = new URL(started.url);
    expect(authorization.searchParams.get("scope")?.split(" ").sort()).toEqual([
      "email",
      "openid",
      "profile",
    ]);
    expect(authorization.searchParams.has("include_granted_scopes")).toBe(
      false,
    );
    expect(authorization.searchParams.get("access_type")).toBe("online");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${configuration.origin}/api/auth/callback/google`,
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    const pending = await db
      .prepare('SELECT identifier,value FROM "verification"')
      .first<{
        identifier: string;
        value: string;
      }>();
    expect(pending).not.toBeNull();
    expect(requireFixture(pending).identifier).not.toContain(
      authorization.searchParams.get("state"),
    );
    expect(requireFixture(pending).value).not.toMatch(
      /codeVerifier|idTokenNonce|oauthState/,
    );
    const nonce = requireFixture(authorization.searchParams.get("nonce"));
    const signed = await signIdToken({
      claims: googleIdTokenClaims({
        sub: "google-subject-c",
        email: "google-c@example.invalid",
        name: "Synthetic C",
        nonce,
        aud: configuration.googleClientId,
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
      privateKey,
      kid: "synthetic-login",
    });
    tokenResponse = googleTokenResponse({
      access_token: "synthetic-transient-access",
      refresh_token: "synthetic-transient-refresh",
      expires_in: 300,
      id_token: signed.jwt,
    });
    const stateCookie = start.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const state = authorization.searchParams.get("state");
    const callback = await app.request(
      `${configuration.origin}/api/auth/callback/google?state=${encodeURIComponent(requireFixture(state))}&code=synthetic-code`,
      { headers: { Cookie: stateCookie } },
      callbackBindings,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(
      `${configuration.origin}/onboarding`,
    );
    const sessionCookie = callback.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(sessionCookie).toMatch(/__Secure-better-auth.session_token=/);
    const me = await app.request(
      `${configuration.origin}/api/me`,
      { headers: { Cookie: sessionCookie } },
      callbackBindings,
    );
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      user: { email: "google-c@example.invalid" },
    });
    expect(
      await db
        .prepare(
          'SELECT accessToken,refreshToken,idToken FROM "account" WHERE accountId=?',
        )
        .bind("google-subject-c")
        .first(),
    ).toEqual({ accessToken: null, refreshToken: null, idToken: null });
    for (const table of [
      "connections",
      "processing_consents",
      "import_runs",
      "jobs",
    ])
      expect(
        await db
          .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .first("count"),
      ).toBe(0);
    expect(fetched).toContain(GOOGLE_TOKEN_ENDPOINT);
    expect(fetched).toContain("https://www.googleapis.com/oauth2/v3/certs");
  } finally {
    network.mockRestore();
  }
});
