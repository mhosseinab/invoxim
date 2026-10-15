// PIPE-4 [T] P1.5b / G2 / ext#12: one lease/consent "live" predicate.

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

async function seedJob(options: {
  userId: string;
  connectionId: string;
  consentId: string;
  jobId: string;
  credentials?: boolean;
  kind?: "mailbox" | "storage";
  backgroundAuthorized?: boolean;
}) {
  const {
    userId,
    connectionId,
    consentId,
    jobId,
    credentials = true,
    kind = "mailbox",
    backgroundAuthorized = true,
  } = options;
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
  await db
    .prepare(
      credentials
        ? "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state,credential_ciphertext,credential_key_version) VALUES(?,?,?,'gmail',?,?,'active','synthetic-envelope',1)"
        : "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state) VALUES(?,?,?,'gmail',?,?,'active')",
    )
    .bind(
      connectionId,
      userId,
      kind,
      `subject-${connectionId}`,
      `${userId}@example.invalid`,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES(?,?,?,1,'synthetic','synthetic',1,0,?)",
    )
    .bind(consentId, userId, connectionId, backgroundAuthorized ? 1 : 0)
    .run();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES(?,?,?,?,1,'extract',?,'ready',0)",
    )
    .bind(jobId, userId, connectionId, consentId, jobId)
    .run();
}

it("P1.5b: leaseLive requires a held lease and the shared connection/consent live rule", async () => {
  const { leaseLive } =
    await import("../../../packages/adapters/src/pipeline/repository-guards");
  const sql = leaseLive();
  // Held-lease binds (G2): the fragment must fence on lease identity and expiry.
  expect(sql).toContain("j.status='leased'");
  expect(sql).toContain("j.lease_id=?");
  expect(sql).toContain("j.lease_expires_at>?");
  expect(sql).toContain("j.connection_generation=?");
  // Must reuse the PIPE-3 connection/consent live rule, so callers cannot
  // drop credential_ciphertext / kind='mailbox' the way the Outlook copies did.
  expect(sql).toContain("credential_ciphertext IS NOT NULL");
  expect(sql).toContain("kind='mailbox'");
  expect(sql).toContain("revoked_at IS NULL");
  expect(sql).toContain("background_authorized=1");
  expect(sql).toContain("accepted_at<=?");
});

it("P1.5b: leaseLive extras extend the predicate and aliases rename tables", async () => {
  const { leaseLive } =
    await import("../../../packages/adapters/src/pipeline/repository-guards");
  const sql = leaseLive({
    alias: { jobs: "j2", connection: "c2", profile: "p2", consent: "a" },
    extras: ["j2.type IN ('discover','sync')", "a.query_mode=?"],
  });
  expect(sql).toContain("j2.status='leased'");
  expect(sql).toContain("a.revoked_at IS NULL");
  expect(sql).toContain("p2.status='active'");
  expect(sql).toContain("j2.type IN ('discover','sync')");
  expect(sql).toContain("a.query_mode=?");
  expect(sql).not.toContain("j.lease_id");
});

it("P1.5b: correlated form fences an outer jobs row without lease binds", async () => {
  const { leaseLive } =
    await import("../../../packages/adapters/src/pipeline/repository-guards");
  const sql = leaseLive({ alias: { jobs: "jobs" } });
  expect(sql).toContain("c.user_id=jobs.user_id");
  expect(sql).toContain("c.id=jobs.connection_id");
  expect(sql).toContain("pc.id=jobs.consent_id");
  expect(sql).toContain("credential_ciphertext IS NOT NULL");
  expect(sql).not.toContain("lease_id");
});

it("P1.5b: store live guard drops a credential-less connection through the shared rule", async () => {
  await seedJob({
    userId: "lease-nocred",
    connectionId: "conn-nocred",
    consentId: "consent-nocred",
    jobId: "job-nocred",
    credentials: false,
  });
  const store = createJobStore(db, { processingReview: null, policy, clock });
  expect(await store.claim("job-nocred")).toBeNull();
});

it("P1.5b: store live guard drops a revoked-consent lease", async () => {
  await seedJob({
    userId: "lease-revoked",
    connectionId: "conn-revoked",
    consentId: "consent-revoked",
    jobId: "job-revoked",
    backgroundAuthorized: false,
  });
  const store = createJobStore(db, { processingReview: null, policy, clock });
  expect(await store.claim("job-revoked")).toBeNull();
});

it("P1.5b: checkpoint fails closed when the lease's consent is no longer authorized", async () => {
  const context = {
    userId: "lease-checkpoint",
    authority: "job",
  } as TenantContext;
  await seedJob({
    userId: "lease-checkpoint",
    connectionId: "conn-checkpoint",
    consentId: "consent-checkpoint",
    jobId: "job-checkpoint",
  });
  const store = createJobStore(db, { processingReview: null, policy, clock });
  const lease = await store.claim("job-checkpoint");
  if (!lease) throw new Error("Synthetic job did not acquire lease");
  await db
    .prepare(
      "UPDATE processing_consents SET background_authorized=0 WHERE user_id=? AND id=?",
    )
    .bind(context.userId, "consent-checkpoint")
    .run();
  expect(await store.checkpoint(lease)).toBe(false);
});
