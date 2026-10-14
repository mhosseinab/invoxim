import { env } from "cloudflare:workers";
import { createLoginAuth, createProfileService } from "@invoxim/adapters";
import type { ArchiveSession, TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import migration from "../../../packages/adapters/migrations/0006_archive_dispatch_backfill.sql?raw";
import { createArchiveDispatchStore } from "../../../packages/adapters/src/drive/dispatch-store";
import { createArchiveObjectStore } from "../../../packages/adapters/src/drive/objects";
import { createArchiveQueue } from "../../../packages/adapters/src/drive/queue";
import type { ArchiveQueueWorkflow } from "../../../packages/core/src/archive/queue-types";
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

it("consumes only a strict opaque archive envelope, captures the exact object lease and settles real durable continuation within three statements", async () => {
  const id = await object();
  const setup = createArchiveDispatchStore(db);
  await setup.enqueue(owner, id, "synthetic-consume-id");
  const candidate = (await setup.due(1))[0];
  if (!candidate) throw new Error("Synthetic candidate unavailable");
  await setup.reserve(candidate);
  const meter = createInvocationDatabase(db, 40);
  const objects = createArchiveObjectStore(meter.db);
  const workflow: ArchiveQueueWorkflow = {
    async run(context, objectId, signal, onClaim) {
      expect(context.userId).toBe(owner.userId);
      expect(context.authority).toBe("job");
      expect(signal.aborted).toBe(false);
      const claimed = await objects.claim(context, objectId);
      if (!claimed) throw new Error("Synthetic claim unavailable");
      onClaim(claimed.lease);
      await objects.release(context, claimed.lease);
      return { status: "deferred" };
    },
  };
  const run = vi.spyOn(workflow, "run");
  const engine = createArchiveQueue({
    store: createArchiveDispatchStore(meter.db),
    objects,
    workflow,
    queue: {
      send: async () => {
        throw new Error("Synthetic consume must not dispatch");
      },
    },
    remainingStatements: meter.remainingStatements,
  });
  await expect(
    engine.consume({
      schemaVersion: 2,
      archiveId: "synthetic-consume-id",
      userId: foreign.userId,
    }),
  ).resolves.toBe("ack");
  expect(meter.executedStatements()).toBeLessThanOrEqual(0);
  expect(run).not.toHaveBeenCalled();
  await expect(
    engine.consume({ schemaVersion: 2, archiveId: "synthetic-consume-id" }),
  ).resolves.toBe("ack");
  expect(meter.executedStatements()).toBeLessThanOrEqual(6);
  expect(run).toHaveBeenCalledTimes(1);
  expect(
    await db
      .prepare(
        "SELECT status,failure_count,outcome_code FROM archive_dispatch WHERE queue_id='synthetic-consume-id'",
      )
      .first(),
  ).toEqual({
    status: "retry_wait",
    failure_count: 0,
    outcome_code: "deferred",
  });
  expect(
    await db.prepare("SELECT count(*) AS total FROM jobs").first(),
  ).toEqual({ total: 0 });
});

it("persists a dispatch reservation before a failed queue send so the same opaque ID remains durably recoverable", async () => {
  const id = await object();
  const store = createArchiveDispatchStore(db);
  await store.enqueue(owner, id, "synthetic-lost-send-id");
  const meter = createInvocationDatabase(db, 40);
  const send = vi.fn(
    async (message: { schemaVersion: 2; archiveId: string }) => {
      expect(message).toEqual({
        schemaVersion: 2,
        archiveId: "synthetic-lost-send-id",
      });
      expect(
        await db
          .prepare(
            "SELECT dispatch_fence,dispatched_at FROM archive_dispatch WHERE queue_id=?",
          )
          .bind(message.archiveId)
          .first(),
      ).toMatchObject({ dispatch_fence: 1, dispatched_at: expect.any(Number) });
      throw new Error("Synthetic lost queue send");
    },
  );
  const engine = createArchiveQueue({
    store: createArchiveDispatchStore(meter.db),
    objects: createArchiveObjectStore(meter.db),
    workflow: {
      run: async () => {
        throw new Error("Synthetic dispatch must not execute upload");
      },
    },
    queue: { send },
    remainingStatements: meter.remainingStatements,
  });
  await expect(engine.dispatch()).resolves.toEqual({ sent: 0 });
  expect(send).toHaveBeenCalledTimes(1);
  expect(meter.executedStatements()).toBeLessThanOrEqual(4);
  expect(
    await db
      .prepare(
        "SELECT queue_id,dispatch_fence,status FROM archive_dispatch WHERE user_id=? AND object_id=?",
      )
      .bind(owner.userId, id)
      .first(),
  ).toEqual({
    queue_id: "synthetic-lost-send-id",
    dispatch_fence: 1,
    status: "ready",
  });
});

it("bounds an invalid due candidate prefix and advances past it without scanning for a later eligible object", async () => {
  const invalid = await object();
  await document("synthetic-later-doc");
  const valid = await createArchiveObjectStore(db).request(owner, {
    documentId: "synthetic-later-doc",
    storageConnectionId: "drive",
    settingsVersion: 1,
  });
  const store = createArchiveDispatchStore(db);
  await store.enqueue(owner, invalid, "000-synthetic-invalid");
  await store.enqueue(owner, valid, "999-synthetic-valid");
  await db
    .prepare(
      "UPDATE source_messages SET available=0 WHERE user_id=? AND id='source-synthetic-doc'",
    )
    .bind(owner.userId)
    .run();
  await expect(store.due(1)).resolves.toEqual([]);
  expect(
    await db
      .prepare(
        "SELECT status,outcome_code FROM archive_dispatch WHERE queue_id='000-synthetic-invalid'",
      )
      .first(),
  ).toEqual({ status: "paused", outcome_code: "source_missing" });
  expect((await store.due(1)).map((value) => value.queueId)).toEqual([
    "999-synthetic-valid",
  ]);
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
async function object() {
  await document("synthetic-doc");
  return createArchiveObjectStore(db).request(owner, {
    documentId: "synthetic-doc",
    storageConnectionId: "drive",
    settingsVersion: 1,
  });
}
it("loads only the authoritative workspace through a globally unique archive queue ID without any processing consent", async () => {
  const id = await object();
  const store = createArchiveDispatchStore(db);
  expect(await store.enqueue(owner, id, "synthetic-archive-queue-id")).toBe(
    true,
  );
  expect(await store.enqueue(owner, id, "synthetic-other-id")).toBe(false);
  expect(await store.enqueue(foreign, id, "synthetic-foreign-id")).toBe(false);
  await expect(store.load("synthetic-archive-queue-id")).resolves.toMatchObject(
    {
      kind: "ready",
      work: {
        context: { userId: owner.userId, authority: "job" },
        objectId: id,
        queueId: "synthetic-archive-queue-id",
        dispatchFence: 0,
        objectFence: 0,
        failureCount: 0,
      },
    },
  );
  expect(
    await db
      .prepare("SELECT count(*) AS total FROM processing_consents")
      .first(),
  ).toEqual({ total: 0 });
  expect(
    await db.prepare("SELECT count(*) AS total FROM jobs").first(),
  ).toEqual({ total: 0 });
  await db
    .prepare(
      "UPDATE archive_settings SET enabled=0,version=2,connection_id=NULL,connection_generation=NULL,disclosure_version=NULL,accepted_at=NULL WHERE user_id=?",
    )
    .bind(owner.userId)
    .run();
  await expect(store.load("synthetic-archive-queue-id")).resolves.toEqual({
    kind: "blocked",
  });
});
it("atomically reserves one dispatch winner and settles deferred progress without incrementing failure count", async () => {
  const id = await object();
  const store = createArchiveDispatchStore(db);
  await store.enqueue(owner, id, "synthetic-archive-queue-id");
  const candidate = (await store.due(1))[0];
  if (!candidate) throw new Error("Synthetic due archive absent");
  const reserved = await store.reserve(candidate);
  expect(reserved?.dispatchFence).toBe(1);
  expect(await store.reserve(candidate)).toBeNull();
  if (!reserved) throw new Error("Synthetic reservation absent");
  const objects = createArchiveObjectStore(db);
  const claimed = await objects.claim(owner, id);
  if (!claimed) throw new Error("Synthetic execution lease absent");
  await objects.release(owner, claimed.lease);
  const finished = { ...reserved, objectFence: claimed.lease.fence };
  expect(
    await store.settle(finished, { kind: "deferred", code: "deferred" }),
  ).toBe(true);
  expect(
    await db
      .prepare(
        "SELECT status,failure_count,outcome_code FROM archive_dispatch WHERE user_id=? AND object_id=?",
      )
      .bind(owner.userId, id)
      .first(),
  ).toEqual({
    status: "retry_wait",
    failure_count: 0,
    outcome_code: "deferred",
  });
  await db
    .prepare(
      "UPDATE archive_dispatch SET dispatch_fence=dispatch_fence+1 WHERE user_id=? AND object_id=?",
    )
    .bind(owner.userId, id)
    .run();
  expect(
    await store.settle(finished, { kind: "retry", code: "transient" }),
  ).toBe(false);
  expect(
    await db
      .prepare(
        "SELECT failure_count FROM archive_dispatch WHERE user_id=? AND object_id=?",
      )
      .bind(owner.userId, id)
      .first(),
  ).toEqual({ failure_count: 0 });
});
