import { env } from "cloudflare:workers";
import { createLoginAuth, createProfileService } from "@invoxim/adapters";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import sessionMigration from "../../../packages/adapters/migrations/0002_archive_upload_sessions.sql?raw";
import { createArchiveObjectStore } from "../../../packages/adapters/src/drive/objects";
import { createArchiveUploadSessionStore } from "../../../packages/adapters/src/drive/session-store";
import { createCredentialCipher } from "../../../packages/adapters/src/security/cipher";
import type {
  ArchiveObjectWork,
  ArchiveUploadPlan,
} from "../../../packages/core/src/archive/objects";

const db = env.DB;
let owner: TenantContext, foreign: TenantContext;
const login = {
  origin: "https://synthetic.example",
  secret: "synthetic-upload-session-login-secret-123456789",
  googleClientId: "synthetic-login.apps.googleusercontent.com",
  googleClientSecret: "synthetic-client-secret",
  allowedEmails: ["upload-owner@example.test", "upload-foreign@example.test"],
};
const cipher = createCredentialCipher({
  activeVersion: 1,
  keys: {
    1: btoa(String.fromCharCode(...new Uint8Array(32).fill(11)))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_"),
  },
});
const plan: ArchiveUploadPlan = {
  fileId: "synthetic-upload-file",
  parentId: "synthetic-upload-folder",
  workspaceMarker: "synthetic-upload-workspace",
  mimeType: "message/rfc822",
  size: 6 * 1024 * 1024,
  sha256: "a".repeat(64),
};
const fences = {
  mailbox: {
    subject: "synthetic-mail-subject",
    credentialVersion: 0,
    scopes: JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
  },
  storage: {
    subject: "synthetic-drive-subject",
    credentialVersion: 0,
    scopes: JSON.stringify(["https://www.googleapis.com/auth/drive.file"]),
  },
};
let work: ArchiveObjectWork;
async function verified(id: string, email: string): Promise<TenantContext> {
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
  return profile.tenant;
}
beforeAll(async () => {
  for (const sql of [baseline, sessionMigration])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
  owner = await verified("synthetic-upload-owner", "upload-owner@example.test");
  foreign = await verified(
    "synthetic-upload-foreign",
    "upload-foreign@example.test",
  );
});
beforeEach(async () => {
  await db.prepare("DELETE FROM archive_upload_sessions").run();
  await db.prepare("DELETE FROM archive_objects").run();
  await db.prepare("DELETE FROM archive_settings").run();
  await db.prepare("DELETE FROM documents").run();
  await db.prepare("DELETE FROM source_messages").run();
  await db.prepare("DELETE FROM connections").run();
  for (const [id, kind, provider, subject, scopes] of [
    ["mail", "mailbox", "gmail", fences.mailbox.subject, fences.mailbox.scopes],
    [
      "drive",
      "storage",
      "google-drive",
      fences.storage.subject,
      fences.storage.scopes,
    ],
  ])
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes,credential_ciphertext,credential_key_version) VALUES(?,?,?,?,?,'synthetic@example.test',?,'synthetic-sealed',1)",
      )
      .bind(id, owner.userId, kind, provider, subject, scopes)
      .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('source',?,'mail','synthetic-message',0,1)",
    )
    .bind(owner.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('doc',?,'source','body',?,'text/plain',1)",
    )
    .bind(owner.userId, "b".repeat(64))
    .run();
  await db
    .prepare(
      "INSERT INTO archive_settings(user_id,enabled,version,connection_id,connection_generation,disclosure_version,accepted_at) VALUES(?,1,1,'drive',1,1,?)",
    )
    .bind(owner.userId, Date.now())
    .run();
  const objects = createArchiveObjectStore(db);
  const id = await objects.request(owner, {
    documentId: "doc",
    storageConnectionId: "drive",
    settingsVersion: 1,
  });
  const claimed = await objects.claim(owner, id);
  if (!claimed) throw new Error("Synthetic archive object unavailable");
  work = claimed;
  await expect(objects.savePlan(owner, work.lease, plan, fences)).resolves.toBe(
    true,
  );
});
async function reference() {
  return {
    ciphertext: await cipher.seal(
      owner,
      { entityId: work.lease.id, purpose: "archive-upload-session" },
      {
        url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=synthetic-encrypted-session",
        fileId: plan.fileId,
        sha256: plan.sha256,
      },
    ),
    keyVersion: 1,
    expiresAt: Date.now() + 60000,
  };
}
it("persists only encrypted session metadata after the exact original plan and returns its initial version", async () => {
  const store = createArchiveUploadSessionStore(db);
  await expect(store.read(owner, work.lease, plan, fences)).resolves.toBeNull();
  const saved = await store.save(
    owner,
    work.lease,
    plan,
    0,
    await reference(),
    fences,
  );
  expect(saved).toMatchObject({ keyVersion: 1, version: 1, uploadedBytes: 0 });
  if (!saved) throw new Error("Synthetic session save unavailable");
  expect(saved.ciphertext).not.toContain("upload_id");
  expect(
    await cipher.open(
      owner,
      { entityId: work.lease.id, purpose: "archive-upload-session" },
      saved.ciphertext,
    ),
  ).toMatchObject({ fileId: plan.fileId, sha256: plan.sha256 });
  await expect(store.read(owner, work.lease, plan, fences)).resolves.toEqual(
    saved,
  );
  await expect(
    store.read(foreign, work.lease, plan, fences),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});
it("fences progress against replaced session versions and refuses credential changes without overwriting the newer slot", async () => {
  const store = createArchiveUploadSessionStore(db);
  const first = await store.save(
    owner,
    work.lease,
    plan,
    0,
    await reference(),
    fences,
  );
  expect(first?.version).toBe(1);
  await expect(
    store.checkpoint(owner, work.lease, plan, 1, 4 * 1024 * 1024, fences),
  ).resolves.toBe(true);
  const second = await store.save(
    owner,
    work.lease,
    plan,
    1,
    await reference(),
    fences,
  );
  expect(second).toMatchObject({ version: 2, uploadedBytes: 0 });
  await expect(
    store.checkpoint(owner, work.lease, plan, 1, plan.size, fences),
  ).resolves.toBe(false);
  await db
    .prepare(
      "UPDATE connections SET credential_version=credential_version+1 WHERE user_id=? AND id='drive'",
    )
    .bind(owner.userId)
    .run();
  await expect(
    store.checkpoint(owner, work.lease, plan, 2, plan.size, fences),
  ).resolves.toBe(false);
  expect(
    await db
      .prepare(
        "SELECT version,uploaded_bytes FROM archive_upload_sessions WHERE user_id=? AND object_id=?",
      )
      .bind(owner.userId, work.lease.id)
      .first(),
  ).toEqual({ version: 2, uploaded_bytes: 0 });
});
