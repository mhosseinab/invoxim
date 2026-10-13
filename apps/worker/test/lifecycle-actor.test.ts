import { env } from "cloudflare:workers";
import { profileViewSchema } from "@invoxim/contracts";
import type { OnboardingSession } from "@invoxim/core";
import { expect, it, vi } from "vitest";
import { issueWorkspaceMutationToken } from "../../../packages/adapters/src/corrections/workspace-token";
import worker from "../src/index";
import { owner } from "./onboarding-qa-fixture";

const db = env.DB;

const origin = "https://qa-lifecycle-actor.example.invalid";
const secret = "synthetic-lifecycle-actor-auth-secret-never-live-123";
function tokenFrom(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    "mutationToken" in value &&
    typeof value.mutationToken === "string"
    ? value.mutationToken
    : undefined;
}
async function fixture(prefix: string) {
  const a = await owner(`${prefix}-a`, "same-mailbox-id"),
    b = await owner(`${prefix}-b`, "same-mailbox-id"),
    created = Date.now();
  for (const session of [a, b])
    await db
      .prepare("UPDATE session SET createdAt=?,updatedAt=? WHERE id=?")
      .bind(created, created, session.sessionId)
      .run();
  for (const session of [a, b]) {
    const consent = `pc-${session.tenant.userId}`;
    await db
      .prepare(
        "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES(?,?,'same-mailbox-id',1,'synthetic','local',0,0,1)",
      )
      .bind(consent, session.tenant.userId)
      .run();
    await db
      .prepare(
        "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES(?,?,'same-mailbox-id',?,1,'source-extract',?,'ready',0)",
      )
      .bind(
        `job-${session.tenant.userId}`,
        session.tenant.userId,
        consent,
        `job-${session.tenant.userId}`,
      )
      .run();
  }
  const markers: unknown[] = [];
  const journal: Fetcher = {
    async fetch(input, init) {
      expect(String(input)).toBe(
        "https://deletion-journal.invalid/v1/deletions",
      );
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      if (typeof init?.body !== "string")
        throw new Error("Synthetic journal body missing");
      markers.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    },
    connect() {
      throw new Error("Synthetic journal has no socket interface");
    },
  };
  const common = {
    DB: env.DB,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: origin,
    AUTH_SECRET: secret,
    AUTH_GOOGLE_CLIENT_ID: "synthetic",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic",
    AUTH_ALLOWED_EMAILS: JSON.stringify([a.loginEmail, b.loginEmail]),
    LIFECYCLE_ENABLED: "true",
    DELETION_JOURNAL_SECRET: "synthetic-journal-secret-never-live-12345",
  };
  const bindings = { ...common, DELETION_JOURNAL: journal };
  async function request(
    session: OnboardingSession,
    path: string,
    method = "GET",
    body?: unknown,
    workspaceToken?: string,
    withJournal = true,
  ) {
    const sessionToken = await db
      .prepare("SELECT token FROM session WHERE id=? AND userId=?")
      .bind(session.sessionId, session.tenant.userId)
      .first<string>("token");
    if (!sessionToken) throw new Error("Synthetic signed session absent");
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(sessionToken),
      );
    const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${sessionToken}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
    return worker.fetch(
      new Request(`${origin}${path}`, {
        method,
        headers: {
          Cookie: cookie,
          ...(method !== "GET"
            ? {
                Origin: origin,
                "Content-Type": "application/json",
                "Idempotency-Key": "qa-lifecycle-actor-stable-key",
              }
            : {}),
          ...(workspaceToken ? { "X-Workspace-Token": workspaceToken } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      withJournal ? bindings : common,
    );
  }
  async function capabilities(session: OnboardingSession) {
    const response = await request(session, "/api/lifecycle/capabilities");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body: unknown = await response.json();
    return tokenFrom(body);
  }
  async function state(session: OnboardingSession) {
    return {
      profile: await db
        .prepare("SELECT status,version FROM profiles WHERE user_id=?")
        .bind(session.tenant.userId)
        .first(),
      sessions: (
        await db
          .prepare(
            "SELECT id,createdAt,expiresAt FROM session WHERE userId=? ORDER BY id",
          )
          .bind(session.tenant.userId)
          .all()
      ).results,
      commands: await db
        .prepare("SELECT COUNT(*) n FROM lifecycle_commands WHERE user_id=?")
        .bind(session.tenant.userId)
        .first("n"),
      deletion: await db
        .prepare("SELECT COUNT(*) n FROM lifecycle_deletions WHERE user_id=?")
        .bind(session.tenant.userId)
        .first("n"),
      jobs: (
        await db
          .prepare(
            "SELECT id,status,consent_id,connection_generation,fence,lease_id,lease_expires_at,outcome_code FROM jobs WHERE user_id=? ORDER BY id",
          )
          .bind(session.tenant.userId)
          .all()
      ).results,
      connections: (
        await db
          .prepare(
            "SELECT id,state,scheduling_state,generation,credential_version,credential_ciphertext,credential_key_version,next_sync_at FROM connections WHERE user_id=? ORDER BY id",
          )
          .bind(session.tenant.userId)
          .all()
      ).results,
    };
  }
  return { a, b, markers, request, capabilities, state };
}

it("T16 actual A deletion form with B cookie cannot fence B or append its deletion journal; current B token is a positive control", async () => {
  const f = await fixture("qa-t16-delete-actor"),
    tokenA = await f.capabilities(f.a),
    profileA = await f.request(f.a, "/api/me"),
    profileB = await f.request(f.b, "/api/me");
  if (!tokenA)
    throw new Error("Actor A capabilities did not issue a lifecycle token");
  const a = profileViewSchema.parse(await profileA.json()),
    b = profileViewSchema.parse(await profileB.json());
  expect(a.settings.version).toBe(b.settings.version);
  const body = { confirmed: true, version: a.settings.version },
    beforeB = await f.state(f.b),
    beforeA = await f.state(f.a);
  const denied = await f.request(
      f.b,
      "/api/account/delete",
      "POST",
      body,
      tokenA,
    ),
    actual: unknown = await denied.json();
  expect(
    denied.status,
    JSON.stringify({
      response: actual,
      b: await f.state(f.b),
      journal: f.markers,
    }),
  ).toBe(403);
  expect(await f.state(f.b)).toEqual(beforeB);
  expect(await f.state(f.a)).toEqual(beforeA);
  expect(f.markers).toEqual([]);
  const tokenB = await f.capabilities(f.b);
  if (!tokenB)
    throw new Error("Current capabilities did not issue lifecycle token");
  const accepted = await f.request(
    f.b,
    "/api/account/delete",
    "POST",
    body,
    tokenB,
  );
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toMatchObject({
    status: "cleanup_pending",
    accessDisabled: true,
  });
  expect(f.markers).toHaveLength(1);
  expect(f.markers[0]).toMatchObject({ userId: f.b.tenant.userId });
  expect(await f.state(f.a)).toEqual(beforeA);
  expect((await f.state(f.b)).profile).toMatchObject({ status: "deleting" });
  expect((await f.state(f.b)).jobs).toMatchObject([
    { status: "canceled", outcome_code: "account_deleted" },
  ]);
  expect((await f.state(f.b)).connections).toMatchObject([
    {
      state: "disconnected",
      scheduling_state: "paused",
      generation: 2,
      credential_ciphertext: null,
    },
  ]);
});

it("T16 lifecycle mutations reject missing expired and other-purpose tokens without side effects; recent auth and journal prerequisites remain", async () => {
  const f = await fixture("qa-t16-delete-controls"),
    before = await f.state(f.b),
    body = { confirmed: true, version: 1 };
  for (const [path, method, data] of [
    ["/api/account/delete", "POST", body],
    [
      "/api/connections/same-mailbox-id",
      "DELETE",
      { confirmed: true, generation: 1, credentialVersion: 1 },
    ],
    ["/api/connections/same-mailbox-id/delete-data-preview", "POST", {}],
    [
      "/api/connections/same-mailbox-id/delete-data",
      "POST",
      { confirmed: true, generation: 1, previewFingerprint: "a".repeat(64) },
    ],
  ] as const)
    expect((await f.request(f.b, path, method, data)).status).toBe(403);
  for (const purpose of ["corrections", "ai-settings"] as const) {
    const other = await issueWorkspaceMutationToken(
      { userId: f.b.tenant.userId, sessionId: f.b.sessionId },
      secret,
      Date.now,
      purpose,
    );
    expect(
      (await f.request(f.b, "/api/account/delete", "POST", body, other)).status,
    ).toBe(403);
  }
  let expired: string | undefined;
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 600001);
  try {
    expired = await f.capabilities(f.b);
  } finally {
    clock.mockRestore();
  }
  if (!expired) throw new Error("Expiry positive fixture token missing");
  expect(
    (await f.request(f.b, "/api/account/delete", "POST", body, expired)).status,
  ).toBe(403);
  const token = await f.capabilities(f.b);
  if (!token) throw new Error("Current capabilities token missing");
  expect(
    (await f.request(f.b, "/api/account/delete", "POST", body, token, false))
      .status,
  ).toBe(503);
  expect(await f.state(f.b)).toEqual(before);
  expect(f.markers).toEqual([]);
  await db
    .prepare("UPDATE session SET createdAt=? WHERE id=?")
    .bind(Date.now() - 3600001, f.b.sessionId)
    .run();
  const stale = await f.state(f.b);
  expect(
    (await f.request(f.b, "/api/account/delete", "POST", body, token)).status,
  ).toBe(403);
  expect(await f.state(f.b)).toEqual(stale);
  expect(f.markers).toEqual([]);
  const second: OnboardingSession = {
    ...f.b,
    sessionId: `${f.b.sessionId}-second`,
  };
  await db
    .prepare(
      "INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,9999999999999,?,?,?,?)",
    )
    .bind(
      second.sessionId,
      `synthetic-second-${f.b.tenant.userId}`,
      Date.now(),
      Date.now(),
      f.b.tenant.userId,
    )
    .run();
  const beforeSecond = await f.state(f.b);
  expect(
    (await f.request(second, "/api/account/delete", "POST", body, token))
      .status,
  ).toBe(403);
  expect(await f.state(f.b)).toEqual(beforeSecond);
  expect(f.markers).toEqual([]);
  const currentSecond = await f.capabilities(second);
  expect(typeof currentSecond).toBe("string");
});
