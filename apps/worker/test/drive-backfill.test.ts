import { env } from "cloudflare:workers";
import { createLoginAuth, createProfileService } from "@invoxim/adapters";
import type { ArchiveSession, TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import migration from "../../../packages/adapters/migrations/0006_archive_dispatch_backfill.sql?raw";
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
