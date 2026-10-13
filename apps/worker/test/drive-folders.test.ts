// Explicit populated historical-upgrade fixture; old SQL is never an active deployment migration.

import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { createArchiveFolderStore } from "../../../packages/adapters/src/drive/folders";
import m1 from "./migrations/historical/0001_auth.sql?raw";
import m2 from "./migrations/historical/0002_records.sql?raw";
import m3 from "./migrations/historical/0003_indexes_and_schedule.sql?raw";
import m4 from "./migrations/historical/0004_credentials_and_oauth.sql?raw";
import m5 from "./migrations/historical/0005_profile_version.sql?raw";
import m6 from "./migrations/historical/0006_jobs.sql?raw";
import m7 from "./migrations/historical/0007_mailbox.sql?raw";
import m8 from "./migrations/historical/0008_discovery.sql?raw";
import m9 from "./migrations/historical/0009_ai.sql?raw";
import m10 from "./migrations/historical/0010_ledger_pipeline.sql?raw";
import m11 from "./migrations/historical/0011_lifecycle.sql?raw";
import m12 from "./migrations/historical/0012_review_fields.sql?raw";
import m13 from "./migrations/historical/0013_corrections.sql?raw";
import m14 from "./migrations/historical/0014_onboarding.sql?raw";
import m15 from "./migrations/historical/0015_fx.sql?raw";
import m16 from "./migrations/historical/0016_outlook_folders.sql?raw";
import m17 from "./migrations/historical/0017_drive_storage.sql?raw";
import m18 from "./migrations/historical/0018_archive_objects.sql?raw";
import m19 from "./migrations/historical/0019_archive_folders.sql?raw";

const db = env.DB;
const owner = { userId: "folder-owner", authority: "job" } as TenantContext;
const foreign = { userId: "folder-foreign", authority: "job" } as TenantContext;
const auth = { connectionId: "drive", settingsVersion: 1, generation: 1 };
const proposed = {
  fileId: "synthetic-folder",
  workspaceMarker: "synthetic-workspace-marker",
};
const start = Date.UTC(2026, 9, 13);
let now = start;
const store = () =>
  createArchiveFolderStore(db, { clock: () => now, leaseMs: 1000 });
beforeAll(async () => {
  for (const sql of [
    m1,
    m2,
    m3,
    m4,
    m5,
    m6,
    m7,
    m8,
    m9,
    m10,
    m11,
    m12,
    m13,
    m14,
    m15,
    m16,
    m17,
    m18,
  ])
    for (const statement of sql.split(";").filter((s) => s.trim()))
      await db.prepare(statement).run();
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
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,credential_ciphertext,credential_key_version,scopes) VALUES('drive',?,'storage','google-drive',?,'synthetic@example.invalid','synthetic-sealed',1,?)",
      )
      .bind(
        user,
        `${user}subject`,
        JSON.stringify(["https://www.googleapis.com/auth/drive.file"]),
      )
      .run();
  }
  for (const statement of m19.split(";").filter((s) => s.trim()))
    await db.prepare(statement).run();
});
beforeEach(async () => {
  now = start;
  await db.prepare("DELETE FROM archive_folders").run();
  await db.prepare("DELETE FROM archive_settings").run();
  await db.prepare("DELETE FROM lifecycle_deletions").run();
  await db.prepare("UPDATE profiles SET status='active'").run();
  await db
    .prepare(
      "UPDATE connections SET state='connected',generation=1,credential_ciphertext='synthetic-sealed',credential_key_version=1,provider_subject=user_id||'subject',scopes=?",
    )
    .bind(JSON.stringify(["https://www.googleapis.com/auth/drive.file"]))
    .run();
  await db
    .prepare(
      "INSERT INTO archive_settings(user_id,enabled,version,connection_id,connection_generation,disclosure_version,accepted_at) VALUES(?,1,1,'drive',1,1,?)",
    )
    .bind(owner.userId, start)
    .run();
});
it("DRIVE-02: persists the chosen root ID before any create and completes only a live lease", async () => {
  const s = store();
  const plan = await s.getOrPlan(owner, auth, proposed);
  expect(plan.fileId).toBe(proposed.fileId);
  expect(
    await db
      .prepare("SELECT planned_file_id FROM archive_folders WHERE user_id=?")
      .bind(owner.userId)
      .first("planned_file_id"),
  ).toBe(proposed.fileId);
  const work = await s.claim(owner, auth);
  expect(work).not.toBeNull();
  if (!work) throw new Error("missing work");
  expect(await s.authorized(owner, work.lease)).toBe(true);
  expect(await s.complete(owner, work.lease)).toBe(true);
  expect(
    (
      await s.getOrPlan(owner, auth, {
        ...proposed,
        fileId: "unused-generated-id",
      })
    ).state,
  ).toBe("ready");
});

it("DRIVE-02: immutable identity survives retries and excludes foreign tenant consent", async () => {
  const s = store();
  await s.getOrPlan(owner, auth, proposed);
  expect(
    await s.getOrPlan(owner, auth, {
      ...proposed,
      fileId: "another-folder",
      workspaceMarker: "another-workspace-marker",
    }),
  ).toMatchObject(proposed);
  await expect(s.getOrPlan(foreign, auth, proposed)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  const work = await s.claim(owner, auth);
  if (!work) throw new Error("missing work");
  expect(await s.claim(owner, auth)).toBeNull();
  expect(await s.authorized(foreign, work.lease)).toBe(false);
  expect(await s.complete(foreign, work.lease)).toBe(false);
});
it("DRIVE-02: expiry and replacement lease fence stale completion", async () => {
  const s = store();
  await s.getOrPlan(owner, auth, proposed);
  const first = await s.claim(owner, auth);
  if (!first) throw new Error("missing work");
  now = first.lease.expiresAt;
  expect(await s.authorized(owner, first.lease)).toBe(false);
  expect(await s.complete(owner, first.lease)).toBe(false);
  const replacement = await s.claim(owner, auth);
  if (!replacement) throw new Error("missing replacement");
  expect(replacement.lease.fence).toBe(first.lease.fence + 1);
  expect(await s.complete(owner, first.lease)).toBe(false);
  expect(await s.complete(owner, replacement.lease)).toBe(true);
  expect(await s.claim(owner, auth)).toBeNull();
});
const revocations = [
  "UPDATE archive_settings SET enabled=0,connection_id=NULL,connection_generation=NULL,disclosure_version=NULL,accepted_at=NULL",
  "UPDATE archive_settings SET version=2",
  "UPDATE connections SET generation=2",
  "UPDATE connections SET provider_subject='different-subject'",
  "UPDATE connections SET credential_ciphertext=NULL,credential_key_version=NULL",
  "UPDATE connections SET state='disconnected'",
  "UPDATE connections SET scopes='[]'",
  "UPDATE connections SET scopes='{}'",
  "UPDATE profiles SET status='deleting'",
];
for (const sql of revocations)
  it(`DRIVE-02: revocation blocks planning and leased writes: ${sql}`, async () => {
    const s = store();
    await s.getOrPlan(owner, auth, proposed);
    const work = await s.claim(owner, auth);
    if (!work) throw new Error("missing work");
    await db.prepare(sql).run();
    expect(await s.authorized(owner, work.lease)).toBe(false);
    expect(await s.complete(owner, work.lease)).toBe(false);
    expect(await s.claim(owner, auth)).toBeNull();
    await expect(s.getOrPlan(owner, auth, proposed)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
it("DRIVE-02: rejects malformed identifiers and authorization before persistence", async () => {
  const s = store();
  await expect(
    s.getOrPlan(owner, auth, { ...proposed, fileId: "unsafe/id" }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    s.getOrPlan(owner, { ...auth, generation: 0 }, proposed),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS total FROM archive_folders")
      .first("total"),
  ).toBe(0);
});
