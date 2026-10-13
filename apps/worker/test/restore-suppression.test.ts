import { env } from "cloudflare:workers";
import { createLoginAuth } from "@invoxim/adapters";
import type { JobLease, TenantContext } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import {
  createRestoreSuppression,
  type RestoreCheckpoint,
  type RestoreOperator,
} from "../../../packages/adapters/src/lifecycle/restore";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;
const snapshot = {
  id: "synthetic-snapshot-before-deletion",
  at: 1000,
  cutoff: 3000,
  exportId: "synthetic-independent-journal-export",
};
beforeAll(async () => {
  for (const sql of baseline.split(";").filter((statement) => statement.trim()))
    await db.prepare(sql).run();
});

async function seed(userId: string) {
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)",
    )
    .bind(userId, userId, `${userId}@example.invalid`, now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
    )
    .bind(userId, now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,credential_ciphertext,credential_key_version,credential_version,scheduling_state) VALUES(?,?,'mailbox','gmail',?,?,'synthetic-restored-ciphertext',1,1,'active')",
    )
    .bind(`mail-${userId}`, userId, userId, `${userId}@example.invalid`)
    .run();
  await db
    .prepare(
      "INSERT INTO ai_settings(user_id,encrypted_key,key_version,mode,provider_id,model_id,config_version,revision,consent_version) VALUES(?,'synthetic-restored-key',1,'byok','synthetic','small','v1',1,1)",
    )
    .bind(userId)
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES(?,?,?,1,'synthetic','local',1,1000,1)",
    )
    .bind(`consent-${userId}`, userId, `mail-${userId}`)
    .run();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,lease_id,lease_expires_at,fence) VALUES(?,?,?,?,1,'extract',?,'leased',0,'synthetic-old-lease',9999999999999,1)",
    )
    .bind(
      `job-${userId}`,
      userId,
      `mail-${userId}`,
      `consent-${userId}`,
      userId,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES(?,?,'Synthetic purchase','synthetic purchase','2026-10-01',100,'EUR','paid')",
    )
    .bind(`purchase-${userId}`, userId)
    .run();
  const auth = createLoginAuth(db, {
    origin: "https://restore.example.invalid",
    secret: "synthetic-restore-login-secret-never-production-12345",
    googleClientId: "synthetic",
    googleClientSecret: "synthetic",
    allowedEmails: [`${userId}@example.invalid`],
  });
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(userId, false);
  if (!session) throw new Error("Missing synthetic restore session");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(
      "synthetic-restore-login-secret-never-production-12345",
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(session.token),
  );
  const signed = `${session.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
  const headers = new Headers({
    cookie: `__Secure-better-auth.session_token=${encodeURIComponent(signed)}`,
  });
  return { auth, session, headers };
}

function reviewedPage(userId?: string) {
  return {
    snapshotId: snapshot.id,
    snapshotAt: snapshot.at,
    exportId: snapshot.exportId,
    completeThrough: snapshot.cutoff,
    pageNumber: 0,
    markers: userId
      ? [
          {
            userId,
            deletedAt: 2000,
            requestId: "synthetic-independent-deletion",
          },
        ]
      : [],
    nextCursor: null,
  };
}
function operator(page: unknown): RestoreOperator {
  return {
    assertIsolated: async () => undefined,
    readReviewedPage: async () => page,
  };
}
async function step(
  trustedOperator: RestoreOperator,
  checkpoint?: RestoreCheckpoint,
) {
  const meter = createInvocationDatabase(db, 40);
  const result = await createRestoreSuppression({
    db: meter.db,
    operator: trustedOperator,
    snapshot,
  }).runOne(checkpoint);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  expect(result.servingAllowed).toBe(false);
  return result.checkpoint;
}
async function reach(
  trustedOperator: RestoreOperator,
  phase: RestoreCheckpoint["phase"],
  initial?: RestoreCheckpoint,
) {
  let checkpoint = initial;
  for (let unit = 0; unit < 300; unit++) {
    checkpoint = await step(trustedOperator, checkpoint);
    if (checkpoint.phase === phase) return checkpoint;
  }
  throw new Error("Synthetic restore did not reach its bounded target");
}

it("RELEASE-03 independently held later deletion blocks restored auth/work before physical erasure", async () => {
  const owner = await seed("restore-deleted-a");
  const survivor = await seed("restore-survivor-b");
  expect(
    await owner.auth.api.getSession({ headers: owner.headers }),
  ).not.toBeNull();
  expect(
    await db
      .prepare("SELECT id FROM session WHERE userId=?")
      .bind("restore-deleted-a")
      .first(),
  ).not.toBeNull();
  const trusted = operator(reviewedPage("restore-deleted-a"));
  const jobs = createJobStore(db, {
    policy: {
      dispatchLimit: 1,
      scheduleLimit: 1,
      tenantConcurrency: 1,
      globalConcurrency: 1,
      maxAttempts: 3,
      leaseMs: 300000,
      redeliveryMs: 60000,
    },
  });
  const oldLease: JobLease = {
    context: { userId: "restore-deleted-a", authority: "job" } as TenantContext,
    jobId: "job-restore-deleted-a",
    connectionId: "mail-restore-deleted-a",
    consentId: "consent-restore-deleted-a",
    generation: 1,
    syncStateId: null,
    type: "extract",
    leaseId: "synthetic-old-lease",
    fence: 1,
    expiresAt: 9999999999999,
    attempt: 0,
  };
  expect(await jobs.checkpoint(oldLease)).toBe(true);
  await reach(trusted, "cleanup");
  expect(await jobs.checkpoint(oldLease)).toBe(false);
  expect(await jobs.finish(oldLease, { kind: "completed" })).toBe(false);
  expect(
    await db
      .prepare("SELECT status FROM profiles WHERE user_id=?")
      .bind("restore-deleted-a")
      .first("status"),
  ).toBe("deleting");
  expect(
    await db
      .prepare("SELECT id FROM session WHERE userId=?")
      .bind("restore-deleted-a")
      .first(),
  ).toBeNull();
  expect(
    await owner.auth.api.getSession({ headers: owner.headers }),
  ).toBeNull();
  expect(
    await db
      .prepare(
        "SELECT state,credential_ciphertext FROM connections WHERE user_id=?",
      )
      .bind("restore-deleted-a")
      .first(),
  ).toEqual({ state: "needs_reconnect", credential_ciphertext: null });
  expect(
    await db
      .prepare("SELECT status,lease_id FROM jobs WHERE user_id=?")
      .bind("restore-deleted-a")
      .first(),
  ).toEqual({ status: "canceled", lease_id: null });
  expect(
    await db
      .prepare("SELECT id FROM purchases WHERE user_id=?")
      .bind("restore-deleted-a")
      .first(),
  ).not.toBeNull();
  expect(
    await db
      .prepare("SELECT status FROM profiles WHERE user_id=?")
      .bind("restore-survivor-b")
      .first("status"),
  ).toBe("active");
  expect(
    await db
      .prepare("SELECT id FROM purchases WHERE user_id=?")
      .bind("restore-survivor-b")
      .first(),
  ).not.toBeNull();
  expect(
    await db
      .prepare("SELECT id FROM session WHERE id=?")
      .bind(survivor.session.id)
      .first(),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT encrypted_key FROM ai_settings WHERE user_id=?")
      .bind("restore-survivor-b")
      .first("encrypted_key"),
  ).toBeNull();
});

it("RELEASE-03 missing, incomplete, wrong-snapshot and malformed exports refuse before mutation", async () => {
  await seed("restore-refusal");
  for (const page of [
    null,
    { ...reviewedPage(), completeThrough: 2999 },
    { ...reviewedPage(), snapshotId: "another-snapshot" },
    { ...reviewedPage(), verified: true },
    {
      ...reviewedPage(),
      markers: Array.from({ length: 11 }, () => ({
        userId: "restore-refusal",
        deletedAt: 2000,
        requestId: "synthetic",
      })),
    },
    {
      ...reviewedPage(),
      markers: [
        {
          userId: "restore-refusal",
          deletedAt: "2000",
          requestId: "synthetic",
        },
      ],
    },
  ]) {
    await expect(step(operator(page))).rejects.toThrow("RESTORE_REFUSED");
  }
  expect(
    await db
      .prepare("SELECT credential_ciphertext FROM connections WHERE user_id=?")
      .bind("restore-refusal")
      .first("credential_ciphertext"),
  ).toBe("synthetic-restored-ciphertext");
  await expect(
    step(operator(reviewedPage()), {
      snapshotId: "another-snapshot",
      exportId: snapshot.exportId,
      phase: "cleanup",
    }),
  ).rejects.toThrow("RESTORE_REFUSED");
});

it("RELEASE-03 isolation is checked again at every step and blocks serving-database writes", async () => {
  await seed("restore-isolation");
  let isolated = true;
  const trusted = operator(reviewedPage());
  trusted.assertIsolated = async () => {
    if (!isolated) throw new Error("synthetic-private-isolation-detail");
  };
  const checkpoint = await step(trusted);
  isolated = false;
  await expect(step(trusted, checkpoint)).rejects.toThrow("RESTORE_REFUSED");
});

it("RELEASE-03 tombstone replay never replaces a newer existing deletion barrier", async () => {
  await seed("restore-newer-barrier");
  await db
    .prepare("UPDATE profiles SET status='deleting' WHERE user_id=?")
    .bind("restore-newer-barrier")
    .run();
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,journal_ack) VALUES(?,'account','account','synthetic-newer-request',2500,1)",
    )
    .bind("restore-newer-barrier")
    .run();
  await reach(operator(reviewedPage("restore-newer-barrier")), "cleanup");
  expect(
    await db
      .prepare(
        "SELECT request_id,deleted_at FROM lifecycle_deletions WHERE user_id=? AND scope='account'",
      )
      .bind("restore-newer-barrier")
      .first(),
  ).toEqual({ request_id: "synthetic-newer-request", deleted_at: 2500 });
});

it("RELEASE-03 existing cleanup erases more than100 leaves in bounded recovery units", async () => {
  await seed("restore-large");
  for (let index = 0; index < 105; index++) {
    await db
      .prepare(
        "INSERT INTO correction_audit(id,user_id,entity_kind,entity_id,action,before_json,after_json,created_at) VALUES(?,?,'purchase','synthetic','synthetic','{}','{}',1000)",
      )
      .bind(`restore-audit-${index}`, "restore-large")
      .run();
  }
  const trusted = operator(reviewedPage("restore-large"));
  const initial = await reach(trusted, "cleanup");
  let checkpoint = initial;
  let previous = 105;
  for (let unit = 0; unit < 300 && checkpoint.phase !== "reconciled"; unit++) {
    checkpoint = await step(trusted, checkpoint);
    const remaining = await db
      .prepare("SELECT COUNT(*) AS n FROM correction_audit WHERE user_id=?")
      .bind("restore-large")
      .first<number>("n");
    expect(remaining).not.toBeNull();
    expect(previous - (remaining ?? 0)).toBeLessThanOrEqual(100);
    previous = remaining ?? 0;
  }
  expect(checkpoint.phase).toBe("reconciled");
  expect(
    await db
      .prepare("SELECT id FROM user WHERE id=?")
      .bind("restore-large")
      .first(),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT id FROM purchases WHERE user_id=?")
      .bind("restore-survivor-b")
      .first(),
  ).not.toBeNull();
});

it("RELEASE-03 reviewed journal pagination suppresses every page without retaining an unbounded export", async () => {
  await seed("restore-page-a");
  await seed("restore-page-b");
  const cursors: (string | null)[] = [];
  const trusted = operator(null);
  trusted.readReviewedPage = async (cursor) => {
    cursors.push(cursor);
    return cursor === null
      ? { ...reviewedPage("restore-page-a"), nextCursor: "synthetic-page-1" }
      : { ...reviewedPage("restore-page-b"), pageNumber: 1 };
  };
  await reach(trusted, "cleanup");
  expect(cursors).toContain("synthetic-page-1");
  for (const userId of ["restore-page-a", "restore-page-b"]) {
    expect(
      await db
        .prepare("SELECT status FROM profiles WHERE user_id=?")
        .bind(userId)
        .first("status"),
    ).toBe("deleting");
  }
});

it("RELEASE-03 losing isolation during journal review refuses before writes", async () => {
  await seed("restore-review-isolation");
  let isolated = true;
  const trusted = operator(null);
  trusted.assertIsolated = async () => {
    if (!isolated) throw new Error("synthetic-private-isolation-detail");
  };
  trusted.readReviewedPage = async () => {
    isolated = false;
    return reviewedPage();
  };
  await expect(step(trusted)).rejects.toThrow("RESTORE_REFUSED");
  expect(
    await db
      .prepare("SELECT credential_ciphertext FROM connections WHERE user_id=?")
      .bind("restore-review-isolation")
      .first("credential_ciphertext"),
  ).toBe("synthetic-restored-ciphertext");
});

it("RELEASE-03 constructor pins the reviewed snapshot despite later caller mutation", async () => {
  const mutableSnapshot = { ...snapshot };
  const meter = createInvocationDatabase(db, 40);
  const recovery = createRestoreSuppression({
    db: meter.db,
    operator: operator(reviewedPage()),
    snapshot: mutableSnapshot,
  });
  mutableSnapshot.id = "synthetic-other-snapshot";
  mutableSnapshot.at = 9999;
  mutableSnapshot.cutoff = 9999;
  mutableSnapshot.exportId = "synthetic-other-export";
  const result = await recovery.runOne();
  expect(result.checkpoint.snapshotId).toBe(snapshot.id);
  expect(result.checkpoint.exportId).toBe(snapshot.exportId);
  expect(result.servingAllowed).toBe(false);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
