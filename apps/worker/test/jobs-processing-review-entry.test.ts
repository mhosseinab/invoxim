import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import classification from "../../../config/ai.classification.production.json";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import {
  createCredentialCipher,
  encodeBase64url,
} from "../../../packages/adapters/src/security/cipher";
import { runtimeAiBindings } from "../src/ai-bindings";
import worker from "../src/index";
import { mailboxProcessingConfiguration } from "../src/mailbox-runtime";

/**
 * P7 / PIPE-2: the composed Worker builds its job store without the consent
 * digest review exactly when extraction is not enabled. This proves that
 * composition cannot reach a digest-gated operation (mailbox content read,
 * model call, usage-ledger write): every mailbox handler is unavailable too.
 */
const db = env.DB;
const key = encodeBase64url(new Uint8Array(32).fill(9));
const extraction = [undefined, "false", "TRUE"] as const;
const types = ["discover", "source-extract", "reprocess"] as const;
const model = vi.fn(async () => {
  throw new Error("Unexpected model call without the consent digest gate");
});
function bindings(flag: (typeof extraction)[number]) {
  return {
    DB: env.DB,
    JOBS_ENABLED: "true",
    JOBS: {
      async send() {
        throw new Error("Unexpected queue send while consuming");
      },
      async sendBatch() {
        throw new Error("Unexpected synthetic batch send");
      },
      async metrics() {
        throw new Error("Unexpected synthetic queue metrics");
      },
    } as Queue<{ schemaVersion: 1; jobId: string }>,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://synthetic.example",
    AUTH_SECRET: "synthetic-review-entry-login-secret-never-production",
    AUTH_GOOGLE_CLIENT_ID: "synthetic-login-client",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic-login-secret",
    AUTH_ALLOWED_EMAILS: JSON.stringify(["synthetic-login@example.invalid"]),
    GMAIL_ENABLED: "true",
    GMAIL_DISCOVERY_ENABLED: "true",
    GMAIL_CLIENT_ID: "synthetic-mail-client",
    GMAIL_CLIENT_SECRET: "synthetic-mail-secret",
    CREDENTIAL_KEYRING: JSON.stringify({ activeVersion: 1, keys: { 1: key } }),
    AI_ENABLED: "true",
    AI_HOSTED_KEY: "synthetic-hosted-key-never-production",
    AI_CLASSIFICATION_JSON: JSON.stringify(classification),
    AI: { run: model },
    ...(flag === undefined ? {} : { EXTRACTION_ENABLED: flag }),
  };
}
const user = (index: number) => `review-entry-${index}`;
const job = (index: number, type: string) => `job-${user(index)}-${type}`;

beforeAll(async () => {
  for (const statement of baseline.split(";").filter((value) => value.trim()))
    await db.prepare(statement).run();
  for (const [index] of extraction.entries()) {
    const id = user(index);
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
    const credential = await createCredentialCipher({
      activeVersion: 1,
      keys: { 1: key },
    }).seal(
      context,
      { entityId: `conn-${id}`, purpose: "mailbox-credentials" },
      {
        accessToken: "synthetic-review-entry-access",
        refreshToken: "synthetic-review-entry-refresh",
        expiresAt: Date.now() + 3600000,
      },
    );
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes,credential_ciphertext,credential_key_version,credential_version,scheduling_state) VALUES(?,?,'mailbox','gmail',?,?,?,?,1,1,'active')",
      )
      .bind(
        `conn-${id}`,
        id,
        `subject-${id}`,
        `${id}-mail@example.invalid`,
        JSON.stringify([
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/gmail.readonly",
        ]),
        credential,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES(?,?,?,1,'synthetic-approved','synthetic-local',1,0,1)",
      )
      .bind(`consent-${id}`, id, `conn-${id}`)
      .run();
    for (const type of types)
      await db
        .prepare(
          "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES(?,?,?,?,1,?,?,'ready',0)",
        )
        .bind(
          job(index, type),
          id,
          `conn-${id}`,
          `consent-${id}`,
          type,
          job(index, type),
        )
        .run();
  }
});
afterEach(() => vi.restoreAllMocks());

it("the synthetic bindings are processing-ready except for the extraction flag", () => {
  expect(
    mailboxProcessingConfiguration(
      runtimeAiBindings({ ...bindings(undefined), EXTRACTION_ENABLED: "true" }),
    ).providers,
  ).toEqual(["gmail"]);
  for (const flag of extraction)
    expect(
      mailboxProcessingConfiguration(runtimeAiBindings(bindings(flag)))
        .providers,
    ).toEqual([]);
});

it.each(extraction.map((flag, index) => [flag, index] as const))(
  "P7: with EXTRACTION_ENABLED=%s the review-less job store reaches no digest-gated operation",
  async (flag, index) => {
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        throw new Error("Unexpected provider request without the digest gate");
      });
    // The runtime consumes one message per invocation, each with its own cap.
    for (const type of types) {
      const batch = createMessageBatch("synthetic-jobs", [
        {
          id: `message-${index}-${type}`,
          timestamp: new Date(),
          attempts: 1,
          body: { schemaVersion: 1, jobId: job(index, type) },
        },
      ]);
      await worker.queue(batch, bindings(flag));
      const result = await getQueueResult(batch, createExecutionContext());
      expect(result.retryMessages).toEqual([]);
      expect(result.explicitAcks).toEqual([`message-${index}-${type}`]);
    }
    expect(network).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
    for (const type of types)
      expect(
        await db
          .prepare("SELECT status,outcome_code FROM jobs WHERE id=?")
          .bind(job(index, type))
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
        .bind(user(index))
        .first("count"),
    ).toBe(0);
    // Usage ledger rows include global buckets without a user_id.
    for (const table of ["usage_events", "usage_buckets"])
      expect(
        await db
          .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .first("count"),
      ).toBe(0);
  },
);
