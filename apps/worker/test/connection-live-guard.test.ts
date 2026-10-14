// PIPE-3 [T] P1/P2: one connection/consent "live" rule and one consent-review schema.

import { env } from "cloudflare:workers";
import type { JobPolicy, TenantContext } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { useCurrentSchema } from "./support/db";

const db = env.DB;
const policy: JobPolicy = {
  dispatchLimit: 20,
  scheduleLimit: 20,
  tenantConcurrency: 2,
  globalConcurrency: 20,
  maxAttempts: 3,
  leaseMs: 300000,
  redeliveryMs: 60000,
};
const clock = () => 1000;

beforeAll(async () => {
  await useCurrentSchema(db);
});

async function seedMailbox(options: {
  userId: string;
  connectionId: string;
  consentId: string;
  credentials: boolean;
  kind?: "mailbox" | "storage";
  jobId: string;
}) {
  const { userId, connectionId, consentId, jobId } = options;
  const kind = options.kind ?? "mailbox";
  await db
    .prepare(
      `INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)`,
    )
    .bind(userId, "Synthetic", `${userId}@example.invalid`)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
    )
    .bind(userId, 0, 0)
    .run();
  if (options.credentials) {
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state,credential_ciphertext,credential_key_version) VALUES(?,?,?,'gmail',?,?,'active','synthetic-envelope',1)",
      )
      .bind(
        connectionId,
        userId,
        kind,
        `subject-${connectionId}`,
        `${userId}@example.invalid`,
      )
      .run();
  } else {
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state) VALUES(?,?,?,'gmail',?,?,'active')",
      )
      .bind(
        connectionId,
        userId,
        kind,
        `subject-${connectionId}`,
        `${userId}@example.invalid`,
      )
      .run();
  }
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES(?,?,?,1,'synthetic','synthetic',1,0,1)",
    )
    .bind(consentId, userId, connectionId)
    .run();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES(?,?,?,? ,1,'extract',?,'ready',0)",
    )
    .bind(jobId, userId, connectionId, consentId, jobId)
    .run();
}

it("P2: a mailbox connection without stored credentials is not live for claim", async () => {
  await seedMailbox({
    userId: "live-nocred",
    connectionId: "conn-nocred",
    consentId: "consent-nocred",
    credentials: false,
    jobId: "job-nocred",
  });
  const store = createJobStore(db, { policy, clock });
  // The store live guard must require credential_ciphertext, matching
  // pipeline/repository-guards. Without it the job would run unauthenticated.
  expect(await store.claim("job-nocred")).toBeNull();
});

it("P2: a non-mailbox connection is never live", async () => {
  await seedMailbox({
    userId: "live-storage",
    connectionId: "conn-storage",
    consentId: "consent-storage",
    credentials: true,
    kind: "storage",
    jobId: "job-storage",
  });
  const store = createJobStore(db, { policy, clock });
  expect(await store.claim("job-storage")).toBeNull();
});

it("P2: shared live SQL rejects a credential-less connection row", async () => {
  const { connectionConsentLiveSql } =
    await import("../../../packages/adapters/src/pipeline/repository-guards");
  await seedMailbox({
    userId: "live-sql",
    connectionId: "conn-sql",
    consentId: "consent-sql",
    credentials: false,
    jobId: "job-sql",
  });
  const row = await db
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM connections c JOIN profiles p ON p.user_id=c.user_id JOIN processing_consents pc ON pc.user_id=c.user_id AND pc.connection_id=c.id WHERE c.user_id=? AND c.id=? AND ${connectionConsentLiveSql()} AND pc.accepted_at<=?) AS ok`,
    )
    .bind("live-sql", "conn-sql", 1000)
    .first<{ ok: number }>();
  expect(row?.ok).toBe(0);
});

it("P1: one processing-selection schema accepts owned metadata with nullable fields", async () => {
  const { processingSelectionSchema } =
    await import("../../../packages/adapters/src/pipeline/repository-guards");
  // SQL json_object emits nulls for absent optional columns; both former
  // schemas (store strict, repository nullable) must collapse to this shape.
  const parsed = processingSelectionSchema.parse({
    mode: null,
    settingsRevision: 1,
    providerId: null,
    modelId: null,
    configVersion: null,
    policyVersion: 0,
    acceptedDigest: null,
  });
  expect(parsed.mode).toBeNull();
  expect(
    processingSelectionSchema.safeParse({
      mode: "hosted",
      settingsRevision: 1,
      providerId: "p",
      modelId: "m",
      configVersion: "c",
      policyVersion: 1,
      acceptedDigest: "a".repeat(64),
    }).success,
  ).toBe(true);
});

it("P1: checkpoint fails closed through the shared selection schema", async () => {
  const context = {
    userId: "live-schema",
    authority: "job",
  } as TenantContext;
  await seedMailbox({
    userId: "live-schema",
    connectionId: "conn-schema",
    consentId: "consent-schema",
    credentials: true,
    jobId: "job-schema",
  });
  await db
    .prepare(
      "INSERT INTO ai_settings(user_id,mode,provider_id,model_id,config_version,revision,consent_version,status) VALUES(?,'hosted','processor','model','config',1,1,'active')",
    )
    .bind(context.userId)
    .run();
  const store = createJobStore(db, {
    policy,
    clock,
    processingReview: async () => null,
  });
  const lease = await store.claim("job-schema");
  if (!lease) throw new Error("Synthetic job did not acquire lease");
  expect(await store.checkpoint(lease)).toBe(false);
});
