import { env } from "cloudflare:workers";
import type { JobLease, TenantContext } from "@invoxim/core";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { createOutlookDiscoveryProviderFactory } from "../../../packages/adapters/src/discovery/outlook-provider-factory";
import {
  OUTLOOK_AUTHORIZATION_SCOPES,
  type OutlookConfiguration,
} from "../../../packages/adapters/src/mailbox/outlook-configuration";
import { createOutlookContentFactory } from "../../../packages/adapters/src/pipeline/outlook-factory";
import { createCredentialCipher } from "../../../packages/adapters/src/security/cipher";
import { createCredentialVault } from "../../../packages/adapters/src/security/vault";

const db = env.DB;
const cipher = createCredentialCipher({
  activeVersion: 1,
  keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
});
const configuration: OutlookConfiguration = {
  login: {
    origin: "https://synthetic.example",
    secret: "synthetic-login-secret-long-enough-for-tests",
    googleClientId: "synthetic-google-id",
    googleClientSecret: "synthetic-google-secret",
    allowedEmails: ["synthetic@example.invalid"],
  },
  clientId: "11111111-1111-4111-8111-111111111111",
  clientSecret: "synthetic-outlook-secret",
  authority: "common",
  provider: "outlook",
  oauthProvider: "microsoft",
  callback: "https://synthetic.example/api/oauth/mailbox/outlook/callback",
  limit: 3,
  cipher,
  scopes: OUTLOOK_AUTHORIZATION_SCOPES,
};
beforeAll(async () => {
  for (const statement of baseline.split(";").filter((value) => value.trim()))
    await db.prepare(statement).run();
});
afterEach(() => vi.restoreAllMocks());
let sequence = 0;
async function fixture(
  options: {
    expired?: boolean;
    provider?: "outlook" | "gmail";
    refreshToken?: boolean;
  } = {},
) {
  const id = `outlook-factory-${++sequence}`;
  const context = { userId: id, authority: "job" } as TenantContext;
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
    )
    .bind(id, id, `${id}@example.invalid`)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind(id)
    .run();
  const connectionId = `connection-${id}`;
  const ciphertext = await cipher.seal(
    context,
    { entityId: connectionId, purpose: "mailbox-credentials" },
    {
      accessToken: "synthetic-access",
      expiresAt: Date.now() + (options.expired ? -1000 : 3600000),
      ...(options.refreshToken === false
        ? {}
        : { refreshToken: "synthetic-refresh" }),
    },
  );
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state,generation,credential_version,credential_key_version,credential_ciphertext,scopes) VALUES(?,?,'mailbox',?,?,?,'connected',1,1,1,?,?)",
    )
    .bind(
      connectionId,
      id,
      options.provider ?? "outlook",
      "https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222/v2.0|synthetic-sub",
      `${id}@example.invalid`,
      ciphertext,
      JSON.stringify(OUTLOOK_AUTHORIZATION_SCOPES),
    )
    .run();
  const lease: JobLease = {
    context,
    connectionId,
    generation: 1,
    jobId: `job-${id}`,
    consentId: "synthetic-consent",
    syncStateId: null,
    type: "extraction",
    leaseId: "synthetic-lease",
    fence: 1,
    expiresAt: Date.now() + 60000,
    attempt: 1,
  };
  return { context, connectionId, lease };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Kind = "discovery" | "content";
function open(
  kind: Kind,
  value: Fixture,
  signal = new AbortController().signal,
  checkpoint = async () => true,
) {
  return kind === "discovery"
    ? createOutlookDiscoveryProviderFactory(db, configuration).open(
        value.context,
        {
          connectionId: value.connectionId,
          generation: value.lease.generation,
        },
        signal,
      )
    : createOutlookContentFactory(db, configuration).open(value.lease, {
        signal,
        checkpoint,
      });
}
function authCode(kind: Kind) {
  return kind === "discovery" ? "AUTH_REQUIRED" : "CONTENT_AUTH_REQUIRED";
}
async function read(
  kind: Kind,
  port: Awaited<ReturnType<typeof open>>,
  value: Fixture,
  signal = new AbortController().signal,
) {
  if (kind === "discovery" && "folders" in port)
    return port.folders({ signal });
  if ("load" in port)
    return port.load({
      connectionId: value.connectionId,
      providerMessageId: "synthetic-message",
      signal,
      checkpoint: async () => true,
    });
  throw new Error("Synthetic port mismatch");
}
function transport(
  options: { revoked?: boolean; duringRefresh?: () => Promise<void> } = {},
) {
  const requests: { url: string; authorization: string | null }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    if (url === "https://login.microsoftonline.com/common/oauth2/v2.0/token") {
      await options.duringRefresh?.();
      if (options.revoked)
        return Response.json(
          {
            error: "invalid_grant",
            error_description: "synthetic-private-provider-detail",
          },
          { status: 400 },
        );
      return Response.json({
        access_token: "synthetic-refreshed-access",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid profile email https://graph.microsoft.com/Mail.Read",
      });
    }
    if (url === "https://graph.microsoft.com/oidc/userinfo")
      return Response.json({
        sub: "synthetic-sub",
        email: "synthetic@example.invalid",
      });
    if (url.startsWith("https://graph.microsoft.com/v1.0/me/mailFolders?"))
      return Response.json({ value: [] });
    if (
      url ===
      "https://graph.microsoft.com/v1.0/me/messages/synthetic-message/attachments?$top=8"
    )
      return Response.json({ value: [] });
    if (
      url.startsWith(
        "https://graph.microsoft.com/v1.0/me/messages/synthetic-message?",
      )
    )
      return Response.json({
        id: "synthetic-message",
        body: { contentType: "text", content: "Synthetic receipt" },
        hasAttachments: false,
      });
    throw new Error("Unexpected synthetic endpoint");
  });
  return requests;
}

it.each(["discovery", "content"] as const)(
  "T17 %s opens fresh Outlook credentials and reads only Graph without refresh",
  async (kind) => {
    const value = await fixture();
    const requests = transport();
    const port = await open(kind, value);
    await read(kind, port, value);
    expect(requests).toHaveLength(kind === "discovery" ? 1 : 2);
    expect(requests[0]?.url).toMatch(
      /^https:\/\/graph.microsoft.com\/v1.0\/me\//,
    );
    expect(requests[0]?.authorization).toBe("Bearer synthetic-access");
    if ("folders" in port) expect(port).not.toHaveProperty("captureAnchor");
  },
);

it.each(["discovery", "content"] as const)(
  "T17 %s refreshes expired credentials through fenced mailbox service and retains refresh token",
  async (kind) => {
    const value = await fixture({ expired: true });
    const requests = transport();
    await read(kind, await open(kind, value), value);
    expect(requests).toHaveLength(kind === "discovery" ? 3 : 4);
    expect(requests[2]?.authorization).toBe(
      "Bearer synthetic-refreshed-access",
    );
    expect(
      await createCredentialVault(db, cipher).read(value.context, {
        kind: "connection",
        id: value.connectionId,
        generation: 1,
      }),
    ).toMatchObject({
      version: 2,
      secret: {
        refreshToken: "synthetic-refresh",
        accessToken: "synthetic-refreshed-access",
      },
    });
  },
);

it.each(["discovery", "content"] as const)(
  "T17 %s rejects revoked refresh without leaking provider details or reading Graph content",
  async (kind) => {
    const value = await fixture({ expired: true });
    const requests = transport({ revoked: true });
    await expect(open(kind, value)).rejects.toMatchObject({
      code: authCode(kind),
      message: authCode(kind),
    });
    expect(requests).toHaveLength(1);
    expect(
      await db
        .prepare("SELECT state FROM connections WHERE user_id=? AND id=?")
        .bind(value.context.userId, value.connectionId)
        .first("state"),
    ).toBe("needs_reconnect");
  },
);

it.each(["discovery", "content"] as const)(
  "T17 %s never reads tokens for a different tenant, provider or generation",
  async (kind) => {
    const value = await fixture();
    const other = await fixture();
    const gmail = await fixture({ provider: "gmail" });
    const requests = transport();
    await expect(
      open(kind, {
        ...value,
        context: other.context,
        lease: { ...value.lease, context: other.context },
      }),
    ).rejects.toMatchObject({ code: authCode(kind) });
    await expect(open(kind, gmail)).rejects.toMatchObject({
      code: authCode(kind),
    });
    await expect(
      open(kind, { ...value, lease: { ...value.lease, generation: 2 } }),
    ).rejects.toMatchObject({ code: authCode(kind) });
    expect(requests).toEqual([]);
  },
);

it.each(["discovery", "content"] as const)(
  "T17 %s abort prevents starting a token refresh",
  async (kind) => {
    const value = await fixture({ expired: true });
    const controller = new AbortController();
    controller.abort();
    const requests = transport();
    await expect(open(kind, value, controller.signal)).rejects.toMatchObject({
      code: kind === "discovery" ? "UNAVAILABLE" : "CONTENT_AUTH_CHANGED",
    });
    expect(requests).toEqual([]);
  },
);

it("T17 content checkpoint denial prevents opening or refreshing credentials", async () => {
  const value = await fixture({ expired: true });
  const requests = transport();
  await expect(
    open("content", value, new AbortController().signal, async () => false),
  ).rejects.toMatchObject({ code: "CONTENT_AUTH_CHANGED" });
  expect(requests).toEqual([]);
});

it.each(["discovery", "content"] as const)(
  "T17 %s generation change during refresh rejects the stale result and prevents Graph content calls",
  async (kind) => {
    const value = await fixture({ expired: true });
    const requests = transport({
      duringRefresh: async () => {
        await db
          .prepare(
            "UPDATE connections SET generation=generation+1,credential_version=credential_version+1,state='disconnected',scheduling_state='paused',credential_ciphertext=NULL,credential_key_version=NULL WHERE user_id=? AND id=?",
          )
          .bind(value.context.userId, value.connectionId)
          .run();
      },
    });
    await expect(open(kind, value)).rejects.toMatchObject({
      code: kind === "discovery" ? "UNAVAILABLE" : "CONTENT_UNAVAILABLE",
    });
    expect(requests).toHaveLength(2);
    expect(
      await db
        .prepare(
          "SELECT generation,credential_version,credential_ciphertext,state FROM connections WHERE user_id=? AND id=?",
        )
        .bind(value.context.userId, value.connectionId)
        .first(),
    ).toMatchObject({
      generation: 2,
      credential_version: 2,
      credential_ciphertext: null,
      state: "disconnected",
    });
  },
);

it.each(["discovery", "content"] as const)(
  "T17 %s cannot refresh an expired credential without a refresh token",
  async (kind) => {
    const value = await fixture({ expired: true, refreshToken: false });
    const requests = transport();
    await expect(open(kind, value)).rejects.toMatchObject({
      code: authCode(kind),
    });
    expect(requests).toEqual([]);
  },
);

it.each(["discovery", "content"] as const)(
  "T17 %s abort during refresh prevents returning a content or discovery reader",
  async (kind) => {
    const value = await fixture({ expired: true });
    const controller = new AbortController();
    const requests = transport({
      duringRefresh: async () => controller.abort(),
    });
    await expect(open(kind, value, controller.signal)).rejects.toMatchObject({
      code: kind === "discovery" ? "UNAVAILABLE" : "CONTENT_AUTH_CHANGED",
    });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.url)).toEqual([
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      "https://graph.microsoft.com/oidc/userinfo",
    ]);
  },
);

it("T17 content checkpoint revocation during refresh prevents returning a reader", async () => {
  const value = await fixture({ expired: true });
  let valid = true;
  const requests = transport({
    duringRefresh: async () => {
      valid = false;
    },
  });
  await expect(
    open("content", value, new AbortController().signal, async () => valid),
  ).rejects.toMatchObject({ code: "CONTENT_AUTH_CHANGED" });
  expect(requests).toHaveLength(2);
});
