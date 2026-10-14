// Explicit populated historical-upgrade fixture; old SQL is never an active deployment migration.

import { env } from "cloudflare:workers";
import type { MailboxSession, TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { createArchiveConsentRepository } from "../../../packages/adapters/src/drive/archive-consent";
import { createInvocationDatabase } from "../src/invocation-database";
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
import { faultingDatabase } from "./support/faults";

const db = env.DB;

const now = Date.UTC(2026, 9, 13, 12);
const context = {
  userId: "drive-consent-owner",
  authority: "session",
} as TenantContext;
const session: MailboxSession = {
  tenant: context,
  sessionId: "drive-consent-session",
  createdAtMs: now,
};
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
  ])
    for (const statement of sql.split(";").filter((s) => s.trim()))
      await db.prepare(statement).run();
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)',
    )
    .bind(context.userId, "Synthetic", "consent@example.invalid", now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
    )
    .bind(context.userId, now, now)
    .run();
  await db
    .prepare(
      'INSERT INTO "session"(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)',
    )
    .bind(
      session.sessionId,
      now + 3600000,
      "synthetic-session-token",
      now,
      now,
      context.userId,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,credential_ciphertext,credential_key_version,scopes) VALUES('drive',?,'storage','google-drive','synthetic','synthetic@example.invalid','synthetic-sealed-credential',1,?)",
    )
    .bind(
      context.userId,
      JSON.stringify(["https://www.googleapis.com/auth/drive.file"]),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,credential_ciphertext,credential_key_version,scopes) VALUES('drive-other',?,'storage','google-drive','synthetic-other','other@example.invalid','synthetic-other-sealed',1,?)",
    )
    .bind(
      context.userId,
      JSON.stringify(["https://www.googleapis.com/auth/drive.file"]),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes) VALUES('mail',?,'mailbox','gmail','synthetic-mail','mail@example.invalid',?)",
    )
    .bind(
      context.userId,
      JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
    )
    .run();
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)',
    )
    .bind(
      "drive-consent-foreign",
      "Synthetic",
      "foreign-consent@example.invalid",
      now,
      now,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
    )
    .bind("drive-consent-foreign", now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,credential_ciphertext,credential_key_version,scopes) VALUES('foreign-only','drive-consent-foreign','storage','google-drive','synthetic','foreign@example.invalid','synthetic-foreign-sealed',1,?)",
    )
    .bind(JSON.stringify(["https://www.googleapis.com/auth/drive.file"]))
    .run();
  for (const statement of m17
    .split(";")
    .filter((statement) => statement.trim()))
    await db.prepare(statement).run();
});
beforeEach(async () => {
  await db.prepare("DELETE FROM archive_settings").run();
  await db.prepare("UPDATE profiles SET status='active'").run();
  await db
    .prepare('UPDATE "session" SET createdAt=?,expiresAt=? WHERE id=?')
    .bind(now, now + 3600000, session.sessionId)
    .run();
  await db
    .prepare(
      "UPDATE connections SET state='connected',generation=1,credential_ciphertext='synthetic-sealed-credential',credential_key_version=1,scopes=? WHERE user_id=? AND kind='storage'",
    )
    .bind(
      JSON.stringify(["https://www.googleapis.com/auth/drive.file"]),
      context.userId,
    )
    .run();
});
it("ARCH-01: storage grant alone stays disabled, explicit recent consent selects owned destination", async () => {
  const repository = createArchiveConsentRepository(db, {
    clock: () => now,
  });
  expect(await repository.read(context)).toEqual({
    enabled: false,
    version: 0,
    connectionId: null,
    generation: null,
    disclosureVersion: null,
    acceptedAt: null,
  });
  expect(
    await repository.enable(session, {
      expectedVersion: 0,
      connectionId: "drive",
      expectedGeneration: 1,
      disclosureVersion: 1,
    }),
  ).toEqual({
    enabled: true,
    version: 1,
    connectionId: "drive",
    generation: 1,
    disclosureVersion: 1,
    acceptedAt: now,
  });
});

it("ARCH-01: explicit destination switching and disabling require current CAS and canonical null metadata", async () => {
  const guarded = createInvocationDatabase(env.DB, 40);
  const repository = createArchiveConsentRepository(guarded.db, {
    clock: () => now,
  });
  const enabled = await repository.enable(session, {
    expectedVersion: 0,
    connectionId: "drive",
    expectedGeneration: 1,
    disclosureVersion: 1,
  });
  expect(enabled.version).toBe(1);
  await expect(
    repository.enable(session, {
      expectedVersion: 0,
      connectionId: "drive-other",
      expectedGeneration: 1,
      disclosureVersion: 1,
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(
    await repository.enable(session, {
      expectedVersion: 1,
      connectionId: "drive-other",
      expectedGeneration: 1,
      disclosureVersion: 1,
    }),
  ).toMatchObject({ version: 2, enabled: true, connectionId: "drive-other" });
  expect(await repository.disable(session, { expectedVersion: 2 })).toEqual({
    version: 3,
    enabled: false,
    connectionId: null,
    generation: null,
    disclosureVersion: null,
    acceptedAt: null,
  });
  expect(
    await db
      .prepare(
        "SELECT enabled,connection_id,connection_generation,disclosure_version,accepted_at FROM archive_settings WHERE user_id=?",
      )
      .bind(context.userId)
      .first(),
  ).toEqual({
    enabled: 0,
    connection_id: null,
    connection_generation: null,
    disclosure_version: null,
    accepted_at: null,
  });
  await expect(
    repository.enable(session, {
      expectedVersion: 2,
      connectionId: "drive",
      expectedGeneration: 1,
      disclosureVersion: 1,
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(guarded.executedStatements()).toBeLessThanOrEqual(40);
});
it("ARCH-01: disable before any enable creates a CAS barrier against stale first enable", async () => {
  const repository = createArchiveConsentRepository(db, {
    clock: () => now,
  });
  expect(
    await repository.disable(session, { expectedVersion: 0 }),
  ).toMatchObject({ enabled: false, version: 1 });
  await expect(
    repository.enable(session, {
      expectedVersion: 0,
      connectionId: "drive",
      expectedGeneration: 1,
      disclosureVersion: 1,
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});
it("ARCH-01: database session recency defeats forged caller timestamp and keeps exact one-hour policy", async () => {
  const repository = createArchiveConsentRepository(db, {
    clock: () => now,
  });
  await db
    .prepare('UPDATE "session" SET createdAt=? WHERE id=?')
    .bind(now - 3600001, session.sessionId)
    .run();
  await expect(
    repository.enable(
      { ...session, createdAtMs: now },
      {
        expectedVersion: 0,
        connectionId: "drive",
        expectedGeneration: 1,
        disclosureVersion: 1,
      },
    ),
  ).rejects.toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM archive_settings")
      .first("count"),
  ).toBe(0);
  await db
    .prepare('UPDATE "session" SET createdAt=? WHERE id=?')
    .bind(now - 3600000, session.sessionId)
    .run();
  expect(
    await repository.enable(
      { ...session, createdAtMs: now },
      {
        expectedVersion: 0,
        connectionId: "drive",
        expectedGeneration: 1,
        disclosureVersion: 1,
      },
    ),
  ).toMatchObject({ enabled: true, version: 1 });
});
it("ARCH-01: expired, foreign and deleting sessions cannot enable or disable another workspace", async () => {
  const repository = createArchiveConsentRepository(db, {
    clock: () => now,
  });
  const input = {
    expectedVersion: 0,
    connectionId: "drive",
    expectedGeneration: 1,
    disclosureVersion: 1 as const,
  };
  await expect(
    repository.enable(
      {
        ...session,
        tenant: {
          userId: "drive-consent-foreign",
          authority: "session",
        } as TenantContext,
      },
      input,
    ),
  ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  await db
    .prepare('UPDATE "session" SET expiresAt=? WHERE id=?')
    .bind(now, session.sessionId)
    .run();
  await expect(repository.enable(session, input)).rejects.toMatchObject({
    code: "UNAUTHENTICATED",
  });
  await db
    .prepare('UPDATE "session" SET expiresAt=? WHERE id=?')
    .bind(now + 3600000, session.sessionId)
    .run();
  await db
    .prepare("UPDATE profiles SET status='deleting' WHERE user_id=?")
    .bind(context.userId)
    .run();
  await expect(
    repository.disable(session, { expectedVersion: 0 }),
  ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM archive_settings")
      .first("count"),
  ).toBe(0);
});
it.each(["foreign-only", "mail"])(
  "ARCH-01: cannot select wrong-tenant or mailbox destination %s",
  async (connectionId) => {
    await expect(
      createArchiveConsentRepository(db, { clock: () => now }).enable(session, {
        expectedVersion: 0,
        connectionId,
        expectedGeneration: 1,
        disclosureVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM archive_settings")
        .first("count"),
    ).toBe(0);
  },
);
it.each([
  "generation=2",
  "state='disconnected'",
  "credential_ciphertext=NULL,credential_key_version=NULL",
  "scopes='[\"https://www.googleapis.com/auth/drive.readonly\"]'",
  "scopes='{}'",
  "scopes='not-json'",
])(
  "ARCH-01: destination state/gen/credentials/exact drive.file guard rejects %s",
  async (assignment) => {
    await db
      .prepare(
        `UPDATE connections SET ${assignment} WHERE user_id=? AND id='drive'`,
      )
      .bind(context.userId)
      .run();
    await expect(
      createArchiveConsentRepository(db, { clock: () => now }).enable(session, {
        expectedVersion: 0,
        connectionId: "drive",
        expectedGeneration: 1,
        disclosureVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM archive_settings")
        .first("count"),
    ).toBe(0);
  },
);
it("ARCH-01: concurrent first enable is one atomic winner without implicit destination selection", async () => {
  const repository = createArchiveConsentRepository(db, {
    clock: () => now,
  });
  const results = await Promise.allSettled(
    ["drive", "drive-other"].map((connectionId) =>
      repository.enable(session, {
        expectedVersion: 0,
        connectionId,
        expectedGeneration: 1,
        disclosureVersion: 1,
      }),
    ),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM archive_settings")
      .first("count"),
  ).toBe(1);
  expect((await repository.read(context)).version).toBe(1);
});
function changedSessionDatabase(): D1Database {
  return faultingDatabase(db, [
    {
      match: "INSERT INTO archive_settings",
      on: "run",
      fire: async ({ proceed, native }) => {
        await native
          .prepare('UPDATE "session" SET expiresAt=0 WHERE id=?')
          .bind(session.sessionId)
          .run();
        return proceed();
      },
    },
  ]).db;
}
it("ARCH-01: expired session between checks and actual CAS cannot leave consent prefix", async () => {
  await expect(
    createArchiveConsentRepository(changedSessionDatabase(), {
      clock: () => now,
    }).enable(session, {
      expectedVersion: 0,
      connectionId: "drive",
      expectedGeneration: 1,
      disclosureVersion: 1,
    }),
  ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM archive_settings")
      .first("count"),
  ).toBe(0);
});
it("ARCH-01: migration rejects cross-owner intents/leases/settings and nullable enabled loopholes", async () => {
  const stateHash = "c".repeat(64);
  await db
    .prepare(
      "INSERT INTO oauth_states(state_hash,user_id,session_id,purpose,provider,callback,pkce_ciphertext,pkce_key_version,nonce,created_at,expires_at) VALUES(?,?,?,'storage','google','https://example.invalid/api/oauth/storage/google-drive/callback','synthetic-pkce-sealed',1,'synthetic-nonce',?,?)",
    )
    .bind(stateHash, context.userId, session.sessionId, now, now + 600000)
    .run();
  await expect(
    db
      .prepare(
        "INSERT INTO storage_oauth_intents(user_id,state_hash,archive_settings_version) VALUES(?,?,0)",
      )
      .bind("drive-consent-foreign", stateHash)
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "INSERT INTO storage_oauth_intents(user_id,state_hash,connection_id,connection_generation,credential_version,archive_settings_version) VALUES(?,?,'foreign-only',1,0,0)",
      )
      .bind(context.userId, stateHash)
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "INSERT INTO storage_oauth_intents(user_id,state_hash,connection_id,connection_generation,archive_settings_version) VALUES(?,?,'drive',1,0)",
      )
      .bind(context.userId, stateHash)
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "INSERT INTO storage_refresh_leases(user_id,connection_id,connection_generation,credential_version,fence) VALUES(?,'foreign-only',1,0,1)",
      )
      .bind(context.userId)
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "INSERT INTO archive_settings(user_id,enabled,connection_id,connection_generation,disclosure_version,accepted_at) VALUES(?,1,'foreign-only',1,1,?)",
      )
      .bind(context.userId, now)
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "INSERT INTO archive_settings(user_id,enabled,connection_id,disclosure_version,accepted_at) VALUES(?,1,'drive',1,?)",
      )
      .bind(context.userId, now)
      .run(),
  ).rejects.toThrow();
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
it("ARCH-01: grant and archive consent do not change mailbox state or existing financial records", async () => {
  const mailbox = await db
    .prepare(
      "SELECT kind,provider,state,generation,scopes FROM connections WHERE user_id=? AND id='mail'",
    )
    .bind(context.userId)
    .first();
  const repository = createArchiveConsentRepository(db, {
    clock: () => now,
  });
  await repository.enable(session, {
    expectedVersion: 0,
    connectionId: "drive",
    expectedGeneration: 1,
    disclosureVersion: 1,
  });
  await repository.disable(session, { expectedVersion: 1 });
  expect(
    await db
      .prepare(
        "SELECT kind,provider,state,generation,scopes FROM connections WHERE user_id=? AND id='mail'",
      )
      .bind(context.userId)
      .first(),
  ).toEqual(mailbox);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM ledger_entries")
      .first("count"),
  ).toBe(0);
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jobs").first("count"),
  ).toBe(0);
});
it("ARCH-01: safe errors never project raw driver detail or credential fields", async () => {
  const database = {
    prepare() {
      throw new Error("synthetic-sensitive-credential-driver-detail");
    },
  } as unknown as D1Database;
  await expect(
    createArchiveConsentRepository(database).read(context),
  ).rejects.toMatchObject({ code: "UNAVAILABLE", message: "UNAVAILABLE" });
  const repository = createArchiveConsentRepository(db, {
    clock: () => now,
  });
  const view = await repository.read(context);
  expect(Object.keys(view).sort()).toEqual([
    "acceptedAt",
    "connectionId",
    "disclosureVersion",
    "enabled",
    "generation",
    "version",
  ]);
});
