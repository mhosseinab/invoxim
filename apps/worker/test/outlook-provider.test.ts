import { env } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createOutlookAuthorization } from "../../../packages/adapters/src/mailbox/outlook";
import {
  OUTLOOK_AUTHORIZATION_SCOPES,
  outlookConfiguration,
} from "../../../packages/adapters/src/mailbox/outlook-configuration";
import { encodeBase64url } from "../../../packages/adapters/src/security/cipher";
import {
  generateSigningKeys,
  signIdToken,
} from "../../../packages/testkit/src/google-token";

const clientId = "11111111-1111-4111-8111-111111111111";
const configuration = { clientId, clientSecret: "synthetic-microsoft-secret" };
const callback = "https://synthetic.example/api/oauth/mailbox/outlook/callback";
const input = {
  state: "synthetic-state",
  nonce: "synthetic-nonce",
  verifier: "s".repeat(43),
  callback,
};
it("authorization requests delegated body/attachment read with PKCE and separately bound nonce", async () => {
  const url = new URL(
    await createOutlookAuthorization(configuration).authorize(input),
  );
  expect(url.origin).toBe("https://login.microsoftonline.com");
  expect(url.pathname).toBe("/common/oauth2/v2.0/authorize");
  expect(url.searchParams.get("scope")?.split(" ")).toContain(
    "https://graph.microsoft.com/Mail.Read",
  );
  expect(url.searchParams.get("scope")).not.toContain("Mail.ReadBasic");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toHaveLength(43);
  expect(url.searchParams.get("state")).toBe(input.state);
  expect(url.searchParams.get("nonce")).toBe(input.nonce);
  expect(url.searchParams.get("redirect_uri")).toBe(callback);
  expect(url.searchParams.get("client_secret")).toBeNull();
});
const workTenant = "22222222-2222-4222-8222-222222222222";
const personalTenant = "9188040d-6c67-4c5b-b112-36a304b66dad";
const issuer = (tid: string) => `https://login.microsoftonline.com/${tid}/v2.0`;
const accountSub = "synthetic-pairwise-subject-b";
let keys: CryptoKeyPair;
let wrongKeys: CryptoKeyPair;
beforeAll(async () => {
  const generated = await generateSigningKeys();
  keys = generated.keys;
  wrongKeys = generated.wrongKeys;
});
afterEach(() => vi.restoreAllMocks());
async function signed(
  extra: Record<string, unknown> = {},
  kid = "synthetic-ms-key",
  wrong = false,
) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: issuer(workTenant),
    tid: workTenant,
    sub: accountSub,
    aud: clientId,
    nonce: input.nonce,
    iat: now,
    exp: now + 3600,
    ver: "2.0",
    ...extra,
  };
  const result = await signIdToken({
    claims,
    privateKey: (wrong ? wrongKeys : keys).privateKey,
    kid,
  });
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return {
    jwt: result.jwt,
    key: {
      ...jwk,
      kid,
      alg: "RS256",
      use: "sig",
      issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
    },
  };
}
function tokens(extra: Record<string, unknown> = {}) {
  return {
    access_token: "synthetic-opaque-ms-access",
    refresh_token: "synthetic-ms-refresh",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "openid email profile https://graph.microsoft.com/Mail.Read",
    ...extra,
  };
}
function transport(
  result: unknown,
  jwks: unknown,
  user: unknown = { sub: accountSub, email: "mailbox-b@example.invalid" },
  authority = "common",
  status = 200,
) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    const url = request instanceof Request ? request.url : String(request);
    calls.push({ url, init });
    if (
      url === `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`
    )
      return Response.json(result, { status });
    if (
      url ===
      `https://login.microsoftonline.com/${authority}/discovery/v2.0/keys`
    )
      return Response.json(jwks);
    if (url === "https://graph.microsoft.com/oidc/userinfo")
      return Response.json(user);
    throw new Error("Synthetic transport denied unexpected URL");
  });
  return calls;
}
it.each([workTenant, personalTenant])(
  "signed personal/work account (%s) has issuer-bound immutable identity and UserInfo correlation",
  async (tid) => {
    const fixture = await signed({ tid, iss: issuer(tid) });
    const calls = transport(tokens({ id_token: fixture.jwt }), {
      keys: [fixture.key],
    });
    const result = await createOutlookAuthorization(configuration).exchange({
      code: "synthetic-code",
      ...input,
    });
    expect(result.identity).toEqual({
      subject: `${issuer(tid)}|${accountSub}`,
      address: "mailbox-b@example.invalid",
    });
    expect(result.identity.subject.length).toBeLessThanOrEqual(254);
    expect(result.canReadMessages).toBe(true);
    expect(result.credentials.refreshToken).toBe("synthetic-ms-refresh");
    expect(calls.map(({ url }) => url)).toEqual([
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      "https://login.microsoftonline.com/common/discovery/v2.0/keys",
      "https://graph.microsoft.com/oidc/userinfo",
    ]);
    for (const call of calls) {
      expect(call.init?.redirect).toBe("manual");
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
    const form = new URLSearchParams(String(calls[0]?.init?.body));
    expect(form.get("code_verifier")).toBe(input.verifier);
    expect(form.get("redirect_uri")).toBe(callback);
    expect(form.get("client_secret")).toBe(configuration.clientSecret);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("scope")?.split(" ")).toEqual([
      ...OUTLOOK_AUTHORIZATION_SCOPES,
    ]);
    expect(form.get("scope")).not.toContain("User.Read");
  },
);
it.each([
  { aud: "synthetic-wrong-client" },
  { iss: "https://evil.example/v2.0" },
  { nonce: "synthetic-wrong-nonce" },
  { exp: 1 },
  { tid: "not-a-guid" },
  { iat: Math.floor(Date.now() / 1000) + 7200 },
  { ver: "1.0" },
])(
  "rejects cryptographically signed invalid claims %j before UserInfo",
  async (extra) => {
    const fixture = await signed(extra);
    const calls = transport(tokens({ id_token: fixture.jwt }), {
      keys: [fixture.key],
    });
    await expect(
      createOutlookAuthorization(configuration).exchange({
        code: "synthetic-code",
        ...input,
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    expect(calls.some(({ url }) => url.includes("userinfo"))).toBe(false);
  },
);
it.each([
  "wrong-signature",
  "wrong-key-issuer",
  "duplicate-key",
  "unknown-key",
])("rejects %s with no identity access", async (kind) => {
  const fixture = await signed(
    {},
    "synthetic-ms-key",
    kind === "wrong-signature",
  );
  let publicKeys: unknown[] = [fixture.key];
  if (kind === "wrong-key-issuer")
    publicKeys = [{ ...fixture.key, issuer: issuer(personalTenant) }];
  if (kind === "duplicate-key") publicKeys.push(fixture.key);
  if (kind === "unknown-key")
    publicKeys = [{ ...fixture.key, kid: "synthetic-other-key" }];
  const calls = transport(tokens({ id_token: fixture.jwt }), {
    keys: publicKeys,
  });
  await expect(
    createOutlookAuthorization(configuration).exchange({
      code: "synthetic-code",
      ...input,
    }),
  ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  expect(calls.some(({ url }) => url.includes("userinfo"))).toBe(false);
});
it.each([
  ["consumers", workTenant],
  ["organizations", personalTenant],
  [workTenant, personalTenant],
])("authority %s rejects other tenant/class %s", async (authority, tid) => {
  const fixture = await signed({ tid, iss: issuer(tid) });
  transport(
    tokens({ id_token: fixture.jwt }),
    { keys: [fixture.key] },
    undefined,
    authority,
  );
  await expect(
    createOutlookAuthorization({ ...configuration, authority }).exchange({
      code: "synthetic-code",
      ...input,
    }),
  ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
});
it("new signing key is fetched from fixed authority after rotation", async () => {
  const adapter = createOutlookAuthorization(configuration);
  for (const kid of ["synthetic-old-key", "synthetic-new-key"]) {
    const fixture = await signed({}, kid);
    const calls = transport(tokens({ id_token: fixture.jwt }), {
      keys: [fixture.key],
    });
    expect(
      (await adapter.exchange({ code: "synthetic-code", ...input })).identity
        .subject,
    ).toBe(`${issuer(workTenant)}|${accountSub}`);
    expect(calls.filter(({ url }) => url.endsWith("/keys"))).toHaveLength(1);
    vi.restoreAllMocks();
  }
});
it("UserInfo subject must match verified IDtoken and missing display email is controlled", async () => {
  const fixture = await signed();
  transport(
    tokens({ id_token: fixture.jwt }),
    { keys: [fixture.key] },
    { sub: "synthetic-other-mailbox", email: "mailbox-b@example.invalid" },
  );
  await expect(
    createOutlookAuthorization(configuration).exchange({
      code: "synthetic-code",
      ...input,
    }),
  ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  vi.restoreAllMocks();
  transport(
    tokens({ id_token: fixture.jwt }),
    { keys: [fixture.key] },
    { sub: accountSub },
  );
  await expect(
    createOutlookAuthorization(configuration).exchange({
      code: "synthetic-code",
      ...input,
    }),
  ).rejects.toMatchObject({ code: "MISSING_PERMISSION" });
});
it.each([
  undefined,
  "openid email profile",
  "Mail.ReadBasic",
  "Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Read User.Read",
])(
  "missing or broader granted scope %s cannot authorize read",
  async (scope) => {
    const calls = transport(
      tokens({ scope, id_token: "synthetic-unverified-token" }),
      {},
    );
    await expect(
      createOutlookAuthorization(configuration).exchange({
        code: "synthetic-code",
        ...input,
      }),
    ).rejects.toMatchObject({ code: "MISSING_PERMISSION" });
    expect(calls).toHaveLength(1);
  },
);
const current = {
  accessToken: "synthetic-old-ms-access",
  refreshToken: "synthetic-old-ms-refresh",
  expiresAt: 0,
};
const expectedIdentity = {
  subject: `${issuer(workTenant)}|${accountSub}`,
  address: "old-display@example.invalid",
};
it.each([true, false])(
  "refresh retains stable identity and rotates/retains credential (rotation %s) without consuming unsigned refresh IDtoken",
  async (rotation) => {
    const calls = transport(
      tokens({
        scope: undefined,
        refresh_token: rotation ? "synthetic-new-ms-refresh" : undefined,
        id_token: "synthetic-unsigned-not-authority",
      }),
      {},
      { sub: accountSub },
    );
    const result = await createOutlookAuthorization(configuration).refresh(
      current,
      expectedIdentity,
    );
    expect(result.refreshToken).toBe(
      rotation ? "synthetic-new-ms-refresh" : current.refreshToken,
    );
    expect(result.accessToken).toBe("synthetic-opaque-ms-access");
    expect(current.refreshToken).toBe("synthetic-old-ms-refresh");
    expect(calls.map(({ url }) => url)).toEqual([
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      "https://graph.microsoft.com/oidc/userinfo",
    ]);
    expect(
      new URLSearchParams(String(calls[0]?.init?.body)).get("grant_type"),
    ).toBe("refresh_token");
  },
);
it("refresh rejects another pairwise subject and an authority mismatch before transport", async () => {
  transport(
    tokens(),
    {},
    { sub: "synthetic-other-account", email: expectedIdentity.address },
  );
  await expect(
    createOutlookAuthorization(configuration).refresh(
      current,
      expectedIdentity,
    ),
  ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  vi.restoreAllMocks();
  const calls = transport(tokens(), {});
  await expect(
    createOutlookAuthorization({
      ...configuration,
      authority: "consumers",
    }).refresh(current, expectedIdentity),
  ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  expect(calls).toHaveLength(0);
});
it("invalid_grant is a redacted reconnect outcome and missing refresh token does not call providers", async () => {
  const calls = transport(
    {
      error: "invalid_grant",
      error_description: "synthetic-provider-detail-DO-NOT-RETURN",
    },
    {},
    undefined,
    "common",
    400,
  );
  let error: unknown;
  try {
    await createOutlookAuthorization(configuration).refresh(
      current,
      expectedIdentity,
    );
  } catch (value) {
    error = value;
  }
  expect(error).toMatchObject({
    code: "RECONNECT_REQUIRED",
    message: "RECONNECT_REQUIRED",
  });
  expect(String(error)).not.toContain("DO-NOT-RETURN");
  expect(calls).toHaveLength(1);
  await expect(
    createOutlookAuthorization(configuration).refresh(
      { accessToken: current.accessToken, expiresAt: current.expiresAt },
      expectedIdentity,
    ),
  ).rejects.toMatchObject({ code: "RECONNECT_REQUIRED" });
  expect(calls).toHaveLength(1);
});
it.each([
  "redirect",
  "oversized-header",
  "oversized-stream",
  "invalid-json",
  "network-error",
])("bounded token transport refuses %s", async (kind) => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
    expect(init?.redirect).toBe("manual");
    if (kind === "network-error")
      throw new Error("synthetic-private-provider-detail");
    if (kind === "redirect")
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/token" },
      });
    if (kind === "oversized-header")
      return new Response("{}", { headers: { "content-length": "65537" } });
    if (kind === "oversized-stream") return new Response("x".repeat(65537));
    return new Response("not-json");
  });
  await expect(
    createOutlookAuthorization(configuration).refresh(
      current,
      expectedIdentity,
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE", message: "UNAVAILABLE" });
});
it("concurrent exchanges use verification-local keys/claims and do not cross mailbox identities", async () => {
  const first = await signed();
  const second = await signed(
    {
      tid: personalTenant,
      iss: issuer(personalTenant),
      sub: "synthetic-personal-b",
    },
    "synthetic-second-key",
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    const url = String(request);
    if (url.endsWith("/token")) {
      const code = new URLSearchParams(String(init?.body)).get("code");
      return Response.json(
        tokens({
          id_token: code === "synthetic-code-a" ? first.jwt : second.jwt,
          access_token:
            code === "synthetic-code-a"
              ? "synthetic-access-a"
              : "synthetic-access-b",
        }),
      );
    }
    if (url.endsWith("/keys"))
      return Response.json({ keys: [first.key, second.key] });
    if (url.endsWith("userinfo"))
      return Response.json({
        sub:
          new Headers(init?.headers).get("authorization") ===
          "Bearer synthetic-access-a"
            ? accountSub
            : "synthetic-personal-b",
        email: "mailbox@example.invalid",
      });
    throw new Error("Unexpected synthetic destination");
  });
  const adapter = createOutlookAuthorization(configuration);
  const results = await Promise.all([
    adapter.exchange({ ...input, code: "synthetic-code-a" }),
    adapter.exchange({ ...input, code: "synthetic-code-b" }),
  ]);
  expect(results.map(({ identity }) => identity.subject)).toEqual([
    `${issuer(workTenant)}|${accountSub}`,
    `${issuer(personalTenant)}|synthetic-personal-b`,
  ]);
});
const configuredBindings = () => ({
  DB: env.DB,
  AUTH_ENABLED: "true",
  AUTH_ORIGIN: "https://synthetic.example",
  AUTH_SECRET: "synthetic-login-secret-at-least-thirty-two-characters",
  AUTH_GOOGLE_CLIENT_ID: "synthetic-google-login-client",
  AUTH_GOOGLE_CLIENT_SECRET: "synthetic-google-login-secret",
  AUTH_ALLOWED_EMAILS: JSON.stringify(["login-a@example.invalid"]),
  OUTLOOK_ENABLED: "true",
  OUTLOOK_CLIENT_ID: clientId,
  OUTLOOK_CLIENT_SECRET: configuration.clientSecret,
  CREDENTIAL_KEYRING: JSON.stringify({
    activeVersion: 1,
    keys: { 1: encodeBase64url(new Uint8Array(32).fill(7)) },
  }),
});
it("Outlook config is disabled by default and configured consent stays separate from Google login", () => {
  expect(outlookConfiguration({})).toBeNull();
  const config = outlookConfiguration(configuredBindings());
  expect(config).toMatchObject({
    authority: "common",
    provider: "outlook",
    oauthProvider: "microsoft",
    callback,
    limit: 3,
  });
  expect(config?.scopes).toEqual(OUTLOOK_AUTHORIZATION_SCOPES);
  expect(config?.login.googleClientId).toBe("synthetic-google-login-client");
});
it.each([
  { OUTLOOK_ENABLED: "TRUE" },
  { OUTLOOK_AUTHORITY: "https://evil.example" },
  { OUTLOOK_AUTHORITY: "../common" },
  { OUTLOOK_AUTHORITY: "common?tenant=evil" },
  { OUTLOOK_AUTHORITY: "https://login.microsoftonline.us/common" },
  { OUTLOOK_CLIENT_ID: "not-a-guid" },
  { OUTLOOK_CLIENT_SECRET: "" },
  { MAILBOX_LIMIT: "11" },
  { MAILBOX_LIMIT: "0" },
  { CREDENTIAL_KEYRING: "{}" },
  { AUTH_ENABLED: "false" },
])("invalid operator config %j stays disabled", (extra) => {
  expect(
    outlookConfiguration({ ...configuredBindings(), ...extra }),
  ).toBeNull();
});
