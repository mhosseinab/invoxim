import { expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { planDiscoveryRange } from "../../../packages/core/src/discovery/calendar";

it("RECENT-01 default calendar year splits recent30 before the remaining approved history across Vienna DST", () => {
  const plan = planDiscoveryRange({
    cutoffMs: Date.parse("2024-04-01T10:00:00Z"),
    timezone: "Europe/Vienna",
  });
  expect(plan.range.startMs).toBe(Date.parse("2023-04-01T10:00:00Z"));
  expect(plan.recent.startMs).toBe(Date.parse("2024-03-02T11:00:00Z"));
  expect(plan.older?.startMs).toBe(plan.range.startMs);
  expect(plan.older?.cutoffMs).toBe(plan.recent.startMs);
  expect(plan.recent.cutoffMs).toBe(plan.range.cutoffMs);
});
it("RECENT-02 short explicit approved range clamps recent slice and omits empty older", () => {
  const startMs = Date.parse("2024-03-25T11:00:00Z");
  const cutoffMs = Date.parse("2024-04-01T10:00:00Z");
  expect(
    planDiscoveryRange({ startMs, cutoffMs, timezone: "Europe/Vienna" }),
  ).toMatchObject({ recent: { startMs, cutoffMs }, older: null });
});
it("RECENT-01 rejects numeric timezone offsets that are not approved profile IANA zones", () => {
  expect(() =>
    planDiscoveryRange({
      cutoffMs: Date.parse("2024-04-01T10:00:00Z"),
      timezone: "+01:00",
    }),
  ).toThrow("INVALID_RANGE");
});

import { vi } from "vitest";
import { createGmailDiscovery } from "../../../packages/adapters/src/discovery/gmail";

it("GMAIL-02 opaque history anchor is read from fixed metadata-only Gmail endpoint without content", async () => {
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const url =
        typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
      expect(url.origin).toBe("https://gmail.googleapis.com");
      expect(url.pathname).toBe("/gmail/v1/users/me/profile");
      expect(url.searchParams.get("fields")).toBe("historyId");
      return Response.json({ historyId: "99999999999999999999999" });
    });
  try {
    expect(
      await createGmailDiscovery("synthetic-access").anchor(
        new AbortController().signal,
      ),
    ).toBe("99999999999999999999999");
    expect(transport).toHaveBeenCalledTimes(1);
  } finally {
    transport.mockRestore();
  }
});

import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { createDiscoveryService } from "../../../packages/adapters/src/discovery/service";

it("ONBOARD-02/RECENT-09 internal import refuses missing accepted consent before any provider or durable work", async () => {
  const open = vi.fn();
  const allow = vi.fn(async () => false);
  const service = createDiscoveryService(db, {
    providers: { open },
    readiness: { allow },
    remainingStatements: () => 40,
  });
  const context = {
    userId: "synthetic-not-authorized",
    authority: "session",
  } as TenantContext;
  await expect(
    service.beginAcceptedImport(context, {
      connectionId: "missing",
      generation: 1,
      consentId: "missing",
      fingerprint: "synthetic-key",
      cutoffMs: Date.now(),
      timezone: "UTC",
      queryMode: "filtered",
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(open).not.toHaveBeenCalled();
});

import { beforeAll } from "vitest";

beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
});
it("GMAIL-07 metadata deletion returns an unavailable source reference rather than deleting structured records", async () => {
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 404 }));
  try {
    expect(
      await createGmailDiscovery("synthetic-access").metadata(
        "gone-message",
        "filtered",
        new AbortController().signal,
      ),
    ).toMatchObject({ id: "gone-message", available: false });
  } finally {
    transport.mockRestore();
  }
});

import { createJobStore } from "@invoxim/adapters";
import type { DiscoveryProviderPort } from "@invoxim/core";

const now = Date.parse("2024-04-01T10:00:00Z");
const owner = {
  userId: "discovery-owner",
  authority: "session",
} as TenantContext;
const input = {
  connectionId: "inbox",
  generation: 1,
  consentId: "accepted",
  fingerprint: "approved-synthetic-range",
  cutoffMs: now,
  timezone: "UTC",
  queryMode: "filtered" as const,
};
function syntheticProvider(): DiscoveryProviderPort {
  return {
    anchor: async () => "9999999999999999999999",
    list: async () => ({ ids: ["recent-a", "recent-b"] }),
    metadata: async (id) => ({
      id,
      receivedAtMs: now - 3600000,
      available: true,
      excluded: false,
      candidate: "unknown",
    }),
    history: async () => ({ ids: [], historyId: "9999999999999999999999" }),
  };
}
async function seedAccepted() {
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)",
    )
    .bind(owner.userId, "Synthetic", "discovery@example.invalid", now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
    )
    .bind(owner.userId, now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes,credential_ciphertext,credential_key_version) VALUES(?,?,'mailbox','gmail','mailbox-subject','mailbox@example.invalid',?,?,1)",
    )
    .bind(
      input.connectionId,
      owner.userId,
      JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
      "synthetic-ciphertext-marker-not-a-live-token",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES(?,?,?,1,'synthetic-approved','synthetic-local',1,?,1)",
    )
    .bind(input.consentId, owner.userId, input.connectionId, now)
    .run();
}
it("RECENT-03/09 accepted recent page durably stages references and processing outbox before older discovery without bodies", async () => {
  await seedAccepted();
  const provider = syntheticProvider();
  const options = {
    providers: { open: async () => provider },
    readiness: { allow: async () => true },
    remainingStatements: () => 40,
    clock: () => now,
  };
  const service = createDiscoveryService(db, options);
  const run = await service.beginAcceptedImport(owner, input);
  const pending = await db
    .prepare(
      "SELECT id FROM jobs WHERE user_id=? AND type='discover' AND status='ready'",
    )
    .bind(owner.userId)
    .first<{ id: string }>();
  if (!pending) throw new Error("Synthetic discovery job missing");
  const store = createJobStore(db, {
    processingReview: null,
    clock: () => now,
    policy: {
      dispatchLimit: 10,
      scheduleLimit: 10,
      tenantConcurrency: 2,
      globalConcurrency: 4,
      maxAttempts: 5,
      leaseMs: 60000,
      redeliveryMs: 60000,
      queryLimit: 40,
    },
  });
  const lease = await store.claim(pending.id);
  if (!lease) throw new Error("Synthetic discovery lease missing");
  const handler = createDiscoveryService(db, options);
  await handler.runPage(lease, {
    signal: new AbortController().signal,
    checkpoint: () => store.checkpoint(lease),
  });
  const sources = await db
    .prepare(
      "SELECT provider_message_id,received_at FROM source_messages WHERE user_id=? ORDER BY provider_message_id",
    )
    .bind(owner.userId)
    .all();
  expect(sources.results).toHaveLength(2);
  const extraction = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND type='source-extract'",
    )
    .bind(owner.userId)
    .first<{ n: number }>();
  expect(extraction?.n).toBe(2);
  const parent = await db
    .prepare(
      "SELECT stage,completed_at FROM import_runs WHERE user_id=? AND id=?",
    )
    .bind(owner.userId, run.importRunId)
    .first();
  expect(parent?.completed_at).toBeNull();
});

import { gmailConfiguration } from "@invoxim/adapters";
import { createGmailDiscoveryProviderFactory } from "../../../packages/adapters/src/discovery/provider-factory";

const db = env.DB;

it("GMAIL-04 credential factory rejects absent owned credentials before metadata transport", async () => {
  const configuration = gmailConfiguration({
    DB: env.DB,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://synthetic.example",
    AUTH_SECRET: "synthetic-auth-secret-not-used-in-production-123",
    AUTH_GOOGLE_CLIENT_ID: "login-client",
    AUTH_GOOGLE_CLIENT_SECRET: "login-secret",
    AUTH_ALLOWED_EMAILS: '["synthetic@example.invalid"]',
    GMAIL_ENABLED: "true",
    GMAIL_CLIENT_ID: "mail-client",
    GMAIL_CLIENT_SECRET: "mail-secret",
    CREDENTIAL_KEYRING: JSON.stringify({
      activeVersion: 1,
      keys: {
        1: btoa(String.fromCharCode(...new Uint8Array(32).fill(3)))
          .replace(/=/g, "")
          .replace(/\+/g, "-")
          .replace(/\//g, "_"),
      },
    }),
  });
  if (!configuration) throw new Error("Synthetic keyring unavailable");
  await expect(
    createGmailDiscoveryProviderFactory(db, configuration).open(
      owner,
      { connectionId: "missing-connection", generation: 1 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
});
it("GMAIL-05 unsupported numeric Retry-After overflow pauses rather than silently shortening the provider minimum", async () => {
  const transport = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, {
      status: 429,
      headers: { "Retry-After": "9".repeat(400) },
    }),
  );
  try {
    await expect(
      createGmailDiscovery("synthetic-access").anchor(
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 86400001 });
  } finally {
    transport.mockRestore();
  }
});

it("PIPE-3/P1 consent review hands the readiness port only a selection valid under the shared schema", async () => {
  const userId = "discovery-schema-owner";
  const digest = "a".repeat(64);
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)",
    )
    .bind(userId, "Synthetic", "discovery-schema@example.invalid", now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
    )
    .bind(userId, now, now)
    .run();
  // revision 0 = never-configured AI settings; the shared schema requires >=1.
  await db
    .prepare(
      "INSERT INTO ai_settings(user_id,mode,provider_id,model_id,config_version,revision,consent_version) VALUES(?,'hosted','synthetic-approved','synthetic-model','synthetic-config',0,0)",
    )
    .bind(userId)
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes,credential_ciphertext,credential_key_version) VALUES(?,?,'mailbox','gmail','schema-subject','schema@example.invalid',?,?,1)",
    )
    .bind(
      input.connectionId,
      userId,
      JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
      "synthetic-ciphertext-marker-not-a-live-token",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized,accepted_configuration_digest) VALUES(?,?,?,0,'synthetic-approved','synthetic-local',0,?,1,?)",
    )
    .bind(input.consentId, userId, input.connectionId, now, digest)
    .run();
  const open = vi.fn(async () => syntheticProvider());
  const allow = vi.fn(async () => true);
  const service = createDiscoveryService(db, {
    providers: { open },
    readiness: { requiresProcessingSelection: true, allow },
    remainingStatements: () => 40,
    clock: () => now,
  });
  await expect(
    service.beginAcceptedImport(
      { userId, authority: "session" } as TenantContext,
      { ...input, fingerprint: "schema-synthetic-range" },
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(allow).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});
