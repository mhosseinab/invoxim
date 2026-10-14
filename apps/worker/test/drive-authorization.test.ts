import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDriveAuthorization } from "../../../packages/adapters/src/drive/authorization";
import {
  DRIVE_AUTHORIZATION_SCOPES,
  driveConfiguration,
} from "../../../packages/adapters/src/drive/configuration";
import { encodeBase64url } from "../../../packages/adapters/src/security/cipher";

import {
  GOOGLE_TOKEN_ENDPOINT,
  generateSigningKeys,
  googleIdTokenClaims,
  googleTokenResponse,
  signIdToken,
} from "../../../packages/testkit/src/google-token";

const callback =
  "https://synthetic.example/api/oauth/storage/google-drive/callback";
const clientId = "synthetic-drive.apps.googleusercontent.com";
const configuration = {
  clientId,
  clientSecret: "synthetic-drive-secret",
  callback,
};
const input = {
  state: "synthetic-drive-state",
  nonce: "synthetic-drive-nonce",
  verifier: "s".repeat(43),
  callback,
};
const sub = "synthetic-independent-drive-subject";
const scope = DRIVE_AUTHORIZATION_SCOPES.join(" ");
let keys: CryptoKeyPair;
let wrongKeys: CryptoKeyPair;
beforeAll(async () => {
  const generated = await generateSigningKeys();
  keys = generated.keys;
  wrongKeys = generated.wrongKeys;
});
afterEach(() => vi.restoreAllMocks());
async function signed(
  change: Record<string, unknown> = {},
  wrong = false,
  header: Record<string, unknown> = {},
) {
  const claims = googleIdTokenClaims({
    sub,
    aud: clientId,
    nonce: input.nonce,
    email: "Drive-C@example.test",
    ...change,
  });
  const result = await signIdToken({
    claims,
    privateKey: (wrong ? wrongKeys : keys).privateKey,
    header,
    kid: "synthetic-drive-key",
  });
  const key = await crypto.subtle.exportKey("jwk", keys.publicKey);
  if (!("kty" in key)) throw new Error("Synthetic RSA JWK export failed");
  return {
    jwt: result.jwt,
    key: {
      kty: key.kty,
      kid: "synthetic-drive-key",
      n: key.n,
      e: key.e,
      alg: "RS256",
      use: "sig",
    },
  };
}
function tokens(jwt: string, change: Record<string, unknown> = {}) {
  return googleTokenResponse({
    access_token: "synthetic-drive-access",
    refresh_token: "synthetic-drive-refresh",
    scope,
    id_token: jwt,
    ...change,
  });
}
async function setup(change: Record<string, unknown> = {}) {
  const fixture = await signed();
  const http = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (value) => {
      const request = value instanceof Request ? value : new Request(value);
      if (request.url === GOOGLE_TOKEN_ENDPOINT)
        return Response.json(tokens(fixture.jwt, change));
      if (request.url === "https://www.googleapis.com/oauth2/v3/certs")
        return Response.json({ keys: [fixture.key] });
      if (request.url === "https://openidconnect.googleapis.com/v1/userinfo")
        return Response.json({
          sub,
          email: "Drive-C@example.test",
          email_verified: true,
        });
      throw new Error("Unexpected synthetic endpoint");
    });
  return { http, fixture };
}

describe("T18 separate Drive authorization", () => {
  it("requests only separate drive.file consent with offline access, PKCE and bound nonce", async () => {
    const url = new URL(
      await createDriveAuthorization(configuration).authorize(input),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual(
      [...DRIVE_AUTHORIZATION_SCOPES].sort(),
    );
    expect(url.searchParams.get("scope")).not.toContain("gmail");
    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("select_account consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toHaveLength(43);
    expect(url.searchParams.get("nonce")).toBe(input.nonce);
    expect(url.searchParams.get("state")).toBe(input.state);
    expect(url.searchParams.get("redirect_uri")).toBe(callback);
    expect(url.searchParams.get("client_secret")).toBeNull();
  });
  it("verifies actual signed Google identity and separate access-token identity without enabling or writing files", async () => {
    const { http } = await setup();
    const result = await createDriveAuthorization(configuration).exchange({
      ...input,
      code: "synthetic-drive-code",
    });
    expect(result).toEqual({
      identity: { subject: sub, address: "drive-c@example.test" },
      credentials: {
        accessToken: "synthetic-drive-access",
        refreshToken: "synthetic-drive-refresh",
        expiresAt: expect.any(Number),
      },
      canArchiveFiles: true,
    });
    expect(result).not.toHaveProperty("canReadMessages");
    expect(result).not.toHaveProperty("archivingEnabled");
    expect(result).not.toHaveProperty("id_token");
    expect(http).toHaveBeenCalledTimes(3);
  });
});

function bindings() {
  return {
    DB: env.DB,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://synthetic.example",
    AUTH_SECRET: "synthetic-auth-secret-that-is-long-enough",
    AUTH_GOOGLE_CLIENT_ID: "synthetic-login.apps.googleusercontent.com",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic-login-secret",
    AUTH_ALLOWED_EMAILS: JSON.stringify(["login-a@example.test"]),
    DRIVE_ENABLED: "true",
    DRIVE_CLIENT_ID: clientId,
    DRIVE_CLIENT_SECRET: configuration.clientSecret,
    CREDENTIAL_KEYRING: JSON.stringify({
      activeVersion: 1,
      keys: { "1": encodeBase64url(new Uint8Array(32).fill(3)) },
    }),
  };
}
describe("T18 Drive validated server configuration", () => {
  it("uses separate client credentials, narrow scopes and fixed storage callback", () => {
    const config = driveConfiguration(bindings());
    expect(config).toMatchObject({
      clientId,
      clientSecret: configuration.clientSecret,
      callback,
      provider: "google-drive",
      oauthProvider: "google",
      scopes: DRIVE_AUTHORIZATION_SCOPES,
    });
    expect(config?.clientId).not.toBe(bindings().AUTH_GOOGLE_CLIENT_ID);
    expect(config).not.toHaveProperty("archivingEnabled");
  });
  it.each([undefined, "false", "TRUE", "1", ""])(
    "stays disabled unless DRIVE_ENABLED is exactly true: %s",
    (enabled) => {
      const configured = bindings();
      if (enabled === undefined)
        delete (configured as { DRIVE_ENABLED?: string }).DRIVE_ENABLED;
      else configured.DRIVE_ENABLED = enabled;
      expect(driveConfiguration(configured)).toBeNull();
    },
  );
  it.each([
    { AUTH_ENABLED: "false" },
    { AUTH_ORIGIN: "http://localhost:5173" },
    { DRIVE_CLIENT_ID: "https://attacker.invalid" },
    { DRIVE_CLIENT_SECRET: "synthetic-invalid\nsecret" },
    { CREDENTIAL_KEYRING: "{}" },
    {
      CREDENTIAL_KEYRING: JSON.stringify({
        activeVersion: 1,
        keys: { "1": "invalid-key" },
      }),
    },
  ])("fails closed for invalid dependency %j", (change) => {
    expect(driveConfiguration({ ...bindings(), ...change })).toBeNull();
  });
  it("requires D1 without touching application identity", () => {
    const config = bindings();
    const noDb = { ...config };
    delete (noDb as { DB?: D1Database }).DB;
    expect(driveConfiguration(noDb)).toBeNull();
  });
});

async function mockedExchange(
  options: {
    claims?: Record<string, unknown>;
    header?: Record<string, unknown>;
    wrongSignature?: boolean;
    tokenChange?: Record<string, unknown>;
    userInfo?: Record<string, unknown>;
    keyChange?: Record<string, unknown>;
    duplicateKey?: boolean;
  } = {},
) {
  const fixture = await signed(
    options.claims ?? {},
    options.wrongSignature ?? false,
    options.header ?? {},
  );
  const key = { ...fixture.key, ...options.keyChange };
  const http = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (value) => {
      const request = value instanceof Request ? value : new Request(value);
      expect(request.redirect).toBe("manual");
      expect(request.signal.aborted).toBe(false);
      if (request.url === GOOGLE_TOKEN_ENDPOINT)
        return Response.json(tokens(fixture.jwt, options.tokenChange));
      if (request.url === "https://www.googleapis.com/oauth2/v3/certs")
        return Response.json({
          keys: options.duplicateKey ? [key, key] : [key],
        });
      if (request.url === "https://openidconnect.googleapis.com/v1/userinfo")
        return Response.json({
          sub,
          email: "drive-c@example.test",
          email_verified: true,
          ...options.userInfo,
        });
      throw new Error("Unexpected synthetic endpoint");
    });
  return { http, fixture };
}
const exchangeInput = { ...input, code: "synthetic-drive-code" };
const current = {
  accessToken: "synthetic-old-access",
  refreshToken: "synthetic-old-refresh",
  expiresAt: Date.now() + 3600000,
};
const expected = { subject: sub, address: "old-drive-address@example.test" };

describe("T18 Drive identity and scope adversaries", () => {
  it.each([
    { iss: "https://attacker.invalid" },
    { aud: "different-client.apps.googleusercontent.com" },
    { azp: "different-client.apps.googleusercontent.com" },
    { nonce: "different-synthetic-nonce" },
    { exp: 1 },
    { iat: Math.floor(Date.now() / 1000) + 3600 },
    { iat: 1 },
    { email_verified: false },
    { email: "not-an-email" },
    { sub: "" },
  ])("rejects signed unsupported identity claims %j", async (claims) => {
    await mockedExchange({ claims });
    await expect(
      createDriveAuthorization(configuration).exchange(exchangeInput),
    ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  });
  it("accepts Google's equivalent bare issuer and mutable display address without deriving identity from email", async () => {
    await mockedExchange({
      claims: { iss: "accounts.google.com" },
      userInfo: { email: "new-drive-address@example.test" },
    });
    const result =
      await createDriveAuthorization(configuration).exchange(exchangeInput);
    expect(result.identity).toEqual({
      subject: sub,
      address: "new-drive-address@example.test",
    });
  });
  it("rejects a signature made with a different real RSA key", async () => {
    await mockedExchange({ wrongSignature: true });
    await expect(
      createDriveAuthorization(configuration).exchange(exchangeInput),
    ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  });
  it.each(["none", "HS256"])(
    "rejects unapproved JWT algorithm %s",
    async (alg) => {
      await mockedExchange({ header: { alg } });
      await expect(
        createDriveAuthorization(configuration).exchange(exchangeInput),
      ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    },
  );
  it("never fetches JWT-selected key URLs", async () => {
    const { http } = await mockedExchange({
      header: {
        jku: "https://attacker.invalid/keys",
        x5u: "http://169.254.169.254/token",
      },
    });
    await expect(
      createDriveAuthorization(configuration).exchange(exchangeInput),
    ).resolves.toMatchObject({ identity: { subject: sub } });
    expect(
      http.mock.calls.map(([value]) =>
        value instanceof Request ? value.url : String(value),
      ),
    ).toEqual([
      GOOGLE_TOKEN_ENDPOINT,
      "https://www.googleapis.com/oauth2/v3/certs",
      "https://openidconnect.googleapis.com/v1/userinfo",
    ]);
  });
  it.each([
    { kid: "synthetic-other-key" },
    { kty: "oct" },
    { use: "enc" },
    { d: "synthetic-private-material" },
  ])(
    "rejects malformed or unselected provider public keys %j",
    async (keyChange) => {
      await mockedExchange({ keyChange });
      await expect(
        createDriveAuthorization(configuration).exchange(exchangeInput),
      ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    },
  );
  it("rejects ambiguous duplicate signing-key IDs", async () => {
    await mockedExchange({ duplicateKey: true });
    await expect(
      createDriveAuthorization(configuration).exchange(exchangeInput),
    ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  });
  it.each([
    { scope: undefined },
    { scope: "openid email profile" },
    { scope: `${scope} https://www.googleapis.com/auth/drive` },
    { scope: `${scope} https://www.googleapis.com/auth/gmail.readonly` },
    { scope: `${scope} https://www.googleapis.com/auth/calendar` },
  ])("rejects absent or broadened grants %j", async (tokenChange) => {
    const { http } = await mockedExchange({ tokenChange });
    await expect(
      createDriveAuthorization(configuration).exchange(exchangeInput),
    ).rejects.toMatchObject({ code: "MISSING_PERMISSION" });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("accepts only Google's documented email/profile aliases", async () => {
    await mockedExchange({
      tokenChange: {
        scope:
          "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.file",
      },
    });
    await expect(
      createDriveAuthorization(configuration).exchange(exchangeInput),
    ).resolves.toMatchObject({ canArchiveFiles: true });
  });
  it("requires an initial refresh token instead of silently creating an unusable grant", async () => {
    const { http } = await mockedExchange({
      tokenChange: { refresh_token: undefined },
    });
    await expect(
      createDriveAuthorization(configuration).exchange(exchangeInput),
    ).rejects.toMatchObject({ code: "MISSING_REFRESH_TOKEN" });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("requires a signed initial identity token", async () => {
    await mockedExchange({ tokenChange: { id_token: undefined } });
    await expect(
      createDriveAuthorization(configuration).exchange(exchangeInput),
    ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  });
  it.each([{ sub: "synthetic-other-drive-sub" }, { email_verified: false }])(
    "rejects conflicting opaque access identity %j",
    async (userInfo) => {
      await mockedExchange({ userInfo });
      await expect(
        createDriveAuthorization(configuration).exchange(exchangeInput),
      ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    },
  );
  it.each([
    { callback: "https://attacker.invalid/callback" },
    { verifier: "short" },
    { nonce: "" },
  ])(
    "rejects invalid callback challenge before token exchange %j",
    async (change) => {
      const { http } = await mockedExchange();
      await expect(
        createDriveAuthorization(configuration).exchange({
          ...exchangeInput,
          ...change,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(http).not.toHaveBeenCalled();
    },
  );
});

describe("T18 Drive independent refresh", () => {
  it("preserves the old refresh token when rotation and ID token are omitted", async () => {
    const { http } = await mockedExchange({
      tokenChange: {
        refresh_token: undefined,
        id_token: undefined,
        scope: undefined,
      },
      userInfo: { email: "renamed-drive@example.test" },
    });
    const result = await createDriveAuthorization(configuration).refresh(
      current,
      expected,
    );
    expect(result).toEqual({
      accessToken: "synthetic-drive-access",
      refreshToken: current.refreshToken,
      expiresAt: expect.any(Number),
    });
    expect(http).toHaveBeenCalledTimes(2);
    expect(expected.address).toBe("old-drive-address@example.test");
  });
  it("retains a rotated refresh token only after the same account is verified", async () => {
    await mockedExchange({
      tokenChange: {
        refresh_token: "synthetic-rotated-drive-refresh",
        id_token: undefined,
      },
    });
    await expect(
      createDriveAuthorization(configuration).refresh(current, expected),
    ).resolves.toMatchObject({
      refreshToken: "synthetic-rotated-drive-refresh",
    });
  });
  it("rejects a refreshed opaque access token belonging to another storage account", async () => {
    await mockedExchange({
      tokenChange: { id_token: undefined },
      userInfo: { sub: "synthetic-other-storage-sub" },
    });
    await expect(
      createDriveAuthorization(configuration).refresh(current, expected),
    ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  });
  it("cannot silently widen a refreshed grant", async () => {
    const { http } = await mockedExchange({
      tokenChange: {
        scope: `${scope} https://www.googleapis.com/auth/gmail.readonly`,
      },
    });
    await expect(
      createDriveAuthorization(configuration).refresh(current, expected),
    ).rejects.toMatchObject({ code: "MISSING_PERMISSION" });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("rejects missing stored refresh credentials without any request", async () => {
    const { http } = await mockedExchange();
    await expect(
      createDriveAuthorization(configuration).refresh(
        { accessToken: current.accessToken, expiresAt: current.expiresAt },
        expected,
      ),
    ).rejects.toMatchObject({ code: "RECONNECT_REQUIRED" });
    expect(http).not.toHaveBeenCalled();
  });
  it("rejects an unverified optional refresh ID token", async () => {
    await mockedExchange({ wrongSignature: true });
    await expect(
      createDriveAuthorization(configuration).refresh(current, expected),
    ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  });
  it.each([
    [400, { error: "invalid_grant" }, "RECONNECT_REQUIRED"],
    [400, { error: "invalid_scope" }, "MISSING_PERMISSION"],
    [401, { error: "unauthorized" }, "RECONNECT_REQUIRED"],
    [403, { error: "forbidden" }, "MISSING_PERMISSION"],
    [429, { error: "too_many_requests" }, "UNAVAILABLE"],
  ])(
    "classifies token failure %s without logging response details",
    async (status, body, code) => {
      const http = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json(body, { status }));
      await expect(
        createDriveAuthorization(configuration).refresh(current, expected),
      ).rejects.toMatchObject({ code, message: code });
      expect(http).toHaveBeenCalledTimes(1);
    },
  );
});

describe("T18 Drive bounded HTTP", () => {
  it("never follows redirects or leaked provider destinations", async () => {
    const http = vi.fn(async (request: Request) => {
      expect(request.redirect).toBe("manual");
      return new Response(null, {
        status: 307,
        headers: { Location: "https://attacker.invalid/token" },
      });
    });
    await expect(
      createDriveAuthorization(configuration, http).exchange(exchangeInput),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it.each([
    [
      "advertised",
      () =>
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": "65537",
          },
        }),
    ],
    [
      "stream",
      () =>
        new Response(" ".repeat(65537), {
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "JSON",
      () =>
        new Response("{", { headers: { "content-type": "application/json" } }),
    ],
    [
      "UTF8",
      () =>
        new Response(new Uint8Array([255]), {
          headers: { "content-type": "application/json" },
        }),
    ],
  ])("rejects malformed/oversized %s responses", async (_label, response) => {
    await expect(
      createDriveAuthorization(configuration, async () => response()).exchange(
        exchangeInput,
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("times out an uncooperative request", async () => {
    await expect(
      createDriveAuthorization(
        configuration,
        () => new Promise<Response>(() => {}),
        100,
      ).exchange(exchangeInput),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("times out and cancels an uncooperative response reader", async () => {
    const canceled = vi.fn();
    const http = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"access_token":'));
          },
          cancel() {
            canceled();
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    await expect(
      createDriveAuthorization(configuration, http, 100).exchange(
        exchangeInput,
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(canceled).toHaveBeenCalledTimes(1);
  });
  it("cancels an unread response settling after request timeout", async () => {
    let settle: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      settle = resolve;
    });
    const canceled = vi.fn();
    await expect(
      createDriveAuthorization(configuration, () => pending, 100).exchange(
        exchangeInput,
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
        },
        cancel() {
          canceled();
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    if (!response.body) throw new Error("Synthetic late body missing");
    const reader = vi.spyOn(response.body, "getReader");
    settle(response);
    await pending;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(reader).not.toHaveBeenCalled();
  });
  it("cancels an early-rejected oversized body before reading", async () => {
    const canceled = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled();
        },
      }),
      {
        headers: {
          "content-type": "application/json",
          "content-length": "65537",
        },
      },
    );
    await expect(
      createDriveAuthorization(configuration, async () => response).exchange(
        exchangeInput,
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(canceled).toHaveBeenCalledTimes(1);
  });
});

describe("T18 bounded signing-key and UserInfo requests", () => {
  it.each([
    "https://www.googleapis.com/oauth2/v3/certs",
    "https://openidconnect.googleapis.com/v1/userinfo",
  ])("bounds an oversized response from %s", async (target) => {
    const fixture = await signed();
    const canceled = vi.fn();
    const http = vi.fn(async (request: Request) => {
      if (request.url === target)
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              canceled();
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "content-length": "65537",
            },
          },
        );
      if (request.url === GOOGLE_TOKEN_ENDPOINT)
        return Response.json(tokens(fixture.jwt));
      if (request.url === "https://www.googleapis.com/oauth2/v3/certs")
        return Response.json({ keys: [fixture.key] });
      throw new Error("Unexpected synthetic bounded endpoint");
    });
    await expect(
      createDriveAuthorization(configuration, http).exchange(exchangeInput),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(http.mock.calls.some(([request]) => request.url === target)).toBe(
      true,
    );
  });
  it.each([
    "https://www.googleapis.com/oauth2/v3/certs",
    "https://openidconnect.googleapis.com/v1/userinfo",
  ])(
    "cancels an unread late response from %s after timeout",
    async (target) => {
      const fixture = await signed();
      let settle: (response: Response) => void = () => {};
      const pending = new Promise<Response>((resolve) => {
        settle = resolve;
      });
      const http = vi.fn(async (request: Request) => {
        if (request.url === target) return pending;
        if (request.url === GOOGLE_TOKEN_ENDPOINT)
          return Response.json(tokens(fixture.jwt));
        if (request.url === "https://www.googleapis.com/oauth2/v3/certs")
          return Response.json({ keys: [fixture.key] });
        throw new Error("Unexpected synthetic late endpoint");
      });
      await expect(
        createDriveAuthorization(configuration, http, 100).exchange(
          exchangeInput,
        ),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
      const canceled = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled();
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
      if (!response.body)
        throw new Error("Synthetic late endpoint body missing");
      const read = vi.spyOn(response.body, "getReader");
      settle(response);
      await pending;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(canceled).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
      expect(
        http.mock.calls
          .map(([request]) => request.url)
          .filter((url) => url === target),
      ).toHaveLength(1);
    },
  );
});

describe("T18 Drive authorization JSON response chunk budgets", () => {
  async function fragmentedToken(empty: number, oneByte: boolean) {
    const fixture = await signed();
    const canceled = vi.fn();
    const value = new TextEncoder().encode(
      JSON.stringify(tokens(fixture.jwt)) + (oneByte ? " ".repeat(4097) : ""),
    );
    let offset = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (empty > 0) {
            empty--;
            controller.enqueue(new Uint8Array(0));
            return;
          }
          if (offset >= value.length) {
            controller.close();
            return;
          }
          const width = oneByte ? 1 : 73;
          controller.enqueue(value.subarray(offset, offset + width));
          offset += width;
        },
        cancel() {
          canceled();
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const http = vi.fn(async (request: Request) => {
      if (request.url === GOOGLE_TOKEN_ENDPOINT) return response;
      if (request.url === "https://www.googleapis.com/oauth2/v3/certs")
        return Response.json({ keys: [fixture.key] });
      if (request.url === "https://openidconnect.googleapis.com/v1/userinfo")
        return Response.json({
          sub,
          email: "drive-c@example.test",
          email_verified: true,
        });
      throw new Error("Unexpected synthetic fragmented endpoint");
    });
    return { http, canceled };
  }
  it("rejects a finite token response with 33 empty chunks before any identity publication", async () => {
    const { http, canceled } = await fragmentedToken(33, false);
    await expect(
      createDriveAuthorization(configuration, http).exchange(exchangeInput),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("rejects over 4096 tiny token chunks even when total JSON bytes fit", async () => {
    const { http, canceled } = await fragmentedToken(0, true);
    await expect(
      createDriveAuthorization(configuration, http).exchange(exchangeInput),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("checks elapsed deadline while finite token reads starve timer delivery", async () => {
    const fixture = await signed();
    const start = Date.now();
    const value = new TextEncoder().encode(JSON.stringify(tokens(fixture.jwt)));
    let offset = 0;
    let delivered = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= value.length) {
            controller.close();
            return;
          }
          controller.enqueue(value.subarray(offset, offset + 73));
          offset += 73;
          delivered++;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const http = async (request: Request) => {
      if (request.url === GOOGLE_TOKEN_ENDPOINT) return response;
      if (request.url === "https://www.googleapis.com/oauth2/v3/certs")
        return Response.json({ keys: [fixture.key] });
      if (request.url === "https://openidconnect.googleapis.com/v1/userinfo")
        return Response.json({
          sub,
          email: "drive-c@example.test",
          email_verified: true,
        });
      throw new Error("Unexpected synthetic deadline endpoint");
    };
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => start + delivered * 60);
    try {
      await expect(
        createDriveAuthorization(configuration, http, 100).exchange(
          exchangeInput,
        ),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    } finally {
      clock.mockRestore();
    }
  });
  it("accepts normally fragmented token JSON with 32 bounded empty chunks", async () => {
    const { http } = await fragmentedToken(32, false);
    await expect(
      createDriveAuthorization(configuration, http).exchange(exchangeInput),
    ).resolves.toMatchObject({
      identity: { subject: sub },
      canArchiveFiles: true,
    });
    expect(http).toHaveBeenCalledTimes(3);
  });
});
