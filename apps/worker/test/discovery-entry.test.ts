import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";

import {
  createCredentialCipher,
  encodeBase64url,
} from "../../../packages/adapters/src/security/cipher";
import worker from "../src/index";

const db = env.DB;

const flags = [undefined, "false", "TRUE", "true"] as const;
const key = encodeBase64url(new Uint8Array(32).fill(7));
beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
  for (const [index] of flags.entries()) {
    const user = `entry-${index}`;
    const context = { userId: user, authority: "job" } as TenantContext;
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
    const cipher = await createCredentialCipher({
      activeVersion: 1,
      keys: { 1: key },
    }).seal(
      context,
      { entityId: `conn-${user}`, purpose: "mailbox-credentials" },
      {
        accessToken: "synthetic-entry-access",
        refreshToken: "synthetic-entry-refresh",
        expiresAt: Date.now() + 3600000,
      },
    );
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes,credential_ciphertext,credential_key_version,credential_version,scheduling_state) VALUES(?,?,'mailbox','gmail',?,?,?,?,1,1,'active')",
      )
      .bind(
        `conn-${user}`,
        user,
        `subject-${user}`,
        `${user}-mail@example.invalid`,
        JSON.stringify([
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/gmail.readonly",
        ]),
        cipher,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES(?,?,?,1,'synthetic-approved','synthetic-local',1,0,1)",
      )
      .bind(`consent-${user}`, user, `conn-${user}`)
      .run();
    await db
      .prepare(
        "INSERT INTO import_runs(id,user_id,connection_id,consent_id,connection_generation,frozen_start,frozen_cutoff,timezone,request_fingerprint,stage,started_at) VALUES(?,?,?,?,1,'2026-09-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','UTC',?,'discovering_recent',0)",
      )
      .bind(
        `run-${user}`,
        user,
        `conn-${user}`,
        `consent-${user}`,
        `request-${user}`,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO sync_states(id,user_id,connection_id,import_run_id,scope_key,sync_kind,run_key,slice_key,frozen_start,frozen_cutoff) VALUES(?,?,?,?,'mailbox','backfill',?,'recent','2026-09-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')",
      )
      .bind(`sync-${user}`, user, `conn-${user}`, `run-${user}`, `run-${user}`)
      .run();
    await db
      .prepare(
        "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at) VALUES(?,?,?,?,1,?,'discover',?,'ready',0)",
      )
      .bind(
        `job-${user}`,
        user,
        `conn-${user}`,
        `consent-${user}`,
        `sync-${user}`,
        `dedupe-${user}`,
      )
      .run();
  }
});
afterEach(() => vi.restoreAllMocks());
it.each(flags.map((flag, index) => [flag, index] as const))(
  "actual Worker discovery flag %s leaves unconfigured processing unavailable without provider access",
  async (flag, index) => {
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        throw new Error("Unexpected disabled discovery provider request");
      });
    const queue: Queue<{ schemaVersion: 1; jobId: string }> = {
      async send() {
        throw new Error(
          "Unexpected queue send while consuming synthetic event",
        );
      },
      async sendBatch() {
        throw new Error("Unexpected synthetic batch send");
      },
      async metrics() {
        throw new Error("Unexpected synthetic queue metrics");
      },
    };
    const bindings = {
      DB: env.DB,
      JOBS: queue,
      JOBS_ENABLED: "true",
      AUTH_ENABLED: "true",
      AUTH_ORIGIN: "https://synthetic.example",
      AUTH_SECRET: "synthetic-entry-login-secret-never-production",
      AUTH_GOOGLE_CLIENT_ID: "synthetic-login-client",
      AUTH_GOOGLE_CLIENT_SECRET: "synthetic-login-secret",
      AUTH_ALLOWED_EMAILS: JSON.stringify(["synthetic-login@example.invalid"]),
      GMAIL_ENABLED: "true",
      GMAIL_CLIENT_ID: "synthetic-mail-client",
      GMAIL_CLIENT_SECRET: "synthetic-mail-secret",
      CREDENTIAL_KEYRING: JSON.stringify({
        activeVersion: 1,
        keys: { 1: key },
      }),
      ...(flag === undefined ? {} : { GMAIL_DISCOVERY_ENABLED: flag }),
    };
    const user = `entry-${index}`;
    const batch = createMessageBatch("synthetic-jobs", [
      {
        id: `message-${index}`,
        timestamp: new Date(),
        attempts: 1,
        body: { schemaVersion: 1, jobId: `job-${user}` },
      },
    ]);
    await worker.queue(batch, bindings);
    const result = await getQueueResult(batch, createExecutionContext());
    expect(result.explicitAcks).toEqual([`message-${index}`]);
    expect(result.retryMessages).toEqual([]);
    expect(network).not.toHaveBeenCalled();
    expect(
      await db
        .prepare("SELECT status,outcome_code FROM jobs WHERE id=?")
        .bind(`job-${user}`)
        .first(),
    ).toEqual({
      status: "paused_budget",
      outcome_code: "handler-unavailable",
    });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM source_messages WHERE user_id=?",
        )
        .bind(user)
        .first("count"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT discovery_version FROM sync_states WHERE user_id=?")
        .bind(user)
        .first("discovery_version"),
    ).toBe(0);
  },
);
