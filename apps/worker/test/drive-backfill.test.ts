import { env } from "cloudflare:workers";
import { createLoginAuth, createProfileService } from "@invoxim/adapters";
import type { ArchiveSession, TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import migration from "../../../packages/adapters/migrations/0006_archive_dispatch_backfill.sql?raw";
import continuationMigration from "../../../packages/adapters/migrations/0007_archive_document_order.sql?raw";
import { createArchiveBackfillStore } from "../../../packages/adapters/src/drive/backfill";
import { createArchiveDispatchStore } from "../../../packages/adapters/src/drive/dispatch-store";
import { createArchiveObjectStore } from "../../../packages/adapters/src/drive/objects";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;
let session: ArchiveSession, foreignSession: ArchiveSession;
let owner: TenantContext, foreign: TenantContext;
const login = {
  origin: "https://synthetic.example",
  secret: "synthetic-upload-session-login-secret-123456789",
  googleClientId: "synthetic-login.apps.googleusercontent.com",
  googleClientSecret: "synthetic-client-secret",
  allowedEmails: ["upload-owner@example.test", "upload-foreign@example.test"],
};
async function verified(id: string, email: string): Promise<ArchiveSession> {
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Synthetic',?,1,?,?)",
    )
    .bind(id, email, now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
    )
    .bind(id, now, now)
    .run();
  const auth = createLoginAuth(db, login);
  const internal = await auth.$context;
  const session = await internal.internalAdapter.createSession(id, false);
  if (!session) throw new Error("Synthetic session unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(login.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(session.token),
  );
  const cookie =
    "__Secure-better-auth.session_token=" +
    encodeURIComponent(
      `${session.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`,
    );
  const profile = await createProfileService(db, auth, login).current(
    new Headers({ Cookie: cookie }),
  );
  if (!profile) throw new Error("Synthetic session verification failed");
  return {
    tenant: profile.tenant,
    sessionId: profile.session.id,
    createdAtMs: profile.session.createdAt.getTime(),
  };
}

beforeAll(async () => {
  for (const sql of [baseline, migration])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
  const continuationStatements =
    continuationMigration.match(
      /CREATE TRIGGER[\s\S]*?END;|(?:CREATE TABLE|CREATE INDEX|INSERT INTO|ALTER TABLE)[\s\S]*?;/g,
    ) ?? [];
  if (continuationStatements.length !== 8)
    throw new Error("Synthetic continuation migration statement mismatch");
  for (const statement of continuationStatements)
    await db.prepare(statement).run();
  session = await verified(
    "synthetic-archive-queue-owner",
    "upload-owner@example.test",
  );
  foreignSession = await verified(
    "synthetic-archive-queue-foreign",
    "upload-foreign@example.test",
  );
  owner = session.tenant;
  foreign = foreignSession.tenant;
});

it("atomically admits at most five frozen members per page and cancel invalidates only dispatches owned by that run", async () => {
  for (let index = 0; index < 7; index++)
    await document(`synthetic-page-doc-${index}`);
  const automaticObject = await createArchiveObjectStore(db).request(owner, {
    documentId: "synthetic-page-doc-0",
    storageConnectionId: "drive",
    settingsVersion: 1,
  });
  await createArchiveDispatchStore(db).enqueue(
    owner,
    automaticObject,
    "synthetic-existing-auto",
  );
  const store = createArchiveBackfillStore(db);
  const run = await store.start(session, {
    connectionId: "drive",
    generation: 1,
    settingsVersion: 1,
  });
  const lease = await store.claim(owner, run.id);
  if (!lease) throw new Error("Synthetic backfill lease unavailable");
  const meter = createInvocationDatabase(db, 40);
  const admitted = await createArchiveBackfillStore(meter.db).admitPage(lease);
  expect(admitted).toEqual({
    admitted: 4,
    skipped: 1,
    cursorOrdinal: 5,
    done: false,
  });
  expect(meter.executedStatements()).toBeLessThanOrEqual(12);
  expect(
    await db
      .prepare(
        "SELECT count(*) AS total FROM archive_dispatch WHERE user_id=? AND backfill_run_id=?",
      )
      .bind(owner.userId, run.id)
      .first(),
  ).toEqual({ total: 4 });
  await expect(store.admitPage(lease)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  const current = await store.read(owner, run.id);
  const owned = await db
    .prepare(
      "SELECT object_id FROM archive_dispatch WHERE user_id=? AND backfill_run_id=? ORDER BY object_id LIMIT 1",
    )
    .bind(owner.userId, run.id)
    .first<{ object_id: string }>();
  if (!owned) throw new Error("Synthetic admitted archive absent");
  const objects = createArchiveObjectStore(db);
  const inflight = await objects.claim(owner, owned.object_id);
  if (!inflight) throw new Error("Synthetic archive execution lease absent");
  await store.cancel(session, run.id, current.revision);
  expect(await objects.authorized(owner, inflight.lease)).toBe(false);
  expect(
    await db
      .prepare(
        "SELECT count(*) AS total FROM archive_dispatch WHERE user_id=? AND backfill_run_id=? AND status='canceled'",
      )
      .bind(owner.userId, run.id)
      .first(),
  ).toEqual({ total: 4 });
  expect(
    await db
      .prepare(
        "SELECT status,backfill_run_id FROM archive_dispatch WHERE queue_id='synthetic-existing-auto'",
      )
      .first(),
  ).toEqual({ status: "ready", backfill_run_id: null });
  expect(
    await db
      .prepare(
        "SELECT cursor_ordinal,state FROM archive_backfill_runs WHERE user_id=? AND id=?",
      )
      .bind(owner.userId, run.id)
      .first(),
  ).toEqual({ cursor_ordinal: 5, state: "canceled" });
});
it("assigns an obsolete automatic ready outbox to the explicit backfill that reauthorizes its exact pending plan", async () => {
  await document("synthetic-obsolete-doc");
  const objects = createArchiveObjectStore(db);
  const objectId = await objects.request(owner, {
    documentId: "synthetic-obsolete-doc",
    storageConnectionId: "drive",
    settingsVersion: 1,
  });
  const old = await objects.claim(owner, objectId);
  if (!old) throw new Error("Synthetic pending plan lease unavailable");
  const plan = {
    fileId: "synthetic-preallocated-original",
    parentId: "synthetic-preallocated-folder",
    workspaceMarker: "synthetic-workspace-marker",
    mimeType: "message/rfc822" as const,
    size: 128,
    sha256: "b".repeat(64),
  };
  expect(await objects.savePlan(owner, old.lease, plan)).toBe(true);
  expect(await objects.release(owner, old.lease)).toBe(true);
  const dispatch = createArchiveDispatchStore(db);
  await dispatch.enqueue(owner, objectId, "synthetic-obsolete-automatic-id");
  const candidate = (await dispatch.due(1))[0];
  if (!candidate) throw new Error("Synthetic automatic candidate unavailable");
  const priorDelivery = await dispatch.reserve(candidate);
  if (!priorDelivery)
    throw new Error("Synthetic automatic reservation unavailable");
  await db
    .prepare("UPDATE archive_settings SET version=2 WHERE user_id=?")
    .bind(owner.userId)
    .run();
  await document("synthetic-current-doc");
  const currentAutomatic = await objects.request(owner, {
    documentId: "synthetic-current-doc",
    storageConnectionId: "drive",
    settingsVersion: 2,
  });
  await dispatch.enqueue(
    owner,
    currentAutomatic,
    "synthetic-still-current-auto",
  );
  const store = createArchiveBackfillStore(db);
  const run = await store.start(session, {
    connectionId: "drive",
    generation: 1,
    settingsVersion: 2,
  });
  const lease = await store.claim(owner, run.id);
  if (!lease)
    throw new Error("Synthetic reauthorization run lease unavailable");
  const meter = createInvocationDatabase(db, 40);
  expect(await createArchiveBackfillStore(meter.db).admitPage(lease)).toEqual({
    admitted: 1,
    skipped: 1,
    cursorOrdinal: 2,
    done: true,
  });
  expect(meter.executedStatements()).toBeLessThanOrEqual(12);
  expect(
    await db
      .prepare(
        "SELECT id,settings_version,planned_file_id,parent_id,workspace_marker,original_mime,original_size,original_sha256 FROM archive_objects WHERE user_id=? AND id=?",
      )
      .bind(owner.userId, objectId)
      .first(),
  ).toEqual({
    id: objectId,
    settings_version: 2,
    planned_file_id: plan.fileId,
    parent_id: plan.parentId,
    workspace_marker: plan.workspaceMarker,
    original_mime: plan.mimeType,
    original_size: plan.size,
    original_sha256: plan.sha256,
  });
  expect(
    await db
      .prepare(
        "SELECT queue_id,status,backfill_run_id,dispatched_at,dispatch_fence FROM archive_dispatch WHERE user_id=? AND object_id=?",
      )
      .bind(owner.userId, objectId)
      .first(),
  ).toEqual({
    queue_id: "synthetic-obsolete-automatic-id",
    status: "ready",
    backfill_run_id: run.id,
    dispatched_at: null,
    dispatch_fence: priorDelivery.dispatchFence + 1,
  });
  expect(
    await dispatch.settle(priorDelivery, { kind: "retry", code: "transient" }),
  ).toBe(false);
  const inflight = await objects.claim(owner, objectId);
  if (!inflight) throw new Error("Synthetic reauthorized plan unavailable");
  const current = await store.read(owner, run.id);
  await store.cancel(session, run.id, current.revision);
  expect(await objects.authorized(owner, inflight.lease)).toBe(false);
  expect(
    await db
      .prepare(
        "SELECT status,backfill_run_id FROM archive_dispatch WHERE user_id=? AND object_id=?",
      )
      .bind(owner.userId, objectId)
      .first(),
  ).toEqual({ status: "canceled", backfill_run_id: run.id });
  expect(
    await db
      .prepare(
        "SELECT status,backfill_run_id FROM archive_dispatch WHERE user_id=? AND object_id=?",
      )
      .bind(owner.userId, currentAutomatic)
      .first(),
  ).toEqual({ status: "ready", backfill_run_id: null });
});

it("refuses a page when archive consent is revoked after member reads and commits no objects, outbox or cursor progress", async () => {
  await document("synthetic-midpage-doc");
  const store = createArchiveBackfillStore(db);
  const run = await store.start(session, {
    connectionId: "drive",
    generation: 1,
    settingsVersion: 1,
  });
  const lease = await store.claim(owner, run.id);
  if (!lease) throw new Error("Synthetic revocation run lease unavailable");
  const meter = createInvocationDatabase(db, 40);
  const raceDatabase: D1Database = {
    prepare: (query) => meter.db.prepare(query),
    exec: (query) => meter.db.exec(query),
    withSession: (constraintOrBookmark) =>
      meter.db.withSession(constraintOrBookmark),
    dump: () => meter.db.dump(),
    async batch<T>(statements: D1PreparedStatement[]) {
      await db
        .prepare(
          "UPDATE archive_settings SET enabled=0,version=version+1,connection_id=NULL,connection_generation=NULL,disclosure_version=NULL,accepted_at=NULL WHERE user_id=?",
        )
        .bind(owner.userId)
        .run();
      return meter.db.batch<T>(statements);
    },
  };
  await expect(
    createArchiveBackfillStore(raceDatabase).admitPage(lease),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(
    await db
      .prepare("SELECT count(*) AS total FROM archive_objects WHERE user_id=?")
      .bind(owner.userId)
      .first(),
  ).toEqual({ total: 0 });
  expect(
    await db
      .prepare("SELECT count(*) AS total FROM archive_dispatch WHERE user_id=?")
      .bind(owner.userId)
      .first(),
  ).toEqual({ total: 0 });
  expect(
    await db
      .prepare(
        "SELECT cursor_ordinal,revision,state,lease_id,fence FROM archive_backfill_runs WHERE user_id=? AND id=?",
      )
      .bind(owner.userId, run.id)
      .first(),
  ).toEqual({
    cursor_ordinal: 0,
    revision: lease.revision,
    state: "pending",
    lease_id: lease.leaseId,
    fence: lease.fence,
  });
  expect(meter.executedStatements()).toBeLessThanOrEqual(12);
});
beforeEach(async () => {
  for (const table of [
    "archive_dispatch",
    "archive_backfill_items",
    "archive_backfill_runs",
    "archive_objects",
    "archive_settings",
    "documents",
    "source_messages",
    "connections",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
  for (const [id, kind, provider, permission] of [
    [
      "mail",
      "mailbox",
      "gmail",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
    [
      "drive",
      "storage",
      "google-drive",
      "https://www.googleapis.com/auth/drive.file",
    ],
  ])
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes,credential_ciphertext,credential_key_version) VALUES(?,?,?,?,?,'synthetic@example.test',?,'synthetic-sealed',1)",
      )
      .bind(
        id,
        owner.userId,
        kind,
        provider,
        `synthetic-${id}-subject`,
        JSON.stringify([permission]),
      )
      .run();
  await db
    .prepare(
      "INSERT INTO archive_settings(user_id,enabled,version,connection_id,connection_generation,disclosure_version,accepted_at) VALUES(?,1,1,'drive',1,1,?)",
    )
    .bind(owner.userId, Date.now())
    .run();
});
async function document(id: string) {
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,'mail',?,0,1)",
    )
    .bind(`source-${id}`, owner.userId, `synthetic-message-${id}`)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES(?,?,?,'body',?,'text/plain',1)",
    )
    .bind(id, owner.userId, `source-${id}`, "a".repeat(64))
    .run();
}
it("freezes at most one hundred owned document identities only on explicit archive backfill and excludes later backdated inserts", async () => {
  for (let index = 0; index < 101; index++)
    await document(`synthetic-doc-${String(index).padStart(3, "0")}`);
  const store = createArchiveBackfillStore(db);
  const started = await store.start(session, {
    connectionId: "drive",
    generation: 1,
    settingsVersion: 1,
  });
  expect(started).toMatchObject({
    snapshotCount: 100,
    cursorOrdinal: 0,
    hasMore: true,
    state: "pending",
    revision: 1,
  });
  await document("000-synthetic-later-backdated");
  const rows = await db
    .prepare(
      "SELECT document_id,ordinal FROM archive_backfill_items WHERE user_id=? AND run_id=? ORDER BY ordinal",
    )
    .bind(owner.userId, started.id)
    .all();
  expect(rows.results).toHaveLength(100);
  expect(rows.results[0]).toEqual({
    document_id: "synthetic-doc-000",
    ordinal: 1,
  });
  expect(rows.results[99]).toEqual({
    document_id: "synthetic-doc-099",
    ordinal: 100,
  });
  await expect(store.read(foreign, started.id)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(
    await db
      .prepare("SELECT count(*) AS total FROM processing_consents")
      .first(),
  ).toEqual({ total: 0 });
  expect(
    await db.prepare("SELECT count(*) AS total FROM jobs").first(),
  ).toEqual({ total: 0 });
  const canceled = await store.cancel(session, started.id, started.revision);
  expect(canceled.state).toBe("canceled");
  expect(await store.claim(owner, started.id)).toBeNull();
});

it("continues the complete frozen snapshot through bounded cohorts, excludes late and reinserted identities and cancels with bounded recoverable cleanup", async () => {
  const ids = Array.from(
    { length: 205 },
    (_, index) => `synthetic-cohort-${String(index).padStart(3, "0")}`,
  );
  for (const id of ids) await document(id);
  const store = createArchiveBackfillStore(db);
  let current = await store.start(session, {
    connectionId: "drive",
    generation: 1,
    settingsVersion: 1,
  });
  const runId = current.id;
  expect(current).toMatchObject({
    snapshotCount: 100,
    processedCount: 0,
    hasMore: true,
    continuationAvailable: true,
  });
  await document("000-synthetic-late-cohort");
  for (const index of [150, 204]) {
    const id = ids[index];
    if (!id) throw new Error("Synthetic removed identity absent");
    await db
      .prepare("DELETE FROM source_messages WHERE user_id=? AND id=?")
      .bind(owner.userId, `source-${id}`)
      .run();
    await document(id);
  }
  const windows = [current.snapshotCount];
  for (let step = 0; step < 60 && current.state === "pending"; step++) {
    const meter = createInvocationDatabase(db, 40);
    for (let prefix = 0; prefix < 4; prefix++)
      await meter.db.prepare("SELECT 1").first();
    const bounded = createArchiveBackfillStore(meter.db);
    const lease = await bounded.claim(owner, runId);
    if (!lease) throw new Error("Synthetic cohort claim unavailable");
    if (current.cursorOrdinal === current.snapshotCount && current.hasMore) {
      current = await bounded.advance(lease);
      windows.push(current.snapshotCount);
      expect(current.cursorOrdinal).toBe(0);
      await expect(bounded.advance(lease)).rejects.toMatchObject({
        code: "CONFLICT",
      });
    } else {
      const page = await bounded.admitPage(lease);
      expect(page.admitted).toBeLessThanOrEqual(5);
      current = await bounded.read(owner, runId);
      expect(page.done).toBe(current.state === "admission_complete");
    }
    expect(meter.remainingStatements()).toBeGreaterThanOrEqual(3);
    for (let settlement = 0; settlement < 3; settlement++)
      await meter.db.prepare("SELECT 1").first();
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS total FROM archive_backfill_items WHERE user_id=? AND run_id=?",
          )
          .bind(owner.userId, runId)
          .first<{ total: number }>()
      )?.total,
    ).toBeLessThanOrEqual(100);
  }
  expect(windows).toEqual([100, 100, 3]);
  expect(current).toMatchObject({
    state: "admission_complete",
    hasMore: false,
    processedCount: 203,
  });
  const admitted = await db
    .prepare(
      "SELECT o.document_id FROM archive_objects o JOIN archive_dispatch q ON q.user_id=o.user_id AND q.object_id=o.id WHERE q.user_id=? AND q.backfill_run_id=? ORDER BY o.document_id",
    )
    .bind(owner.userId, runId)
    .all<{ document_id: string }>();
  expect(admitted.results.map((row) => row.document_id)).toEqual(
    ids.filter((_, index) => index !== 150 && index !== 204),
  );
  const meter = createInvocationDatabase(db, 40);
  for (let prefix = 0; prefix < 4; prefix++)
    await meter.db.prepare("SELECT 1").first();
  const canceled = await createArchiveBackfillStore(meter.db).cancel(
    session,
    runId,
    current.revision,
  );
  expect(canceled.state).toBe("canceled");
  expect(meter.remainingStatements()).toBeGreaterThanOrEqual(3);
  for (let settlement = 0; settlement < 3; settlement++)
    await meter.db.prepare("SELECT 1").first();
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  expect(
    await db
      .prepare(
        "SELECT count(*) AS total FROM archive_dispatch WHERE user_id=? AND backfill_run_id=? AND status<>'canceled'",
      )
      .bind(owner.userId, runId)
      .first(),
  ).toEqual({ total: 103 });
  for (const expected of [
    { cleaned: 100, done: false },
    { cleaned: 3, done: true },
    { cleaned: 0, done: true },
  ]) {
    const cleanupMeter = createInvocationDatabase(db, 40);
    for (let prefix = 0; prefix < 4; prefix++)
      await cleanupMeter.db.prepare("SELECT 1").first();
    expect(
      await createArchiveBackfillStore(cleanupMeter.db).cleanupCanceled(
        owner,
        runId,
      ),
    ).toEqual(expected);
    expect(cleanupMeter.remainingStatements()).toBeGreaterThanOrEqual(3);
    for (let settlement = 0; settlement < 3; settlement++)
      await cleanupMeter.db.prepare("SELECT 1").first();
    expect(cleanupMeter.executedStatements()).toBeLessThanOrEqual(40);
  }
});

it("a canceled run denies an existing active object lease and new claims before physical cleanup while unrelated automatic work stays authorized", async () => {
  await document("synthetic-logical-owned");
  const store = createArchiveBackfillStore(db);
  const run = await store.start(session, {
    connectionId: "drive",
    generation: 1,
    settingsVersion: 1,
  });
  const lease = await store.claim(owner, run.id);
  if (!lease)
    throw new Error("Synthetic logical cancellation lease unavailable");
  await store.admitPage(lease);
  const owned = await db
    .prepare(
      "SELECT object_id FROM archive_dispatch WHERE user_id=? AND backfill_run_id=?",
    )
    .bind(owner.userId, run.id)
    .first<{ object_id: string }>();
  if (!owned) throw new Error("Synthetic logical owned object unavailable");
  await document("synthetic-logical-auto");
  const objects = createArchiveObjectStore(db);
  const automatic = await objects.request(owner, {
    documentId: "synthetic-logical-auto",
    storageConnectionId: "drive",
    settingsVersion: 1,
  });
  await createArchiveDispatchStore(db).enqueue(
    owner,
    automatic,
    "synthetic-logical-auto-queue",
  );
  const active = await objects.claim(owner, owned.object_id);
  const autoActive = await objects.claim(owner, automatic);
  if (!active || !autoActive)
    throw new Error("Synthetic logical active objects unavailable");
  expect(
    await objects.savePlan(owner, active.lease, {
      fileId: "synthetic-logical-file",
      parentId: "synthetic-logical-folder",
      workspaceMarker: "synthetic-logical-marker",
      mimeType: "message/rfc822",
      size: 128,
      sha256: "d".repeat(64),
    }),
  ).toBe(true);
  await db
    .prepare(
      "UPDATE archive_backfill_runs SET state='canceled',revision=revision+1,fence=fence+1,lease_id=NULL,lease_expires_at=0 WHERE user_id=? AND id=?",
    )
    .bind(owner.userId, run.id)
    .run();
  expect(await objects.authorized(owner, active.lease)).toBe(false);
  expect(await objects.complete(owner, active.lease)).toBe(false);
  expect(await objects.release(owner, active.lease)).toBe(true);
  expect(await objects.claim(owner, owned.object_id)).toBeNull();
  expect(await objects.authorized(owner, autoActive.lease)).toBe(true);
  expect(
    await db
      .prepare(
        "SELECT status FROM archive_dispatch WHERE user_id=? AND object_id=?",
      )
      .bind(owner.userId, owned.object_id)
      .first(),
  ).toEqual({ status: "ready" });
});

it("legacy nullable-cutoff runs retain their frozen window and refuse invented continuation", async () => {
  for (let index = 0; index < 101; index++)
    await document(`synthetic-legacy-${String(index).padStart(3, "0")}`);
  const store = createArchiveBackfillStore(db);
  const run = await store.start(session, {
    connectionId: "drive",
    generation: 1,
    settingsVersion: 1,
  });
  await db
    .prepare(
      "UPDATE archive_backfill_runs SET snapshot_sequence=NULL,enumerated_through_sequence=0,processed_count=0,cursor_ordinal=snapshot_count,state='pending' WHERE user_id=? AND id=?",
    )
    .bind(owner.userId, run.id)
    .run();
  const before = (
    await db
      .prepare(
        "SELECT ordinal,document_id FROM archive_backfill_items WHERE user_id=? AND run_id=? ORDER BY ordinal",
      )
      .bind(owner.userId, run.id)
      .all()
  ).results;
  expect(await store.read(owner, run.id)).toMatchObject({
    continuationAvailable: false,
    hasMore: true,
  });
  const lease = await store.claim(owner, run.id);
  if (!lease) throw new Error("Synthetic legacy lease unavailable");
  await expect(store.advance(lease)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(
    (
      await db
        .prepare(
          "SELECT ordinal,document_id FROM archive_backfill_items WHERE user_id=? AND run_id=? ORDER BY ordinal",
        )
        .bind(owner.userId, run.id)
        .all()
    ).results,
  ).toEqual(before);
});

it("a new explicit run can adopt canceled same-consent work without reviving the previous lease or replacing its planned original", async () => {
  await document("synthetic-restart-doc");
  const store = createArchiveBackfillStore(db);
  const oldRun = await store.start(session, {
    connectionId: "drive",
    generation: 1,
    settingsVersion: 1,
  });
  const first = await store.claim(owner, oldRun.id);
  if (!first) throw new Error("Synthetic first run unavailable");
  await store.admitPage(first);
  const row = await db
    .prepare(
      "SELECT object_id,queue_id FROM archive_dispatch WHERE user_id=? AND backfill_run_id=?",
    )
    .bind(owner.userId, oldRun.id)
    .first<{ object_id: string; queue_id: string }>();
  if (!row) throw new Error("Synthetic restart object unavailable");
  const objects = createArchiveObjectStore(db);
  const active = await objects.claim(owner, row.object_id);
  if (!active) throw new Error("Synthetic previous active lease unavailable");
  const plan = {
    fileId: "synthetic-restart-file",
    parentId: "synthetic-restart-folder",
    workspaceMarker: "synthetic-restart-marker",
    mimeType: "message/rfc822" as const,
    size: 128,
    sha256: "c".repeat(64),
  };
  expect(await objects.savePlan(owner, active.lease, plan)).toBe(true);
  await db
    .prepare(
      "UPDATE archive_backfill_runs SET state='canceled',revision=revision+1,fence=fence+1,lease_id=NULL,lease_expires_at=0 WHERE user_id=? AND id=?",
    )
    .bind(owner.userId, oldRun.id)
    .run();
  const next = await store.start(session, {
    connectionId: "drive",
    generation: 1,
    settingsVersion: 1,
  });
  const lease = await store.claim(owner, next.id);
  if (!lease) throw new Error("Synthetic new explicit run unavailable");
  expect(await store.admitPage(lease)).toMatchObject({
    admitted: 1,
    skipped: 0,
  });
  expect(await objects.authorized(owner, active.lease)).toBe(false);
  const restored = await objects.claim(owner, row.object_id);
  if (!restored) throw new Error("Synthetic new execution unavailable");
  expect(restored.lease.fence).toBeGreaterThan(active.lease.fence);
  expect(restored.plan).toEqual(plan);
  expect(
    await db
      .prepare(
        "SELECT queue_id,backfill_run_id FROM archive_dispatch WHERE user_id=? AND object_id=?",
      )
      .bind(owner.userId, row.object_id)
      .first(),
  ).toEqual({ queue_id: row.queue_id, backfill_run_id: next.id });
});
it("exhausted cleanup fences cannot block unrelated cancellation or permit new admission by resetting counters", async () => {
  for (let index = 0; index < 3; index++)
    await document(`synthetic-cap-${index}`);
  const store = createArchiveBackfillStore(db);
  const run = await store.start(session, {
    connectionId: "drive",
    generation: 1,
    settingsVersion: 1,
  });
  const lease = await store.claim(owner, run.id);
  if (!lease) throw new Error("Synthetic cap run unavailable");
  await store.admitPage(lease);
  const capped = await db
    .prepare(
      "SELECT object_id FROM archive_dispatch WHERE user_id=? AND backfill_run_id=? ORDER BY queue_id LIMIT 1",
    )
    .bind(owner.userId, run.id)
    .first<{ object_id: string }>();
  if (!capped) throw new Error("Synthetic capped object unavailable");
  await db
    .prepare(
      "UPDATE archive_objects SET fence=?,lease_id='synthetic-cap-lease',lease_expires_at=? WHERE user_id=? AND id=?",
    )
    .bind(
      Number.MAX_SAFE_INTEGER,
      Date.now() + 60000,
      owner.userId,
      capped.object_id,
    )
    .run();
  await db
    .prepare(
      "UPDATE archive_dispatch SET dispatch_fence=? WHERE user_id=? AND object_id=?",
    )
    .bind(Number.MAX_SAFE_INTEGER, owner.userId, capped.object_id)
    .run();
  const current = await store.read(owner, run.id);
  expect(await store.cancel(session, run.id, current.revision)).toMatchObject({
    state: "canceled",
  });
  expect(
    await db
      .prepare(
        "SELECT fence,lease_id,lease_expires_at FROM archive_objects WHERE user_id=? AND id=?",
      )
      .bind(owner.userId, capped.object_id)
      .first(),
  ).toEqual({
    fence: Number.MAX_SAFE_INTEGER,
    lease_id: null,
    lease_expires_at: 0,
  });
  expect(
    await db
      .prepare(
        "SELECT status,dispatch_fence FROM archive_dispatch WHERE user_id=? AND object_id=?",
      )
      .bind(owner.userId, capped.object_id)
      .first(),
  ).toEqual({ status: "canceled", dispatch_fence: Number.MAX_SAFE_INTEGER });
  expect(
    await db
      .prepare(
        "SELECT count(*) AS total FROM archive_dispatch WHERE user_id=? AND backfill_run_id=? AND status='canceled'",
      )
      .bind(owner.userId, run.id)
      .first(),
  ).toEqual({ total: 3 });
  expect(await store.cleanupCanceled(owner, run.id)).toEqual({
    cleaned: 0,
    done: true,
  });
  const next = await store.start(session, {
    connectionId: "drive",
    generation: 1,
    settingsVersion: 1,
  });
  const nextLease = await store.claim(owner, next.id);
  if (!nextLease) throw new Error("Synthetic restarted cap run unavailable");
  expect(await store.admitPage(nextLease)).toMatchObject({
    admitted: 2,
    skipped: 1,
  });
  expect(
    await db
      .prepare("SELECT fence FROM archive_objects WHERE user_id=? AND id=?")
      .bind(owner.userId, capped.object_id)
      .first(),
  ).toEqual({ fence: Number.MAX_SAFE_INTEGER });
  expect(
    await db
      .prepare(
        "SELECT dispatch_fence,backfill_run_id,status FROM archive_dispatch WHERE user_id=? AND object_id=?",
      )
      .bind(owner.userId, capped.object_id)
      .first(),
  ).toEqual({
    dispatch_fence: Number.MAX_SAFE_INTEGER,
    backfill_run_id: run.id,
    status: "canceled",
  });
});

it("deleted frozen ordinal positions count as visited unavailable slots rather than uploaded originals", async () => {
  const ids = Array.from({ length: 7 }, (_, index) => `synthetic-gap-${index}`);
  for (const id of ids) await document(id);
  const store = createArchiveBackfillStore(db);
  const run = await store.start(session, {
    connectionId: "drive",
    generation: 1,
    settingsVersion: 1,
  });
  await db
    .prepare(
      "DELETE FROM documents WHERE user_id=? AND id IN ('synthetic-gap-1','synthetic-gap-3','synthetic-gap-6')",
    )
    .bind(owner.userId)
    .run();
  await document("000-synthetic-late-gap");
  for (const expected of [
    { admitted: 4, skipped: 2, cursorOrdinal: 6, done: false },
    { admitted: 0, skipped: 1, cursorOrdinal: 7, done: true },
  ]) {
    const meter = createInvocationDatabase(db, 40);
    for (let prefix = 0; prefix < 4; prefix++)
      await meter.db.prepare("SELECT 1").first();
    const bounded = createArchiveBackfillStore(meter.db);
    const lease = await bounded.claim(owner, run.id);
    if (!lease) throw new Error("Synthetic gap lease unavailable");
    expect(await bounded.admitPage(lease)).toEqual(expected);
    expect((await bounded.read(owner, run.id)).processedCount).toBe(
      expected.cursorOrdinal,
    );
    expect(meter.remainingStatements()).toBeGreaterThanOrEqual(3);
    for (let settlement = 0; settlement < 3; settlement++)
      await meter.db.prepare("SELECT 1").first();
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  }
  expect(await store.read(owner, run.id)).toMatchObject({
    processedCount: 7,
    state: "admission_complete",
  });
  expect(
    await db
      .prepare(
        "SELECT count(*) AS total FROM archive_dispatch WHERE user_id=? AND backfill_run_id=?",
      )
      .bind(owner.userId, run.id)
      .first(),
  ).toEqual({ total: 4 });
  expect(
    await db
      .prepare(
        "SELECT count(*) AS total FROM archive_objects WHERE user_id=? AND state='archived'",
      )
      .bind(owner.userId)
      .first(),
  ).toEqual({ total: 0 });
});

async function prepareAdvance() {
  for (let index = 0; index < 101; index++)
    await document(`synthetic-advance-${String(index).padStart(3, "0")}`);
  const store = createArchiveBackfillStore(db);
  let run = await store.start(session, {
    connectionId: "drive",
    generation: 1,
    settingsVersion: 1,
  });
  for (let step = 0; step < 20; step++) {
    const lease = await store.claim(owner, run.id);
    if (!lease) throw new Error("Synthetic advance admission unavailable");
    await store.admitPage(lease);
    run = await store.read(owner, run.id);
  }
  expect(run).toMatchObject({
    cursorOrdinal: 100,
    snapshotCount: 100,
    processedCount: 100,
    hasMore: true,
    state: "pending",
  });
  const lease = await store.claim(owner, run.id);
  if (!lease) throw new Error("Synthetic advance lease unavailable");
  return { store, run, lease };
}
async function advanceSnapshot(runId: string) {
  const run = await db
    .prepare(
      "SELECT snapshot_sequence,enumerated_through_sequence,processed_count,cursor_ordinal,snapshot_count,revision,state,lease_id,lease_expires_at,fence FROM archive_backfill_runs WHERE user_id=? AND id=?",
    )
    .bind(owner.userId, runId)
    .first();
  const members = (
    await db
      .prepare(
        "SELECT ordinal,document_id FROM archive_backfill_items WHERE user_id=? AND run_id=? ORDER BY ordinal",
      )
      .bind(owner.userId, runId)
      .all()
  ).results;
  return { run, members };
}
it("a native advance fault after deleting the exhausted window rolls back all members, frontier and revision", async () => {
  const { run, lease } = await prepareAdvance();
  const before = await advanceSnapshot(run.id);
  const meter = createInvocationDatabase(db, 40);
  for (let prefix = 0; prefix < 4; prefix++)
    await meter.db.prepare("SELECT 1").first();
  const faultDatabase: D1Database = {
    prepare: (query) => meter.db.prepare(query),
    exec: (query) => meter.db.exec(query),
    withSession: (constraint) => meter.db.withSession(constraint),
    dump: () => meter.db.dump(),
    batch: <T>(statements: D1PreparedStatement[]) =>
      meter.db.batch<T>([
        ...statements.slice(0, 2),
        meter.db.prepare("SELECT json('synthetic-advance-fault')"),
        ...statements.slice(2),
      ]),
  };
  await expect(
    createArchiveBackfillStore(faultDatabase).advance(lease),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await advanceSnapshot(run.id)).toEqual(before);
  expect(meter.remainingStatements()).toBeGreaterThanOrEqual(3);
  for (let settlement = 0; settlement < 3; settlement++)
    await meter.db.prepare("SELECT 1").first();
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
it.each(["consent", "revision"] as const)(
  "an advance %s race before its batch preserves the entire exhausted window and frontier",
  async (race) => {
    const { run, lease } = await prepareAdvance();
    const before = await advanceSnapshot(run.id);
    const meter = createInvocationDatabase(db, 40);
    for (let prefix = 0; prefix < 4; prefix++)
      await meter.db.prepare("SELECT 1").first();
    let raced: Awaited<ReturnType<typeof advanceSnapshot>> | undefined;
    const raceDatabase: D1Database = {
      prepare: (query) => meter.db.prepare(query),
      exec: (query) => meter.db.exec(query),
      withSession: (constraint) => meter.db.withSession(constraint),
      dump: () => meter.db.dump(),
      async batch<T>(statements: D1PreparedStatement[]) {
        if (race === "consent")
          await db
            .prepare(
              "UPDATE archive_settings SET enabled=0,version=version+1,connection_id=NULL,connection_generation=NULL,disclosure_version=NULL,accepted_at=NULL WHERE user_id=?",
            )
            .bind(owner.userId)
            .run();
        else
          await db
            .prepare(
              "UPDATE archive_backfill_runs SET revision=revision+1 WHERE user_id=? AND id=?",
            )
            .bind(owner.userId, run.id)
            .run();
        raced = await advanceSnapshot(run.id);
        return meter.db.batch<T>(statements);
      },
    };
    await expect(
      createArchiveBackfillStore(raceDatabase).advance(lease),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const after = await advanceSnapshot(run.id);
    expect(after).toEqual(raced);
    expect(after.members).toEqual(before.members);
    expect(after.run).toMatchObject({
      enumerated_through_sequence: before.run?.enumerated_through_sequence,
      cursor_ordinal: 100,
      snapshot_count: 100,
      processed_count: 100,
    });
    expect(meter.remainingStatements()).toBeGreaterThanOrEqual(3);
    for (let settlement = 0; settlement < 3; settlement++)
      await meter.db.prepare("SELECT 1").first();
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  },
);
