import { env } from "cloudflare:workers";
import type { JobPolicy } from "@invoxim/core";
import { afterEach, expect, it } from "vitest";
import {
  completeStagedJob,
  stageAndSettle,
  stageGuard,
} from "../../../packages/adapters/src/discovery/stage-and-settle";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { OUTLOOK_AUTHORIZATION_SCOPES } from "../../../packages/adapters/src/mailbox/outlook-configuration";
import { installOnboardingQaHooks, owner } from "./onboarding-qa-fixture";
import { seedReviewedConsent } from "./outlook-consent-fixture";

installOnboardingQaHooks();

const db = env.DB;
const policy: JobPolicy = {
  dispatchLimit: 1,
  scheduleLimit: 1,
  tenantConcurrency: 2,
  globalConcurrency: 20,
  maxAttempts: 3,
  leaseMs: 300000,
  redeliveryMs: 1000,
  queryLimit: 40,
};
afterEach(async () => {
  await db
    .prepare(
      "UPDATE jobs SET status='completed',lease_id=NULL,lease_expires_at=NULL WHERE user_id LIKE 'qa-stage-settle-%' AND status='leased'",
    )
    .run();
});

async function leased(name: string) {
  const current = await owner(name, "settle-mailbox", [
    ...OUTLOOK_AUTHORIZATION_SCOPES,
  ]);
  await db
    .prepare(
      "UPDATE connections SET provider='outlook',scheduling_state='active',next_sync_at=NULL WHERE user_id=? AND id='settle-mailbox'",
    )
    .bind(current.tenant.userId)
    .run();
  const consentId = `pc-${name}`;
  const jobId = `j-${name}`;
  await seedReviewedConsent(db, {
    userId: current.tenant.userId,
    consentId,
    connectionId: "settle-mailbox",
  });
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES(?,?,'settle-mailbox',?,1,'mailbox-backfill',?,'ready',0)",
    )
    .bind(jobId, current.tenant.userId, consentId, jobId)
    .run();
  const lease = await createJobStore(db, {
    processingReview: null,
    policy,
  }).claim(jobId);
  if (!lease) throw new Error("Synthetic stage-and-settle lease unavailable");
  return lease;
}

function completion(lease: Awaited<ReturnType<typeof leased>>) {
  return completeStagedJob(
    db,
    lease,
    stageGuard({
      sql: "lease_id=? AND fence=?",
      values: [lease.leaseId, lease.fence],
    }),
    { outcome: "discovery_staged" },
  );
}

it("G-40 read settle reports completed when this lease's batch landed", async () => {
  const lease = await leased("qa-stage-settle-own");
  await expect(
    stageAndSettle(db, lease, [completion(lease)], "read"),
  ).resolves.toBe(true);
});

it("G-40 read settle: an expired lease whose job a newer lease completed never reports completed", async () => {
  const lease = await leased("qa-stage-settle-stale");
  // This lease expired; a newer lease (fence+1) claimed and completed the job.
  await db
    .prepare(
      "UPDATE jobs SET status='completed',lease_id=NULL,lease_expires_at=NULL,fence=fence+1,outcome_code='discovery_staged' WHERE user_id=? AND id=?",
    )
    .bind(lease.context.userId, lease.jobId)
    .run();
  const statement = completion(lease);
  await expect(stageAndSettle(db, lease, [statement], "read")).resolves.toBe(
    false,
  );
  // The stale batch itself changed nothing.
  const row = await db
    .prepare("SELECT fence FROM jobs WHERE user_id=? AND id=?")
    .bind(lease.context.userId, lease.jobId)
    .first<number>("fence");
  expect(row).toBe(lease.fence + 1);
});
