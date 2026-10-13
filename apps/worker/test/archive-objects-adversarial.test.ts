import { env } from "cloudflare:workers";
import {
  createLoginAuth,
  createProfileService,
  type LoginConfiguration,
} from "@invoxim/adapters";
import type { ArchiveUploadPlan, TenantContext } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import backfillMigration from "../../../packages/adapters/migrations/0006_archive_dispatch_backfill.sql?raw";
import { createArchiveObjectStore } from "../../../packages/adapters/src/drive/objects";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;

const login: LoginConfiguration = {
  origin: "https://synthetic.example",
  secret: "synthetic-archive-clock-login-secret-1234567890",
  googleClientId: "synthetic-google-login",
  googleClientSecret: "synthetic-login-secret",
  allowedEmails: ["archive-clock@example.invalid"],
};
let tenant: TenantContext;
beforeAll(async () => {
  for (const sql of [baseline, backfillMigration])
    for (const statement of sql.split(";").filter((v) => v.trim()))
      await db.prepare(statement).run();

  const userId = "qa-archive-clock";
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)",
    )
    .bind(
      userId,
      "Synthetic archive clock",
      "archive-clock@example.invalid",
      Date.now(),
      Date.now(),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
    )
    .bind(userId, Date.now(), Date.now())
    .run();
  const auth = createLoginAuth(db, login),
    context = await auth.$context,
    session = await context.internalAdapter.createSession(userId, false);
  if (!session)
    throw new Error("Positive fixture requires actual application session");
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
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
  const current = await createProfileService(db, auth, login).current(
    new Headers({ Cookie: cookie }),
  );
  if (!current)
    throw new Error("Server must verify synthetic signed application session");
  tenant = current.tenant;
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
        userId,
        kind,
        provider,
        `synthetic-${id}`,
        JSON.stringify(["https://www.googleapis.com/auth/drive.file"]),
      )
      .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('source',?,'mail','synthetic-message',0,1)",
    )
    .bind(userId)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('document',?,'source','attachment:1','synthetic-hash','application/pdf',3)",
    )
    .bind(userId)
    .run();
  await db
    .prepare(
      "INSERT INTO archive_settings(user_id,enabled,version,connection_id,connection_generation,disclosure_version,accepted_at) VALUES(?,1,1,'drive',1,1,0)",
    )
    .bind(userId)
    .run();
});
it("ARCH-02 a completion timestamp and its lease-expiry decision remain consistent across the clock boundary", async () => {
  const before = createInvocationDatabase(env.DB, 40),
    store = createArchiveObjectStore(before.db, {
      clock: () => 1000,
      leaseMs: 1000,
    });
  const id = await store.request(tenant, {
      documentId: "document",
      storageConnectionId: "drive",
      settingsVersion: 1,
    }),
    work = await store.claim(tenant, id);
  if (!work) throw new Error("Positive fixture must obtain archive work lease");
  const plan: ArchiveUploadPlan = {
    fileId: "synthetic-file",
    parentId: "synthetic-parent",
    workspaceMarker: "synthetic-workspace-marker",
    mimeType: "application/pdf",
    size: 3,
    sha256: "a".repeat(64),
  };
  expect(await store.savePlan(tenant, work.lease, plan)).toBe(true);
  expect(before.executedStatements()).toBeLessThanOrEqual(40);
  let samples = 0;
  const metered = createInvocationDatabase(env.DB, 40),
    boundary = createArchiveObjectStore(metered.db, {
      clock: () =>
        ++samples === 1 ? work.lease.expiresAt - 1 : work.lease.expiresAt,
      leaseMs: 1000,
    });
  const completed = await boundary.complete(tenant, work.lease);
  const row = await db
    .prepare(
      "SELECT state,remote_id,archived_at,planned_file_id FROM archive_objects WHERE user_id=? AND id=?",
    )
    .bind(tenant.userId, id)
    .first<{
      state: string;
      remote_id: string | null;
      archived_at: number | null;
      planned_file_id: string;
    }>();
  if (!row)
    throw new Error(
      "Archive row must remain present after a completion decision",
    );
  expect(samples).toBeGreaterThanOrEqual(1);
  expect(row.planned_file_id).toBe(plan.fileId);
  if (completed) {
    expect(row.state).toBe("archived");
    expect(row.remote_id).toBe(plan.fileId);
    if (row.archived_at === null)
      throw new Error("Successful completion must record its decision time");
    expect(row.archived_at).toBeLessThan(work.lease.expiresAt);
  } else
    expect(row).toMatchObject({
      state: "pending",
      remote_id: null,
      archived_at: null,
    });
  expect(metered.executedStatements()).toBeLessThanOrEqual(40);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
