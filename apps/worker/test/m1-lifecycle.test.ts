import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { createArchiveFolderStore } from "../../../packages/adapters/src/drive/folders";
import { createFxValuationRepository } from "../../../packages/adapters/src/fx/repository";
import { createLifecycleCleanup } from "../../../packages/adapters/src/lifecycle/cleanup";
import { createInvocationDatabase } from "../src/invocation-database";
import { faultingDatabase } from "./support/faults";

const db = env.DB;

beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((s) => s.trim()))
      await db.prepare(statement).run();
});
beforeEach(async () => {
  await db.prepare("DELETE FROM lifecycle_deletions").run();
});
async function owner(id: string) {
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
    )
    .bind(id, "Synthetic", `${id}@example.invalid`)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind(id)
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES('target',?,'mailbox','microsoft','synthetic','synthetic@example.invalid','disconnected')",
    )
    .bind(id)
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('source',?,'target','synthetic',0,1)",
    )
    .bind(id)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('doc',?,'source','body','synthetic','text/plain',1)",
    )
    .bind(id)
    .run();
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('obs',?,'doc',0,'synthetic',1,'explicitly-paid',?,'accepted')",
    )
    .bind(id, JSON.stringify({ schemaVersion: 1 }))
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES('purchase',?,'Synthetic','synthetic','2026-10-11',15,'EUR','paid')",
    )
    .bind(id)
    .run();
  await db
    .prepare(
      "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,'purchase','obs','payment')",
    )
    .bind(id)
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,version) VALUES('entry',?,'purchase','obs','synthetic','payment',15,'EUR','2026-10-11','document-date',1,250)",
    )
    .bind(id)
    .run();
}
async function valuations(user: string, count: number, entry = "entry") {
  const policyKey = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify(["synthetic-reference", 2, "fx-v1"]),
        ),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  for (let version = 1; version <= count; version++)
    await db
      .prepare(
        "INSERT INTO entry_valuations(user_id,entry_id,reporting_currency,profile_version,entry_version,calculation_version,policy_hash,policy_source,max_prior_age_days,original_kind,original_minor,original_currency,original_event_date,status,signed_minor,basis,version,updated_at) VALUES(?,?,'EUR',1,?,'fx-v1',?,'synthetic-reference',2,'payment',15,'EUR','2026-10-11','converted','15','identity',1,0)",
      )
      .bind(user, entry, version, policyKey)
      .run();
}
async function mark(
  user: string,
  scope: "account" | "connection",
  stage: number,
  ack = 1,
) {
  if (scope === "account")
    await db
      .prepare("UPDATE profiles SET status='deleting' WHERE user_id=?")
      .bind(user)
      .run();
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,stage,journal_ack) VALUES(?,?,?,?,0,?,?)",
    )
    .bind(
      user,
      scope,
      scope === "account" ? "account" : "target",
      `request-${user}`,
      stage,
      ack,
    )
    .run();
}
async function count(table: string, user: string) {
  return db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id=?`)
    .bind(user)
    .first<number>("count");
}
it("M1 account mid-stage8 deletes at most100 historical valuations before ledger cascade", async () => {
  await owner("m1-account");
  await valuations("m1-account", 250);
  await mark("m1-account", "account", 8);
  const meter = createInvocationDatabase(env.DB, 5);
  expect(await createLifecycleCleanup(meter.db, null).runOne()).toEqual({
    status: "pending",
  });
  expect(await count("entry_valuations", "m1-account")).toBe(150);
  expect(await count("ledger_entries", "m1-account")).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT stage FROM lifecycle_deletions WHERE user_id='m1-account'",
      )
      .first("stage"),
  ).toBe(8);
  expect(meter.executedStatements()).toBeLessThanOrEqual(5);
});
async function outlookLeaves(
  user: string,
  rows: number,
  connection = "target",
) {
  for (let index = 0; index < rows; index++) {
    await db
      .prepare(
        "INSERT INTO outlook_folders(user_id,connection_id,generation,folder_id,child_folder_count,is_hidden) VALUES(?,?,1,?,0,0)",
      )
      .bind(user, connection, `folder-${index}`)
      .run();
    await db
      .prepare(
        "INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,version,state,commit_id) VALUES(?,?,1,?,1,'pending',?)",
      )
      .bind(user, connection, `scope-${index}`, "a".repeat(36))
      .run();
  }
}
async function unit() {
  const meter = createInvocationDatabase(env.DB, 5);
  const result = await createLifecycleCleanup(meter.db, null).runOne();
  expect(meter.executedStatements()).toBeLessThanOrEqual(5);
  return result;
}
it("M1 account journal gate precedes all new leaf deletion", async () => {
  await owner("m1-journal");
  await valuations("m1-journal", 120);
  await mark("m1-journal", "account", 8, 0);
  const waiting = createInvocationDatabase(env.DB, 5);
  expect(await createLifecycleCleanup(waiting.db, null).runOne()).toEqual({
    status: "awaiting_journal",
  });
  expect(waiting.executedStatements()).toBe(1);
  expect(await count("entry_valuations", "m1-journal")).toBe(120);
  let acknowledgements = 0;
  const journal = {
    append: async () => {
      acknowledgements++;
    },
  };
  expect(await createLifecycleCleanup(db, journal).runOne()).toEqual({
    status: "pending",
  });
  expect(acknowledgements).toBe(1);
  expect(await count("entry_valuations", "m1-journal")).toBe(120);
  expect(await unit()).toEqual({ status: "pending" });
  expect(await count("entry_valuations", "m1-journal")).toBe(20);
});
it("M1 resumed account drains all new leaf tables before old connection/user cut and preserves public rates and foreign tenant", async () => {
  await owner("m1-resumed");
  await valuations("m1-resumed", 125);
  await outlookLeaves("m1-resumed", 125);
  await mark("m1-resumed", "account", 25);
  await owner("m1-foreign");
  await valuations("m1-foreign", 3);
  await outlookLeaves("m1-foreign", 3);
  await db
    .prepare(
      "INSERT INTO fx_rates(id,source,from_currency,to_currency,requested_date,effective_date,rate,retrieved_at,source_version) VALUES(?,'synthetic-reference','EUR','USD','2026-10-11','2026-10-09','0.5',0,'v1') ON CONFLICT DO NOTHING",
    )
    .bind("b".repeat(64))
    .run();
  for (let step = 0; step < 6; step++) {
    expect(await unit()).toEqual({ status: "pending" });
    expect(
      await db
        .prepare(
          "SELECT stage FROM lifecycle_deletions WHERE user_id='m1-resumed'",
        )
        .first("stage"),
    ).toBe(25);
  }
  expect(await count("entry_valuations", "m1-resumed")).toBe(0);
  expect(await count("outlook_inventory_states", "m1-resumed")).toBe(0);
  expect(await count("outlook_folders", "m1-resumed")).toBe(0);
  expect(await count("entry_valuations", "m1-foreign")).toBe(3);
  expect(await count("outlook_inventory_states", "m1-foreign")).toBe(3);
  expect(await count("outlook_folders", "m1-foreign")).toBe(3);
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM fx_rates").first("count"),
  ).toBe(1);
});
it("M1 connection mid-stage6 removes only doomed/ineligible target valuations in100 rows perunit", async () => {
  await owner("m1-target");
  await valuations("m1-target", 250);
  await mark("m1-target", "connection", 6);
  await db
    .prepare("UPDATE ledger_entries SET eligible=0 WHERE user_id='m1-target'")
    .run();
  expect(await unit()).toEqual({ status: "pending" });
  expect(await count("entry_valuations", "m1-target")).toBe(150);
  expect(await count("ledger_entries", "m1-target")).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT stage FROM lifecycle_deletions WHERE user_id='m1-target'",
      )
      .first("stage"),
  ).toBe(6);
  expect(await unit()).toEqual({ status: "pending" });
  expect(await count("entry_valuations", "m1-target")).toBe(50);
  expect(await unit()).toEqual({ status: "pending" });
  expect(await count("entry_valuations", "m1-target")).toBe(0);
  expect(await unit()).toEqual({ status: "pending" });
  expect(
    await db
      .prepare(
        "SELECT stage FROM lifecycle_deletions WHERE user_id='m1-target'",
      )
      .first("stage"),
  ).toBe(7);
});
it("M1 connection caps Outlook leaf deletes before graph work and keeps other mailbox folders", async () => {
  await owner("m1-folders");
  await outlookLeaves("m1-folders", 150);
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address) VALUES('other','m1-folders','mailbox','microsoft','other-synthetic','other@example.invalid')",
    )
    .run();
  await outlookLeaves("m1-folders", 3, "other");
  await mark("m1-folders", "connection", 0);
  expect(await unit()).toEqual({ status: "pending" });
  expect(await count("outlook_inventory_states", "m1-folders")).toBe(53);
  expect(await count("outlook_folders", "m1-folders")).toBe(153);
  expect(
    await db
      .prepare(
        "SELECT stage FROM lifecycle_deletions WHERE user_id='m1-folders'",
      )
      .first("stage"),
  ).toBe(0);
  expect(await unit()).toEqual({ status: "pending" });
  expect(await count("outlook_inventory_states", "m1-folders")).toBe(3);
  expect(await unit()).toEqual({ status: "pending" });
  expect(await count("outlook_folders", "m1-folders")).toBe(53);
  expect(await unit()).toEqual({ status: "pending" });
  expect(await count("outlook_folders", "m1-folders")).toBe(3);
});
it("M1 source cleanup preserves reparented and user-owned ledger valuations and exact totals", async () => {
  const user = "m1-preserved";
  await owner(user);
  await valuations(user, 250);
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address) VALUES('other',?,'mailbox','gmail','other-synthetic','other@example.invalid')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('other-source',?,'other','other',0,1)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('other-doc',?,'other-source','body','synthetic','text/plain',1)",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES('other-obs',?,'other-doc',0,'other',1,'explicitly-paid',?,'accepted')",
    )
    .bind(user, JSON.stringify({ schemaVersion: 1 }))
    .run();
  await db
    .prepare(
      "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,'purchase','other-obs','payment')",
    )
    .bind(user)
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('user-entry',?,'purchase',NULL,'synthetic-user','payment',15,'EUR','2026-10-11','user-confirmed-date',1,'user-confirmed')",
    )
    .bind(user)
    .run();
  await valuations(user, 250, "user-entry");
  await mark(user, "connection", 0);
  let completed = false;
  for (let step = 0; step < 64; step++) {
    const outcome = await unit();
    if (outcome.status === "completed") {
      completed = true;
      break;
    }
  }
  expect(completed).toBe(true);
  expect(await count("entry_valuations", user)).toBe(500);
  const fx = createFxValuationRepository(db, {
    policy: { source: "synthetic-reference", maxPriorAgeDays: 2 },
  });
  const context = { userId: user, authority: "session" } as TenantContext;
  for (const entryId of ["entry", "user-entry"])
    expect(
      await fx.get(context, {
        entryId,
        expectedProfileVersion: 1,
        reportingCurrency: "EUR",
      }),
    ).toMatchObject({
      status: "valued",
      result: { status: "converted", signedMinor: "15" },
    });
  expect(
    await db
      .prepare(
        "SELECT observation_id FROM ledger_entries WHERE user_id=? AND id='entry'",
      )
      .bind(user)
      .first("observation_id"),
  ).toBe("other-obs");
  expect(
    await db
      .prepare(
        "SELECT CAST(SUM(amount_minor) AS TEXT) AS total FROM ledger_entries WHERE user_id=? AND eligible=1",
      )
      .bind(user)
      .first("total"),
  ).toBe("30");
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM source_messages WHERE user_id=? AND connection_id=?",
      )
      .bind(user, "target")
      .first("count"),
  ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM source_messages WHERE user_id=? AND connection_id=?",
      )
      .bind(user, "other")
      .first("count"),
  ).toBe(1);
});
function changingDatabase(change: () => Promise<unknown>, fail = false) {
  const meter = createInvocationDatabase(env.DB, 5);
  const { db: database } = faultingDatabase(meter.db, [
    {
      match: "DELETE FROM entry_valuations",
      on: "run",
      fire: async ({ proceed, native, statement }) => {
        await change();
        if (!fail) return proceed();
        if (!statement) throw new Error("MISSING_INTERCEPTED_STATEMENT");
        await native.batch([
          statement,
          native.prepare(
            "INSERT INTO fx_rates(id,source,from_currency,to_currency,requested_date,effective_date,rate,retrieved_at,source_version) VALUES('bad','synthetic','EUR','USD','2026-10-11','2026-10-09','1',0,'v1')",
          ),
        ]);
        throw new Error("UNREACHABLE");
      },
    },
  ]);
  return { database, meter };
}
it("M1 changed deletion request before leaf mutation cannot erase or advance legacy stage", async () => {
  await owner("m1-stale-request");
  await valuations("m1-stale-request", 120);
  await mark("m1-stale-request", "account", 8);
  const { database, meter } = changingDatabase(() =>
    db
      .prepare(
        "UPDATE lifecycle_deletions SET request_id='new-current-request' WHERE user_id='m1-stale-request'",
      )
      .run(),
  );
  const adopted = createInvocationDatabase(database, 5);
  expect(await createLifecycleCleanup(adopted.db, null).runOne()).toEqual({
    status: "pending",
  });
  expect(await count("entry_valuations", "m1-stale-request")).toBe(120);
  expect(await count("ledger_entries", "m1-stale-request")).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT stage FROM lifecycle_deletions WHERE user_id='m1-stale-request'",
      )
      .first("stage"),
  ).toBe(8);
  expect(meter.executedStatements()).toBe(4);
});
it("M1 real late driver batch failure rolls back bounded leaf mutation without parent prefix", async () => {
  await owner("m1-rollback");
  await valuations("m1-rollback", 120);
  await mark("m1-rollback", "account", 8);
  const { database } = changingDatabase(async () => undefined, true);
  await expect(createLifecycleCleanup(database, null).runOne()).rejects.toThrow(
    "M1_LEAF_CLEANUP_UNAVAILABLE",
  );
  expect(await count("entry_valuations", "m1-rollback")).toBe(120);
  expect(await count("ledger_entries", "m1-rollback")).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT stage FROM lifecycle_deletions WHERE user_id='m1-rollback'",
      )
      .first("stage"),
  ).toBe(8);
});
it("M1 recompute stage9 skips prepass and stays within old5query budget with new leaves present", async () => {
  await owner("m1-recompute");
  await outlookLeaves("m1-recompute", 1);
  await mark("m1-recompute", "connection", 9);
  expect(await unit()).toEqual({ status: "pending" });
  expect(await count("outlook_folders", "m1-recompute")).toBe(1);
  expect(await count("outlook_inventory_states", "m1-recompute")).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT stage FROM lifecycle_deletions WHERE user_id='m1-recompute'",
      )
      .first("stage"),
  ).toBe(10);
});
async function folderPlan(user: string) {
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,credential_ciphertext,credential_key_version,scopes) VALUES('drive',?,'storage','google-drive','synthetic-drive-subject','synthetic@example.invalid','synthetic-sealed',1,?)",
    )
    .bind(user, JSON.stringify(["https://www.googleapis.com/auth/drive.file"]))
    .run();
  await db
    .prepare(
      "INSERT INTO archive_settings(user_id,enabled,version,connection_id,connection_generation,disclosure_version,accepted_at) VALUES(?,1,1,'drive',1,1,0)",
    )
    .bind(user)
    .run();
  await createArchiveFolderStore(db).getOrPlan(
    { userId: user, authority: "job" } as TenantContext,
    { connectionId: "drive", settingsVersion: 1, generation: 1 },
    {
      fileId: "synthetic-root-folder",
      workspaceMarker: "synthetic-workspace-marker",
    },
  );
}
for (const scope of ["account", "connection"] as const)
  it(`M1 ${scope} erasure drains a real folder plan while preserving foreign metadata`, async () => {
    const user = `m1-folder-erasure-${scope}`,
      foreign = `m1-folder-foreign-${scope}`;
    await owner(user);
    await owner(foreign);
    await folderPlan(user);
    await folderPlan(foreign);
    if (scope === "account") await mark(user, scope, 0);
    else {
      await db
        .prepare(
          "UPDATE connections SET state='disconnected' WHERE user_id=? AND id='drive'",
        )
        .bind(user)
        .run();
      await db
        .prepare(
          "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,stage,journal_ack) VALUES(?,'connection','drive',?,0,0,1)",
        )
        .bind(user, `request-${user}`)
        .run();
    }
    let completed = false;
    for (let step = 0; step < 100; step++) {
      if ((await unit()).status === "completed") {
        completed = true;
        break;
      }
    }
    expect(completed).toBe(true);
    expect(await count("archive_folders", user)).toBe(0);
    expect(await count("archive_folders", foreign)).toBe(1);
    if (scope === "account")
      expect(
        await db.prepare('SELECT id FROM "user" WHERE id=?').bind(user).first(),
      ).toBeNull();
    else {
      await db
        .prepare("DELETE FROM connections WHERE user_id=? AND id='drive'")
        .bind(user)
        .run();
      expect(await count("connections", user)).toBe(1);
    }
  });
it("M1 folder metadata respects the journal and100row deletion cap", async () => {
  const user = "m1-folder-cap";
  await owner(user);
  await folderPlan(user);
  for (let index = 0; index < 104; index++) {
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address) VALUES(?,?,'storage','google-drive',?,'synthetic@example.invalid')",
      )
      .bind(`drive-${index}`, user, `synthetic-${index}`)
      .run();
    await db
      .prepare(
        "INSERT INTO archive_folders(user_id,connection_id,storage_subject,planned_file_id,workspace_marker) VALUES(?,?,?,?,?)",
      )
      .bind(
        user,
        `drive-${index}`,
        `synthetic-${index}`,
        `synthetic-folder-${index}`,
        "synthetic-workspace-marker",
      )
      .run();
  }
  await mark(user, "account", 25, 0);
  expect(await unit()).toEqual({ status: "awaiting_journal" });
  expect(await count("archive_folders", user)).toBe(105);
  await db
    .prepare("UPDATE lifecycle_deletions SET journal_ack=1 WHERE user_id=?")
    .bind(user)
    .run();
  expect(await unit()).toEqual({ status: "pending" });
  expect(await count("archive_folders", user)).toBe(5);
  expect(await count("connections", user)).toBe(106);
  expect(
    await db
      .prepare("SELECT stage FROM lifecycle_deletions WHERE user_id=?")
      .bind(user)
      .first("stage"),
  ).toBe(25);
});
it("M1 legitimate pre-schema cleanup continues unchanged without fixture rewrites", async () => {
  await db.prepare("DROP TABLE entry_valuations").run();
  await db.prepare("DROP TABLE outlook_inventory_states").run();
  await db.prepare("DROP TABLE outlook_folders").run();
  await owner("m1-legacy");
  await mark("m1-legacy", "account", 8);
  expect(await unit()).toEqual({ status: "pending" });
  expect(await count("ledger_entries", "m1-legacy")).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT stage FROM lifecycle_deletions WHERE user_id='m1-legacy'",
      )
      .first("stage"),
  ).toBe(9);
});
