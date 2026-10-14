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

const names = [
  "auth-a",
  "auth-b",
  "auth-expired",
  "auth-deleting",
  "auth-removed",
];
const configuration: LoginConfiguration = {
  origin: "https://synthetic.example",
  secret: "synthetic-adversarial-secret-never-production-123",
  googleClientId: "synthetic-client",
  googleClientSecret: "synthetic-client-secret",
  allowedEmails: names.map((name) => `${name}@example.invalid`),
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
const syntheticSessions = new Map<
  string,
  {
    cookie: string;
    token: string;
    userId: string;
  }
>();
beforeAll(async () => {
  for (const sql of [baseline]) {
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
  }
  // Library-internal synthetic provisioning proves session lookup, not Google callback completion.
  const auth = createLoginAuth(db, configuration);
  const context = await auth.$context;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(configuration.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  for (const name of names) {
    await db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
      )
      .bind(name, name, `${name}@example.invalid`)
      .run();
    await db
      .prepare(
        "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
      )
      .bind(name)
      .run();
    const session = await context.internalAdapter.createSession(name, false);
    if (!session) throw new Error("Synthetic session unavailable");
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(session.token),
    );
    const signed = encodeURIComponent(
      `${session.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`,
    );
    syntheticSessions.set(name, {
      cookie: `__Secure-better-auth.session_token=${signed}`,
      token: session.token,
      userId: name,
    });
  }
});
let googleKeys: CryptoKeyPair | undefined;
async function syntheticGoogle(extraAllowedEmails: string[] = []) {
  if (!googleKeys) {
    const generated = await generateSigningKeys();
    googleKeys = generated.keys;
  }
  const pair = googleKeys;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const tokens = new Map<string, string>();
  let exchangedVerifier: string | undefined;
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (
        request.url === "https://www.googleapis.com/oauth2/v3/certs" &&
        request.method === "GET"
      )
        return Response.json({
          keys: [
            { ...jwk, kid: "qa-synthetic-google", alg: "RS256", use: "sig" },
          ],
        });
      if (request.url === GOOGLE_TOKEN_ENDPOINT && request.method === "POST") {
        const form = await request.formData();
        const code = form.get("code");
        const verifier = form.get("code_verifier");
        exchangedVerifier = typeof verifier === "string" ? verifier : undefined;
        const token = typeof code === "string" ? tokens.get(code) : null;
        if (!token) throw new Error("Synthetic transport denied");
        return Response.json(
          googleTokenResponse({
            access_token: "synthetic-transient-access",
            refresh_token: "synthetic-transient-refresh",
            expires_in: 300,
            id_token: token,
          }),
        );
      }
      throw new Error("Synthetic transport denied");
    });
  const selected = {
    ...bindings,
    AUTH_ALLOWED_EMAILS: JSON.stringify([
      ...configuration.allowedEmails,
      "qa-google@example.invalid",
      ...extraAllowedEmails,
    ]),
  };
  async function start() {
    const response = await app.request(
      `${configuration.origin}/api/auth/sign-in/social`,
      {
        method: "POST",
        headers: {
          Origin: configuration.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "google", disableRedirect: true }),
      },
      selected,
    );
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as {
      url: string;
    };
    const authorization = new URL(url);
    expect(authorization.searchParams.get("scope")?.split(" ").sort()).toEqual([
      "email",
      "openid",
      "profile",
    ]);
    const nonce = authorization.searchParams.get("nonce");
    const state = authorization.searchParams.get("state");
    if (!nonce || !state) throw new Error("Synthetic flow unavailable");
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    return { nonce, state, cookie };
  }
  async function sign(
    nonce: string,
    changed: Record<string, unknown> = {},
    corrupt = false,
    code = "synthetic-code",
  ) {
    const payload = googleIdTokenClaims({
      sub: "qa-google-subject",
      email: "qa-google@example.invalid",
      name: "QA synthetic Google",
      nonce,
      aud: configuration.googleClientId,
      exp: Math.floor(Date.now() / 1000) + 300,
      ...changed,
    });
    const signed = await signIdToken({
      claims: payload,
      privateKey: pair.privateKey,
      kid: "qa-synthetic-google",
    });
    let jwt = signed.jwt;
    if (corrupt) {
      const parts = jwt.split(".");
      const signature = parts[2] ?? "";
      parts[2] = (signature.startsWith("A") ? "B" : "A") + signature.slice(1);
      jwt = parts.join(".");
    }
    tokens.set(code, jwt);
  }
  function callback(
    flow: {
      state: string;
      cookie: string;
    },
    extra = "&code=synthetic-code",
  ) {
    return app.request(
      `${configuration.origin}/api/auth/callback/google?state=${encodeURIComponent(flow.state)}${extra}`,
      { headers: { Cookie: flow.cookie } },
      selected,
    );
  }
  return {
    start,
    sign,
    callback,
    selected,
    getExchangedVerifier: () => exchangedVerifier,
    restore: () => transport.mockRestore(),
  };
}
async function identityCounts() {
  const result = await db
    .prepare(
      'SELECT (SELECT COUNT(*) FROM "user") AS users,(SELECT COUNT(*) FROM "session") AS sessions,(SELECT COUNT(*) FROM "account") AS accounts',
    )
    .first();
  return result;
}
function noSessionCookie(response: Response) {
  return !response.headers
    .getSetCookie()
    .some(
      (cookie) =>
        /^__Secure-better-auth\.session_token=[^;]/.test(cookie) &&
        !cookie.includes("Max-Age=0"),
    );
}
it("AUTH-03/04 signed callback rejects hostile identity claims without provisioning", async () => {
  const google = await syntheticGoogle();
  try {
    const cases = [
      { changed: { nonce: "wrong-nonce" } },
      { changed: { aud: "unrelated-client" } },
      { changed: { iss: "https://unrelated.invalid" } },
      { changed: { exp: 1 } },
      { changed: { exp: undefined } },
      { changed: { email_verified: false } },
      { changed: { email: "not-allowed@example.invalid" } },
      { changed: { sub: "" } },
      { changed: {}, corrupt: true },
    ];
    for (const item of cases) {
      const before = await identityCounts();
      const flow = await google.start();
      await google.sign(flow.nonce, item.changed, item.corrupt);
      const response = await google.callback(flow);
      expect(response.status).toBe(302);
      expect(noSessionCookie(response)).toBe(true);
      const location = new URL(
        requireFixture(response.headers.get("location")),
        configuration.origin,
      );
      expect(location.origin).toBe(configuration.origin);
      expect(location.searchParams.get("error")).toBe("sign_in_failed");
      expect([...location.searchParams.keys()]).toEqual(["error"]);
      expect(await identityCounts()).toEqual(before);
    }
  } finally {
    google.restore();
  }
});
it("AUTH-03 login state and PKCE remain encrypted at rest through actual code exchange", async () => {
  const google = await syntheticGoogle();
  try {
    const before = new Set(
      (
        await db.prepare('SELECT identifier FROM "verification"').all<{
          identifier: string;
        }>()
      ).results.map((row) => row.identifier),
    );
    const flow = await google.start();
    const inserted = (
      await db.prepare('SELECT identifier,value FROM "verification"').all<{
        identifier: string;
        value: string;
      }>()
    ).results.filter((row) => !before.has(row.identifier));
    expect(inserted).toHaveLength(1);
    const stored = requireFixture(inserted[0]);
    expect(stored.identifier.includes(flow.state)).toBe(false);
    expect(stored.value.includes(flow.state)).toBe(false);
    let hasPlainVerifier = false;
    try {
      hasPlainVerifier =
        typeof (
          JSON.parse(stored.value) as {
            codeVerifier?: unknown;
          }
        ).codeVerifier === "string";
    } catch {
      hasPlainVerifier = false;
    }
    expect(hasPlainVerifier).toBe(false);
    await google.sign(flow.nonce);
    const completed = await google.callback(flow);
    expect(noSessionCookie(completed)).toBe(false);
    const verifier = google.getExchangedVerifier();
    expect(typeof verifier === "string" && verifier.length >= 43).toBe(true);
    expect(stored.value.includes(requireFixture(verifier))).toBe(false);
  } finally {
    google.restore();
  }
});
it("AUTH-03 swapping encrypted library state rows fails closed without changing another flow", async () => {
  const google = await syntheticGoogle();
  try {
    const before = new Set(
      (
        await db.prepare('SELECT identifier FROM "verification"').all<{
          identifier: string;
        }>()
      ).results.map((row) => row.identifier),
    );
    const first = await google.start();
    const firstRows = (
      await db.prepare('SELECT identifier,value FROM "verification"').all<{
        identifier: string;
        value: string;
      }>()
    ).results.filter((row) => !before.has(row.identifier));
    expect(firstRows).toHaveLength(1);
    before.add(requireFixture(firstRows[0]).identifier);
    const second = await google.start();
    const secondRows = (
      await db.prepare('SELECT identifier,value FROM "verification"').all<{
        identifier: string;
        value: string;
      }>()
    ).results.filter((row) => !before.has(row.identifier));
    expect(secondRows).toHaveLength(1);
    await db
      .prepare('UPDATE "verification" SET value=? WHERE identifier=?')
      .bind(
        requireFixture(secondRows[0]).value,
        requireFixture(firstRows[0]).identifier,
      )
      .run();
    // Match the swapped row's nonce too: rejection must bind the encrypted row
    // identity, rather than succeed only because the JWT carries a different nonce.
    await google.sign(second.nonce);
    const failed = await google.callback(first);
    expect(noSessionCookie(failed)).toBe(true);
    await google.sign(second.nonce);
    const successful = await google.callback(second);
    expect(noSessionCookie(successful)).toBe(false);
    const replay = await google.callback(second);
    expect(noSessionCookie(replay)).toBe(true);
  } finally {
    google.restore();
  }
});
it("AUTH-03/04/05 synthetic callback state cannot mix cookies, replay or merge a new subject by email", async () => {
  const google = await syntheticGoogle();
  try {
    const first = await google.start();
    const second = await google.start();
    const before = await identityCounts();
    await google.sign(first.nonce);
    const mixed = await google.callback({
      state: first.state,
      cookie: second.cookie,
    });
    expect(mixed.status).toBe(302);
    expect(noSessionCookie(mixed)).toBe(true);
    expect(await identityCounts()).toEqual(before);
    const good = await google.start();
    await google.sign(good.nonce);
    const completed = await google.callback(good);
    expect(completed.status).toBe(302);
    expect(
      new URL(requireFixture(completed.headers.get("location"))).pathname,
    ).toBe("/home");
    const cookie = completed.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(
      (
        await app.request(
          `${configuration.origin}/api/me`,
          { headers: { Cookie: cookie } },
          google.selected,
        )
      ).status,
    ).toBe(200);
    const after = await identityCounts();
    const replay = await google.callback(good);
    expect(noSessionCookie(replay)).toBe(true);
    expect(await identityCounts()).toEqual(after);
    const unrelated = await google.start();
    await google.sign(unrelated.nonce, { sub: "unrelated-google-subject" });
    const linked = await google.callback(unrelated);
    expect(noSessionCookie(linked)).toBe(true);
    expect(await identityCounts()).toEqual(after);
    expect(
      await db
        .prepare('SELECT COUNT(*) AS count FROM "account" WHERE accountId=?')
        .bind("unrelated-google-subject")
        .first<number>("count"),
    ).toBe(0);
  } finally {
    google.restore();
  }
});
it("AUTH-03 valid-state provider errors never reflect private descriptions into redirects", async () => {
  const google = await syntheticGoogle();
  try {
    const flow = await google.start();
    const marker = "synthetic-private-provider-description";
    const response = await google.callback(
      flow,
      `&error=provider-private-marker&error_description=${marker}`,
    );
    expect(response.status).toBe(302);
    const location = requireFixture(response.headers.get("location"));
    expect(location.includes(marker)).toBe(false);
    expect(location.includes("provider-private-marker")).toBe(false);
    const target = new URL(location, configuration.origin);
    expect(target.origin).toBe(configuration.origin);
    expect([...target.searchParams.keys()]).toEqual(["error"]);
    expect(target.searchParams.get("error")).toBe("sign_in_failed");
    expect(noSessionCookie(response)).toBe(true);
  } finally {
    google.restore();
  }
});
it.each(["profiles", "account"] as const)(
  "ONBOARD-01 failed %s insertion leaves no orphan and fresh callback can retry",
  async (selected) => {
    const email =
      selected === "profiles"
        ? "qa-profile-failure@example.invalid"
        : "qa-account-failure@example.invalid";
    const google = await syntheticGoogle([email]);
    try {
      const subject = `qa-failure-${selected}`;
      const before = await identityCounts();
      await db
        .prepare(
          `CREATE TRIGGER qa_fail_insert BEFORE INSERT ON "${selected}" BEGIN SELECT RAISE(ABORT,'synthetic provisioning failure'); END`,
        )
        .run();
      try {
        const failed = await google.start();
        await google.sign(failed.nonce, { email, sub: subject });
        const response = await google.callback(failed);
        expect(noSessionCookie(response)).toBe(true);
        expect(await identityCounts()).toEqual(before);
        expect(
          await db
            .prepare('SELECT COUNT(*) AS count FROM "user" WHERE email=?')
            .bind(email)
            .first<number>("count"),
        ).toBe(0);
        expect([302, 503]).toContain(response.status);
      } finally {
        await db.prepare("DROP TRIGGER IF EXISTS qa_fail_insert").run();
      }
      const retry = await google.start();
      await google.sign(retry.nonce, { email, sub: subject });
      const response = await google.callback(retry);
      expect(response.status).toBe(302);
      expect(noSessionCookie(response)).toBe(false);
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      expect(
        (
          await app.request(
            `${configuration.origin}/api/me`,
            { headers: { Cookie: cookie } },
            google.selected,
          )
        ).status,
      ).toBe(200);
      expect(
        await db
          .prepare('SELECT COUNT(*) AS count FROM "account" WHERE accountId=?')
          .bind(subject)
          .first<number>("count"),
      ).toBe(1);
    } finally {
      await db.prepare("DROP TRIGGER IF EXISTS qa_fail_insert").run();
      google.restore();
    }
  },
);
it("ONBOARD-01 failed concurrent callback cannot delete another callback's successful identity", async () => {
  const goodEmail = "qa-concurrent-good@example.invalid";
  const badEmail = "qa-concurrent-failed@example.invalid";
  const google = await syntheticGoogle([goodEmail, badEmail]);
  try {
    const good = await google.start();
    const bad = await google.start();
    await google.sign(
      good.nonce,
      { sub: "qa-concurrent-good", email: goodEmail },
      false,
      "concurrent-good",
    );
    await google.sign(
      bad.nonce,
      { sub: "qa-concurrent-bad", email: badEmail },
      false,
      "concurrent-bad",
    );
    await db
      .prepare(
        "CREATE TRIGGER qa_fail_concurrent_profile BEFORE INSERT ON profiles WHEN EXISTS(SELECT 1 FROM \"user\" WHERE id=NEW.user_id AND email='qa-concurrent-failed@example.invalid') BEGIN SELECT RAISE(ABORT,'synthetic concurrent provisioning failure'); END",
      )
      .run();
    const [completed, failed] = await Promise.all([
      google.callback(good, "&code=concurrent-good"),
      google.callback(bad, "&code=concurrent-bad"),
    ]);
    expect(completed.status).toBe(302);
    expect(noSessionCookie(completed)).toBe(false);
    expect(noSessionCookie(failed)).toBe(true);
    const cookie = completed.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const me = await app.request(
      `${configuration.origin}/api/me`,
      { headers: { Cookie: cookie } },
      google.selected,
    );
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { email: goodEmail } });
    expect(
      await db
        .prepare('SELECT COUNT(*) AS count FROM "user" WHERE email=?')
        .bind(badEmail)
        .first<number>("count"),
    ).toBe(0);
    expect(
      await db
        .prepare('SELECT COUNT(*) AS count FROM "account" WHERE accountId=?')
        .bind("qa-concurrent-good")
        .first<number>("count"),
    ).toBe(1);
  } finally {
    await db.prepare("DROP TRIGGER IF EXISTS qa_fail_concurrent_profile").run();
    google.restore();
  }
});
it("AUTH-04 simultaneous same-subject callbacks with different verified emails create one owner", async () => {
  const emails = [
    "qa-rename-first@example.invalid",
    "qa-rename-second@example.invalid",
  ];
  const google = await syntheticGoogle(emails);
  try {
    const flows = [await google.start(), await google.start()];
    for (const [index, flow] of flows.entries())
      await google.sign(
        flow.nonce,
        {
          sub: "qa-shared-google-subject",
          email: requireFixture(emails[index]),
        },
        false,
        `rename-${index}`,
      );
    const responses = await Promise.all(
      flows.map((flow, index) =>
        google.callback(flow, `&code=rename-${index}`),
      ),
    );
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM \"account\" WHERE providerId='google' AND accountId=?",
        )
        .bind("qa-shared-google-subject")
        .first<number>("count"),
    ).toBe(1);
    expect(
      await db
        .prepare('SELECT COUNT(*) AS count FROM "user" WHERE email IN (?,?)')
        .bind(...emails)
        .first<number>("count"),
    ).toBe(1);
    const owners: string[] = [];
    for (const response of responses) {
      if (noSessionCookie(response)) continue;
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const me = await app.request(
        `${configuration.origin}/api/me`,
        { headers: { Cookie: cookie } },
        google.selected,
      );
      expect(me.status).toBe(200);
      const body = (await me.json()) as {
        user: {
          id: string;
        };
      };
      owners.push(body.user.id);
    }
    expect(owners.length).toBeGreaterThanOrEqual(1);
    expect(new Set(owners).size).toBe(1);
  } finally {
    google.restore();
  }
});
function session(name: string) {
  const value = syntheticSessions.get(name);
  if (!value) throw new Error("Synthetic session unavailable");
  return value;
}
function me(name: string, selectedBindings = bindings) {
  return app.request(
    `${configuration.origin}/api/me`,
    { headers: { Cookie: session(name).cookie } },
    selectedBindings,
  );
}
it("AUTH-01 concurrent preferences remain owned, optimistic and version-bounded despite forged identities", async () => {
  const victimBefore = await (await me("auth-b")).json();
  const patch = (body: unknown) =>
    app.request(
      `${configuration.origin}/api/me?userId=${session("auth-b").userId}`,
      {
        method: "PATCH",
        headers: {
          Cookie: session("auth-a").cookie,
          Origin: configuration.origin,
          "Content-Type": "application/json",
          "X-User-Id": session("auth-b").userId,
        },
        body: JSON.stringify(body),
      },
      bindings,
    );
  expect(
    (
      await patch({
        version: 1,
        timezone: "UTC",
        reportingCurrency: "EUR",
        userId: session("auth-b").userId,
      })
    ).status,
  ).toBe(400);
  const replies = await Promise.all([
    patch({ version: 1, timezone: "Europe/Vienna", reportingCurrency: "EUR" }),
    patch({
      version: 1,
      timezone: "America/New_York",
      reportingCurrency: "USD",
    }),
  ]);
  expect(replies.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(await (await me("auth-b")).json()).toEqual(victimBefore);
  expect(await (await me("auth-a")).json()).toMatchObject({
    settings: { version: 2 },
  });
  const maximum = 2147483646;
  await db
    .prepare("UPDATE profiles SET version=? WHERE user_id=?")
    .bind(maximum, session("auth-a").userId)
    .run();
  const capped = await patch({
    version: maximum,
    timezone: "UTC",
    reportingCurrency: "EUR",
  });
  expect(
    await db
      .prepare("SELECT version FROM profiles WHERE user_id=?")
      .bind(session("auth-a").userId)
      .first<number>("version"),
  ).toBe(maximum);
  expect(capped.status).toBe(409);
});
it("AUTH-01 expired, deleting and removed-allowlist owners lose session authority", async () => {
  for (const name of ["auth-expired", "auth-deleting", "auth-removed"])
    expect((await me(name)).status).toBe(200);
  await db
    .prepare('UPDATE "session" SET expiresAt=0 WHERE token=?')
    .bind(session("auth-expired").token)
    .run();
  await db
    .prepare("UPDATE profiles SET status='deleting' WHERE user_id=?")
    .bind(session("auth-deleting").userId)
    .run();
  const removed = {
    ...bindings,
    AUTH_ALLOWED_EMAILS: JSON.stringify(
      configuration.allowedEmails.filter(
        (email) => email !== "auth-removed@example.invalid",
      ),
    ),
  };
  for (const [name, selected] of [
    ["auth-expired", bindings],
    ["auth-deleting", bindings],
    ["auth-removed", removed],
  ] as const) {
    const response = await me(name, selected);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      error: { code: "unauthorized", retryable: false },
    });
    expect(JSON.stringify(body).includes(session(name).token)).toBe(false);
  }
});
it("AUTH-03 missing-origin and cross-site mutations cannot change preferences or logout", async () => {
  const before = await (await me("auth-b")).json();
  for (const path of ["/api/me", "/api/auth/sign-out"]) {
    const response = await app.request(
      configuration.origin + path,
      {
        method: path === "/api/me" ? "PATCH" : "POST",
        headers: {
          Cookie: session("auth-b").cookie,
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "cross-site",
        },
        body: JSON.stringify(
          path === "/api/me"
            ? {
                version: 1,
                timezone: "Europe/Vienna",
                reportingCurrency: "EUR",
              }
            : {},
        ),
      },
      bindings,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect((await me("auth-b")).status).toBe(200);
  expect(await (await me("auth-b")).json()).toEqual(before);
});
it("ONBOARD-01 sign-in rejects caller scope, identity token and destination overrides without state", async () => {
  const before = await db
    .prepare('SELECT COUNT(*) AS count FROM "verification"')
    .first<number>("count");
  for (const extra of [
    { scope: ["https://www.googleapis.com/auth/gmail.readonly"] },
    { idToken: { token: "synthetic-browser-token" } },
    { callbackURL: "https://unapproved.invalid/" },
    { userId: session("auth-b").userId },
  ]) {
    const response = await app.request(
      `${configuration.origin}/api/auth/sign-in/social`,
      {
        method: "POST",
        headers: {
          Origin: configuration.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "google", ...extra }),
      },
      bindings,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "invalid_request" } });
    expect(JSON.stringify(body).includes("synthetic-browser-token")).toBe(
      false,
    );
  }
  expect(
    await db
      .prepare('SELECT COUNT(*) AS count FROM "verification"')
      .first<number>("count"),
  ).toBe(before);
});
it("AUTH-01 authenticated profile is a safe projection without credential or session fields", async () => {
  const response = await me("auth-b");
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual([
    "capabilities",
    "onboarding",
    "settings",
    "user",
    "valuation",
  ]);
  expect(JSON.stringify(body).includes(session("auth-b").token)).toBe(false);
  expect(JSON.stringify(body)).not.toMatch(
    /accessToken|refreshToken|idToken|credential|session_token|AUTH_SECRET/,
  );
  const head = await app.request(
    `${configuration.origin}/api/me`,
    { method: "HEAD", headers: { Cookie: session("auth-b").cookie } },
    bindings,
  );
  expect(head.status).toBe(200);
  expect(head.headers.get("cache-control")).toBe("no-store");
  expect(await head.text()).toBe("");
  expect(await (await me("auth-b")).json()).toEqual(body);
});
