// Explicit populated historical-upgrade fixture; old SQL is never an active deployment migration.

import { env } from "cloudflare:workers";
import type { ArchiveUploadPlan, TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { createArchiveObjectStore } from "../../../packages/adapters/src/drive/objects";
import { cleanupM1Leaves } from "../../../packages/adapters/src/lifecycle/m1-leaf-cleanup";
import { createInvocationDatabase } from "../src/invocation-database";
import { useCurrentSchema } from "./support/db";

const db = env.DB;

const owner = { userId: "archive-owner", authority: "job" } as TenantContext;
const foreign = {
  userId: "archive-foreign",
  authority: "job",
} as TenantContext;
const start = Date.UTC(2026, 9, 13);
let now = start;
const request = {
  documentId: "doc",
  storageConnectionId: "drive",
  settingsVersion: 1,
};
const plan: ArchiveUploadPlan = {
  fileId: "synthetic-file",
  parentId: "synthetic-folder",
  workspaceMarker: "synthetic-workspace-marker",
  mimeType: "application/pdf",
  size: 3,
  sha256: "a".repeat(64),
};
const store = () =>
  createArchiveObjectStore(db, { clock: () => now, leaseMs: 60000 });
beforeAll(async () => {
  await useCurrentSchema(db);
  for (const user of [owner.userId, foreign.userId]) {
    await db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)',
      )
      .bind(user, "Synthetic", `${user}@example.invalid`, start, start)
      .run();
    await db
      .prepare(
        "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
      )
      .bind(user, start, start)
      .run();
    for (const [id, kind, provider] of [
      ["mail", "mailbox", "gmail"],
      ["drive", "storage", "google-drive"],
    ])
      await db
        .prepare(
          "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,credential_ciphertext,credential_key_version,scopes) VALUES(?,?,?,?,?,'synthetic@example.invalid','synthetic-sealed',1,?)",
        )
        .bind(
          id,
          user,
          kind,
          provider,
          user + id,
          JSON.stringify(["https://www.googleapis.com/auth/drive.file"]),
        )
        .run();
    await db
      .prepare(
        "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('source',?,'mail','synthetic-message',0,1)",
      )
      .bind(user)
      .run();
    await db
      .prepare(
        "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('doc',?,'source','attachment:1','synthetic-hash','application/pdf',3)",
      )
      .bind(user)
      .run();
  }
});
beforeEach(async () => {
  now = start;
  await db.prepare("DELETE FROM archive_objects").run();
  await db.prepare("DELETE FROM archive_settings").run();
  await db.prepare("DELETE FROM lifecycle_deletions").run();
  await db.prepare("DELETE FROM documents WHERE id LIKE 'bulk-%'").run();
  await db.prepare("UPDATE profiles SET status='active'").run();
  await db
    .prepare(
      "UPDATE connections SET state='connected',generation=1,credential_ciphertext='synthetic-sealed',credential_key_version=1,provider_subject=user_id||id,scopes=?",
    )
    .bind(JSON.stringify(["https://www.googleapis.com/auth/drive.file"]))
    .run();
  await db
    .prepare(
      "UPDATE documents SET content_hash='synthetic-hash',part_key='attachment:1' WHERE id='doc'",
    )
    .run();
  await db
    .prepare(
      "UPDATE source_messages SET available=1,generation=1,provider_message_id='synthetic-message'",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO archive_settings(user_id,enabled,version,connection_id,connection_generation,disclosure_version,accepted_at) VALUES(?,1,1,'drive',1,1,?)",
    )
    .bind(owner.userId, start)
    .run();
});
it("ARCH-02: requests are idempotent and a durable plan survives lease expiry and reacquisition", async () => {
  const repository = store();
  const id = await repository.request(owner, request);
  expect(await repository.request(owner, request)).toBe(id);
  const work = await repository.claim(owner, id);
  expect(work).toMatchObject({
    documentId: "doc",
    providerMessageId: "synthetic-message",
    partKey: "attachment:1",
    storageSubject: `${owner.userId}drive`,
    settingsVersion: 1,
    plan: null,
  });
  if (!work) throw new Error("Expected archive lease");
  expect(await repository.claim(owner, id)).toBeNull();
  expect(await repository.savePlan(owner, work.lease, plan)).toBe(true);
  now += 60000;
  const retry = await repository.claim(owner, id);
  expect(retry).toMatchObject({ plan, lease: { fence: work.lease.fence + 1 } });
  if (!retry) throw new Error("Expected retry lease");
  expect(
    await repository.savePlan(owner, work.lease, { ...plan, fileId: "loser" }),
  ).toBe(false);
  expect(await repository.complete(owner, work.lease)).toBe(false);
  expect(await repository.authorized(owner, retry.lease)).toBe(true);
  expect(await repository.complete(owner, retry.lease)).toBe(true);
  expect(await repository.claim(owner, id)).toBeNull();
  expect(
    await db
      .prepare(
        "SELECT state,remote_id,original_sha256,lease_id FROM archive_objects WHERE user_id=? AND id=?",
      )
      .bind(owner.userId, id)
      .first(),
  ).toEqual({
    state: "archived",
    remote_id: plan.fileId,
    original_sha256: plan.sha256,
    lease_id: null,
  });
});

async function claimed() {
  const repository = store(),
    id = await repository.request(owner, request),
    work = await repository.claim(owner, id);
  if (!work) throw new Error("Expected work");
  return { repository, id, work };
}
it("ARCH-02: racing requests select one object and racing claims select one lease", async () => {
  const repository = store();
  const ids = await Promise.all([
    repository.request(owner, request),
    repository.request(owner, request),
  ]);
  expect(new Set(ids).size).toBe(1);
  const leases = await Promise.all(
    ids.map((id) => repository.claim(owner, id)),
  );
  expect(leases.filter(Boolean)).toHaveLength(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS total FROM archive_objects WHERE user_id=?")
      .bind(owner.userId)
      .first("total"),
  ).toBe(1);
});
it("ARCH-02: no completion without saved plan; immutable ID/hash/parent tuple allows only exact replay", async () => {
  const { repository, work } = await claimed();
  expect(await repository.complete(owner, work.lease)).toBe(false);
  expect(await repository.savePlan(owner, work.lease, plan)).toBe(true);
  expect(await repository.savePlan(owner, work.lease, plan)).toBe(true);
  for (const changed of [
    { fileId: "another-file" },
    { parentId: "another-folder" },
    { sha256: "b".repeat(64) },
    { size: 4 },
    { mimeType: "image/png" as const },
    { workspaceMarker: "another-workspace-marker" },
  ])
    expect(
      await repository.savePlan(owner, work.lease, { ...plan, ...changed }),
    ).toBe(false);
});
it.each([
  [
    "consent disabled",
    "UPDATE archive_settings SET enabled=0,version=2,connection_id=NULL,connection_generation=NULL,disclosure_version=NULL,accepted_at=NULL WHERE user_id=?",
  ],
  ["consent renewed", "UPDATE archive_settings SET version=2 WHERE user_id=?"],
  [
    "Drive disconnect",
    "UPDATE connections SET state='disconnected',generation=2 WHERE user_id=? AND id='drive'",
  ],
  [
    "Drive generation",
    "UPDATE connections SET generation=2 WHERE user_id=? AND id='drive'",
  ],
  [
    "Drive subject",
    "UPDATE connections SET provider_subject='different-subject' WHERE user_id=? AND id='drive'",
  ],
  [
    "Drive permission",
    "UPDATE connections SET scopes='[]' WHERE user_id=? AND id='drive'",
  ],
  [
    "Drive object scopes",
    `UPDATE connections SET scopes='{"unexpected":"https://www.googleapis.com/auth/drive.file"}' WHERE user_id=? AND id='drive'`,
  ],
  [
    "Drive malformed scopes",
    "UPDATE connections SET scopes='broken-json' WHERE user_id=? AND id='drive'",
  ],
  [
    "Drive credential",
    "UPDATE connections SET credential_ciphertext=NULL,credential_key_version=NULL WHERE user_id=? AND id='drive'",
  ],
  [
    "mail disconnect",
    "UPDATE connections SET state='disconnected',generation=2 WHERE user_id=? AND id='mail'",
  ],
  [
    "mail credential",
    "UPDATE connections SET credential_ciphertext=NULL,credential_key_version=NULL WHERE user_id=? AND id='mail'",
  ],
  [
    "source tombstone",
    "UPDATE source_messages SET available=0 WHERE user_id=?",
  ],
  [
    "source generation",
    "UPDATE source_messages SET generation=2 WHERE user_id=?",
  ],
  [
    "source identity",
    "UPDATE source_messages SET provider_message_id='different-message' WHERE user_id=?",
  ],
  [
    "document hash",
    "UPDATE documents SET content_hash='changed' WHERE user_id=?",
  ],
  [
    "document part",
    "UPDATE documents SET part_key='attachment:2' WHERE user_id=?",
  ],
  ["account deleting", "UPDATE profiles SET status='deleting' WHERE user_id=?"],
])(
  "ARCH-02: %s invalidates authorization, lease reacquisition, plans and completion",
  async (_label, sql) => {
    const { repository, id, work } = await claimed();
    expect(await repository.savePlan(owner, work.lease, plan)).toBe(true);
    await db.prepare(sql).bind(owner.userId).run();
    expect(await repository.authorized(owner, work.lease)).toBe(false);
    expect(await repository.savePlan(owner, work.lease, plan)).toBe(false);
    expect(await repository.complete(owner, work.lease)).toBe(false);
    now += 60000;
    expect(await repository.claim(owner, id)).toBeNull();
    expect(
      await db
        .prepare(
          "SELECT state,remote_id FROM archive_objects WHERE user_id=? AND id=?",
        )
        .bind(owner.userId, id)
        .first(),
    ).toEqual({ state: "pending", remote_id: null });
  },
);
it("ARCH-02: cross-tenant requests and forged lease fields cannot write owned work", async () => {
  const { repository, id, work } = await claimed();
  await expect(repository.request(foreign, request)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(await repository.claim(foreign, id)).toBeNull();
  expect(await repository.authorized(foreign, work.lease)).toBe(false);
  expect(await repository.savePlan(foreign, work.lease, plan)).toBe(false);
  expect(await repository.complete(foreign, work.lease)).toBe(false);
  for (const changed of [
    { leaseId: "other" },
    { fence: 2 },
    { expiresAt: work.lease.expiresAt + 1 },
  ]) {
    expect(
      await repository.authorized(owner, { ...work.lease, ...changed }),
    ).toBe(false);
    expect(
      await repository.savePlan(owner, { ...work.lease, ...changed }, plan),
    ).toBe(false);
  }
});
it("ARCH-02: exact lease expiry blocks calls before a replacement worker claims", async () => {
  const { repository, work } = await claimed();
  now = work.lease.expiresAt;
  expect(await repository.authorized(owner, work.lease)).toBe(false);
  expect(await repository.savePlan(owner, work.lease, plan)).toBe(false);
  expect(await repository.complete(owner, work.lease)).toBe(false);
});
it("ARCH-02: invalid inputs, SQL detail and overflowing fences fail closed", async () => {
  const { repository, id, work } = await claimed();
  await expect(
    repository.request(owner, { ...request, documentId: "doc\u0000" }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    repository.request(owner, { ...request, settingsVersion: 1.5 }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    repository.savePlan(owner, work.lease, {
      ...plan,
      fileId: "https://example.invalid",
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    repository.savePlan(owner, work.lease, { ...plan, size: 0 }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await db
    .prepare(
      "UPDATE archive_objects SET fence=9007199254740991,lease_id=NULL,lease_expires_at=0 WHERE user_id=? AND id=?",
    )
    .bind(owner.userId, id)
    .run();
  expect(await repository.claim(owner, id)).toBeNull();
  const broken = {
    prepare() {
      throw new Error("synthetic-sensitive-driver-detail");
    },
  } as unknown as D1Database;
  await expect(
    createArchiveObjectStore(broken).request(owner, request),
  ).rejects.toMatchObject({ code: "UNAVAILABLE", message: "UNAVAILABLE" });
});
it("ARCH-02: populated migration enforces ownership and complete plan metadata; source deletion cannot resurrect work", async () => {
  const { repository, id, work } = await claimed();
  await expect(
    db
      .prepare(
        "UPDATE archive_objects SET document_id='missing' WHERE user_id=? AND id=?",
      )
      .bind(owner.userId, id)
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "UPDATE archive_objects SET planned_file_id='partial' WHERE user_id=? AND id=?",
      )
      .bind(owner.userId, id)
      .run(),
  ).rejects.toThrow();
  await db
    .prepare("DELETE FROM source_messages WHERE user_id=? AND id='source'")
    .bind(owner.userId)
    .run();
  expect(await repository.savePlan(owner, work.lease, plan)).toBe(false);
  expect(await repository.complete(owner, work.lease)).toBe(false);
  expect(await repository.claim(owner, id)).toBeNull();
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  // Restore only synthetic fixtures for later tests.
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('source',?,'mail','synthetic-message',0,1)",
    )
    .bind(owner.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('doc',?,'source','attachment:1','synthetic-hash','application/pdf',3)",
    )
    .bind(owner.userId)
    .run();
});
it("ARCH-02: request/claim/save/check/complete use at most six invocation queries", async () => {
  const metered = createInvocationDatabase(env.DB, 6),
    repository = createArchiveObjectStore(metered.db, { clock: () => now });
  const id = await repository.request(owner, request),
    work = await repository.claim(owner, id);
  if (!work) throw new Error("Expected work");
  expect(await repository.savePlan(owner, work.lease, plan)).toBe(true);
  expect(await repository.authorized(owner, work.lease)).toBe(true);
  expect(await repository.complete(owner, work.lease)).toBe(true);
  expect(metered.executedStatements()).toBe(6);
});
it("ARCH-02: bounded account cleanup removes archive objects before legacy document cascade", async () => {
  await claimed();
  await db
    .prepare("UPDATE profiles SET status='deleting' WHERE user_id=?")
    .bind(owner.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,journal_ack) VALUES(?,'account',?,'archive-delete',?,1)",
    )
    .bind(owner.userId, owner.userId, start)
    .run();
  const item = {
    user_id: owner.userId,
    scope: "account" as const,
    target_id: owner.userId,
    request_id: "archive-delete",
    stage: 0,
    deleted_at: start,
  };
  for (let i = 0; i < 3; i++) await cleanupM1Leaves(db, item);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS total FROM archive_objects WHERE user_id=?")
      .bind(owner.userId)
      .first("total"),
  ).toBe(0);
  await db
    .prepare("DELETE FROM lifecycle_deletions WHERE user_id=?")
    .bind(owner.userId)
    .run();
});

it("ARCH-02: all current leaf tables coexist and one cleanup step deletes at most 100 archive rows", async () => {
  const { id } = await claimed();
  await db.batch(
    Array.from({ length: 100 }, (_, index) =>
      db
        .prepare(
          "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES(?,?,'source',?,'synthetic-hash','application/pdf',3)",
        )
        .bind(`bulk-${index}`, owner.userId, `attachment:bulk-${index}`),
    ),
  );
  await db
    .prepare(
      "INSERT INTO archive_objects(id,user_id,document_id,source_message_id,provider_message_id,part_key,document_hash,document_mime,document_size,mailbox_connection_id,mailbox_generation,storage_connection_id,storage_generation,storage_subject,settings_version) SELECT d.id,d.user_id,d.id,a.source_message_id,a.provider_message_id,d.part_key,a.document_hash,a.document_mime,a.document_size,a.mailbox_connection_id,a.mailbox_generation,a.storage_connection_id,a.storage_generation,a.storage_subject,a.settings_version FROM documents d JOIN archive_objects a ON a.user_id=d.user_id AND a.id=? WHERE d.user_id=? AND d.id LIKE 'bulk-%'",
    )
    .bind(id, owner.userId)
    .run();
  await db
    .prepare("UPDATE profiles SET status='deleting' WHERE user_id=?")
    .bind(owner.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,journal_ack) VALUES(?,'account',?,'archive-bulk',?,1)",
    )
    .bind(owner.userId, owner.userId, start)
    .run();
  // Children-first leaves (upload sessions from claim, etc.) drain before
  // archive_objects; clear them so this step isolates the archive_objects cap.
  for (const table of [
    "archive_upload_sessions",
    "archive_backfill_items",
    "archive_dispatch",
    "archive_document_order",
    "archive_backfill_runs",
  ])
    await db
      .prepare(`DELETE FROM ${table} WHERE user_id=?`)
      .bind(owner.userId)
      .run();
  expect(
    await cleanupM1Leaves(db, {
      user_id: owner.userId,
      scope: "account",
      target_id: owner.userId,
      request_id: "archive-bulk",
      stage: 0,
      deleted_at: start,
    }),
  ).toBe(true);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS total FROM archive_objects WHERE user_id=?")
      .bind(owner.userId)
      .first("total"),
  ).toBe(1);
});
it.each(["mail", "drive"])(
  "ARCH-02: connection cleanup drains archive work for %s under the current deletion request",
  async (target) => {
    await claimed();
    await db
      .prepare(
        "UPDATE connections SET state='disconnected',generation=2 WHERE user_id=? AND id=?",
      )
      .bind(owner.userId, target)
      .run();
    await db
      .prepare(
        "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at) VALUES(?,'connection',?,'archive-unlink',?)",
      )
      .bind(owner.userId, target, start)
      .run();
    expect(
      await cleanupM1Leaves(db, {
        user_id: owner.userId,
        scope: "connection",
        target_id: target,
        request_id: "stale-request",
        stage: 0,
      }),
    ).toBe(true);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS total FROM archive_objects WHERE user_id=?",
        )
        .bind(owner.userId)
        .first("total"),
    ).toBe(1);
    expect(
      await cleanupM1Leaves(db, {
        user_id: owner.userId,
        scope: "connection",
        target_id: target,
        request_id: "archive-unlink",
        stage: 0,
      }),
    ).toBe(true);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS total FROM archive_objects WHERE user_id=?",
        )
        .bind(owner.userId)
        .first("total"),
    ).toBe(0);
  },
);

it("ARCH-02: unavailable source cannot admit new archive work", async () => {
  await db
    .prepare("UPDATE source_messages SET available=0 WHERE user_id=?")
    .bind(owner.userId)
    .run();
  await expect(store().request(owner, request)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS total FROM archive_objects WHERE user_id=?")
      .bind(owner.userId)
      .first("total"),
  ).toBe(0);
});
