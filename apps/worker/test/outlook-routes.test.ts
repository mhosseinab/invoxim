import { env } from "cloudflare:workers";
import {
  createLoginAuth,
  encodeBase64url,
  loginConfiguration,
  outlookConfiguration,
} from "@invoxim/adapters";
import { mailboxStartResponseSchema } from "@invoxim/contracts";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createInvocationDatabase } from "../src/invocation-database";
import { owner } from "./onboarding-qa-fixture";

const db = env.DB;

const invocationCounts: number[] = [];

async function fixture(name: string) {
  const current = await owner(name, "legacy-google-mailbox");
  const bindings = {
    DB: env.DB,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://qa-outlook-route.example.invalid",
    AUTH_SECRET: "synthetic-outlook-route-signing-secret-never-live-12345",
    AUTH_GOOGLE_CLIENT_ID: "synthetic-google-login",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic-google-login-secret",
    AUTH_ALLOWED_EMAILS: JSON.stringify([current.loginEmail]),
    OUTLOOK_ENABLED: "true",
    OUTLOOK_CLIENT_ID: "11111111-2222-4333-8444-555555555555",
    OUTLOOK_CLIENT_SECRET: "synthetic-microsoft-secret",
    OUTLOOK_AUTHORITY: "common",
    CREDENTIAL_KEYRING: JSON.stringify({
      activeVersion: 1,
      keys: { 1: encodeBase64url(new Uint8Array(32).fill(7)) },
    }),
  };
  const login = loginConfiguration(bindings);
  if (!login || !outlookConfiguration(bindings))
    throw new Error(
      "Configured route positive control must validate before testing composition",
    );
  const context = await createLoginAuth(db, login).$context;
  const session = await context.internalAdapter.createSession(
    current.tenant.userId,
    false,
  );
  if (!session)
    throw new Error("Actual signed-session fixture was not created");
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
    new TextEncoder().encode(session.token),
  );
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
  return { current, bindings, login, cookie };
}

it("OUTLOOK-01 actual Worker serves configured Microsoft mailbox start to a signed Google-login session without reading mail", async () => {
  const { current, bindings, login, cookie } = await fixture(
    "qa-outlook-route-start",
  );
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(
      new Error("Unexpected remote request before mailbox callback"),
    );
  try {
    const meter = createInvocationDatabase(env.DB, 40);
    const response = await worker.fetch(
      new Request(`${login.origin}/api/connections/mailbox/outlook/start`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: login.origin,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      { ...bindings, DB: meter.db },
    );
    invocationCounts.push(meter.executedStatements());
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
    expect(fetch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const started = mailboxStartResponseSchema.parse(await response.json());
    const url = new URL(started.authorizationUrl);
    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${login.origin}/api/oauth/mailbox/outlook/callback`,
    );
    expect(url.searchParams.get("scope")?.split(" ")).toContain(
      "https://graph.microsoft.com/Mail.Read",
    );
    expect(
      await db
        .prepare(
          "SELECT provider,purpose FROM oauth_states WHERE user_id=? ORDER BY rowid DESC LIMIT 1",
        )
        .bind(current.tenant.userId)
        .first(),
    ).toEqual({ provider: "microsoft", purpose: "mailbox" });
    for (const table of ["jobs", "processing_consents", "source_messages"])
      expect(
        await db
          .prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`)
          .bind(current.tenant.userId)
          .first("n"),
      ).toBe(0);
  } finally {
    fetch.mockRestore();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  if (invocationCounts.length)
    console.log(
      JSON.stringify({
        case: "T17-native-route-queries",
        executedStatements: invocationCounts.splice(0),
      }),
    );
});
type RouteFixture = Awaited<ReturnType<typeof fixture>>;
async function request(
  f: RouteFixture,
  path: string,
  init: RequestInit = {},
  overrides: Partial<RouteFixture["bindings"]> = {},
) {
  const meter = createInvocationDatabase(env.DB, 40);
  const headers = new Headers({
    Cookie: f.cookie,
    Origin: f.login.origin,
    "Content-Type": "application/json",
  });
  for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  const response = await worker.fetch(
    new Request(f.login.origin + path, { ...init, headers }),
    { ...f.bindings, ...overrides, DB: meter.db },
  );
  invocationCounts.push(meter.executedStatements());
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response;
}
async function start(
  f: RouteFixture,
  provider = "outlook",
  extra: Record<string, string> = {},
) {
  const response = await request(
    f,
    `/api/connections/mailbox/${provider}/start`,
    { method: "POST", body: "{}" },
    extra,
  );
  expect(response.status).toBe(200);
  const url = new URL(
    mailboxStartResponseSchema.parse(await response.json()).authorizationUrl,
  );
  const state = url.searchParams.get("state"),
    nonce = url.searchParams.get("nonce");
  if (!state || !nonce)
    throw new Error("Actual authorization must issue both state and nonce");
  return { state, nonce };
}
async function signedTransport(
  f: RouteFixture,
  nonce: string,
  permission = true,
) {
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
    throw new Error("Synthetic RSA key pair was not generated");
  const tenant = "22222222-2222-4222-8222-222222222222",
    issuer = `https://login.microsoftonline.com/${tenant}/v2.0`,
    subject = "qa-outlook-immutable-subject-b";
  const encode = (value: unknown) =>
    encodeBase64url(new TextEncoder().encode(JSON.stringify(value)));
  const now = Math.floor(Date.now() / 1000);
  const message = `${encode({ alg: "RS256", kid: "qa-outlook-route-key", typ: "JWT" })}.${encode({ iss: issuer, tid: tenant, sub: subject, aud: f.bindings.OUTLOOK_CLIENT_ID, nonce, iat: now, exp: now + 3600, ver: "2.0" })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    generated.privateKey,
    new TextEncoder().encode(message),
  );
  const jwk = await crypto.subtle.exportKey("jwk", generated.publicKey);
  const urls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    expect(init?.redirect).toBe("manual");
    if (url === "https://login.microsoftonline.com/common/oauth2/v2.0/token")
      return Response.json({
        access_token: "synthetic-route-opaque-access",
        refresh_token: "synthetic-route-refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: permission
          ? "openid profile email https://graph.microsoft.com/Mail.Read"
          : "openid profile email",
        id_token: `${message}.${encodeBase64url(new Uint8Array(signature))}`,
      });
    if (url === "https://login.microsoftonline.com/common/discovery/v2.0/keys")
      return Response.json({
        keys: [
          {
            ...jwk,
            kid: "qa-outlook-route-key",
            alg: "RS256",
            use: "sig",
            issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
          },
        ],
      });
    if (url === "https://graph.microsoft.com/oidc/userinfo")
      return Response.json({
        sub: subject,
        email: "independent-mailbox-b@example.invalid",
      });
    throw new Error(
      "Synthetic callback transport refused any content or unapproved endpoint",
    );
  });
  return { urls, subject: `${issuer}|${subject}` };
}
function location(response: Response) {
  expect(response.status).toBe(302);
  const value = response.headers.get("location");
  if (!value) throw new Error("Actual callback must return a safe redirect");
  return new URL(value);
}
it("OUTLOOK-01 actual Worker rejects disabled provider, invalid actor/origin/body and unknown provider without outbound authorization", async () => {
  const f = await fixture("qa-outlook-route-denials");
  const remote = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(
      new Error("Unauthorized request cannot reach a provider"),
    );
  const path = "/api/connections/mailbox/outlook/start";
  expect(
    (
      await request(
        f,
        path,
        { method: "POST", body: "{}" },
        { OUTLOOK_ENABLED: "false" },
      )
    ).status,
  ).toBe(503);
  expect(
    (
      await request(f, path, {
        method: "POST",
        body: "{}",
        headers: { Cookie: "" },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request(f, path, {
        method: "POST",
        body: "{}",
        headers: { Origin: "https://attacker.example.invalid" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(f, path, {
        method: "POST",
        body: "{}",
        headers: { Origin: "" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(f, path, {
        method: "POST",
        body: JSON.stringify({ userId: "other", accessToken: "browser-token" }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(f, "/api/connections/mailbox/unknown/start", {
        method: "POST",
        body: "{}",
      })
    ).status,
  ).toBe(503);
  expect(remote).not.toHaveBeenCalled();
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM oauth_states WHERE user_id=?")
      .bind(f.current.tenant.userId)
      .first("n"),
  ).toBe(0);
});
it("OUTLOOK-01 actual signed Microsoft callback attaches independent Outlook B only to Google-login A, encrypted and awaiting Start", async () => {
  const f = await fixture("qa-outlook-route-callback");
  const intent = await start(f);
  const transport = await signedTransport(f, intent.nonce);
  const response = await request(
    f,
    `/api/oauth/mailbox/outlook/callback?state=${intent.state}&code=synthetic-code`,
  );
  const next = location(response);
  expect(next.origin).toBe(f.login.origin);
  expect(next.pathname).toBe("/onboarding/review");
  expect(next.searchParams.get("mailbox")).toBe("connected");
  const id = next.searchParams.get("connectionId");
  if (!id)
    throw new Error(
      "Successful callback must return the exact owned connection ID",
    );
  expect(
    await db
      .prepare(
        "SELECT id,user_id,provider,provider_subject,display_address,scheduling_state,scopes,credential_ciphertext FROM connections WHERE user_id=? AND id=?",
      )
      .bind(f.current.tenant.userId, id)
      .first(),
  ).toMatchObject({
    id,
    user_id: f.current.tenant.userId,
    provider: "outlook",
    provider_subject: transport.subject,
    display_address: "independent-mailbox-b@example.invalid",
    scheduling_state: "awaiting_import",
    credential_ciphertext: expect.not.stringContaining("synthetic-route"),
  });
  expect(transport.urls).toHaveLength(3);
  for (const table of ["jobs", "processing_consents", "source_messages"])
    expect(
      await db
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`)
        .bind(f.current.tenant.userId)
        .first("n"),
    ).toBe(0);
  const replay = location(
    await request(
      f,
      `/api/oauth/mailbox/outlook/callback?state=${intent.state}&code=synthetic-code`,
    ),
  );
  expect(replay.searchParams.get("mailbox")).toBe("unavailable");
  expect(transport.urls).toHaveLength(3);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM connections WHERE user_id=? AND provider='outlook'",
      )
      .bind(f.current.tenant.userId)
      .first("n"),
  ).toBe(1);
});
it("OUTLOOK-01 denied callback consumes one-use consent state without provider HTTP or mailbox attachment", async () => {
  const f = await fixture("qa-outlook-route-refusal");
  const intent = await start(f);
  const remote = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(
      new Error("Refused consent cannot exchange credentials"),
    );
  expect(
    location(
      await request(
        f,
        `/api/oauth/mailbox/outlook/callback?state=${intent.state}&error=access_denied`,
      ),
    ).searchParams.get("mailbox"),
  ).toBe("denied");
  expect(
    location(
      await request(
        f,
        `/api/oauth/mailbox/outlook/callback?state=${intent.state}&code=synthetic-code`,
      ),
    ).searchParams.get("mailbox"),
  ).toBe("unavailable");
  expect(remote).not.toHaveBeenCalled();
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM connections WHERE user_id=? AND provider='outlook'",
      )
      .bind(f.current.tenant.userId)
      .first("n"),
  ).toBe(0);
});
it.each([
  {
    name: "wrong nonce",
    nonce: "synthetic-wrong-nonce",
    permission: true,
    status: "account_mismatch",
    calls: 2,
  },
  {
    name: "partial Mail.Read grant",
    nonce: null,
    permission: false,
    status: "missing_permission",
    calls: 1,
  },
])(
  "OUTLOOK-01 actual callback rejects $name before mailbox persistence",
  async ({ name, nonce, permission, status, calls }) => {
    const f = await fixture(`qa-outlook-route-${name.replaceAll(" ", "-")}`);
    const intent = await start(f);
    const transport = await signedTransport(
      f,
      nonce ?? intent.nonce,
      permission,
    );
    expect(
      location(
        await request(
          f,
          `/api/oauth/mailbox/outlook/callback?state=${intent.state}&code=synthetic-code`,
        ),
      ).searchParams.get("mailbox"),
    ).toBe(status);
    expect(transport.urls).toHaveLength(calls);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) n FROM connections WHERE user_id=? AND provider='outlook'",
        )
        .bind(f.current.tenant.userId)
        .first("n"),
    ).toBe(0);
  },
);
it("OUTLOOK-01 actual Microsoft callback cannot consume Google mailbox state or call Microsoft's token endpoint", async () => {
  const f = await fixture("qa-outlook-route-provider-state");
  const intent = await start(f, "gmail", {
    GMAIL_ENABLED: "true",
    GMAIL_CLIENT_ID: "synthetic-gmail-client",
    GMAIL_CLIENT_SECRET: "synthetic-gmail-secret",
  });
  const remote = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(
      new Error("Wrong provider state cannot reach token exchange"),
    );
  expect(
    location(
      await request(
        f,
        `/api/oauth/mailbox/outlook/callback?state=${intent.state}&code=synthetic-code`,
      ),
    ).searchParams.get("mailbox"),
  ).toBe("unavailable");
  expect(remote).not.toHaveBeenCalled();
  expect(
    await db
      .prepare(
        "SELECT provider FROM oauth_states WHERE user_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .bind(f.current.tenant.userId)
      .first("provider"),
  ).toBe("google");
});
