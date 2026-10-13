import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import backfill from "../../../packages/adapters/migrations/0006_archive_dispatch_backfill.sql?raw";
import ordering from "../../../packages/adapters/migrations/0007_archive_document_order.sql?raw";

const db = env.DB;
async function run(sql: string, ...values: unknown[]) {
  return db
    .prepare(sql)
    .bind(...values)
    .run();
}
async function applyOrdering() {
  // Preserve complete trigger bodies and the actual migration statement order.
  let statement = "";
  for (const line of ordering.replace(/^--.*$/gm, "").split("\n")) {
    statement += `${line}\n`;
    if (!line.trimEnd().endsWith(";")) continue;
    if (
      statement.trimStart().startsWith("CREATE TRIGGER") &&
      line.trim() !== "END;"
    )
      continue;
    await run(statement);
    statement = "";
  }
  expect(statement.trim()).toBe("");
}
beforeAll(async () => {
  for (const sql of baseline.split(";").filter((value) => value.trim()))
    await run(sql);
});
beforeEach(async () => {
  // This runtime retains D1 state between cases. Rebuild only this fixture's
  // local archive schema, leaving each case at the actual pre-0007 boundary.
  await run("DROP TRIGGER IF EXISTS archive_document_order_insert");
  for (const table of [
    "archive_dispatch",
    "archive_backfill_items",
    "archive_backfill_runs",
    "archive_document_order",
  ])
    await run(`DROP TABLE IF EXISTS ${table}`);
  await run(
    "DELETE FROM \"user\" WHERE id IN ('clean-owner','upgrade-owner','order-a','order-b','poison-owner','sequence-owner')",
  );
  for (const sql of backfill.split(";").filter((value) => value.trim()))
    await run(sql);
});
async function owner(id: string) {
  await run(
    "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Synthetic',?,1,0,0)",
    id,
    `${id}@example.invalid`,
  );
  await run(
    "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    id,
  );
  for (const [connection, kind, provider] of [
    ["mail", "mailbox", "gmail"],
    ["drive", "storage", "google-drive"],
  ])
    await run(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address) VALUES(?,?,?,?,?,'synthetic@example.invalid')",
      connection,
      id,
      kind,
      provider,
      id + connection,
    );
  await run(
    "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('source',?,'mail','synthetic',0,1)",
    id,
  );
}
async function document(user: string, id: string) {
  await run(
    "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES(?,?,'source',?,'synthetic-hash','text/plain',3) ON CONFLICT(user_id,id) DO UPDATE SET byte_length=excluded.byte_length",
    id,
    user,
    id,
  );
}
async function sequence(user: string, id: string): Promise<number> {
  const value = await db
    .prepare(
      "SELECT sequence FROM archive_document_order WHERE user_id=? AND document_id=?",
    )
    .bind(user, id)
    .first<number>("sequence");
  if (value === null) throw new Error("MISSING_SYNTHETIC_DOCUMENT_ORDER");
  return value;
}
async function legacyRun(user: string) {
  await run(
    "INSERT INTO archive_backfill_runs(user_id,id,connection_id,storage_generation,storage_subject,settings_version,created_at,snapshot_count,has_more) VALUES(?,'legacy-run','drive',1,'synthetic-drive',1,0,1,1)",
    user,
  );
}

it("DRIVE-05 clean installation assigns monotonic order, stable upserts and a new order after delete/reinsert", async () => {
  await applyOrdering();
  await owner("clean-owner");
  await document("clean-owner", "a");
  const first = await sequence("clean-owner", "a");
  await document("clean-owner", "b");
  const second = await sequence("clean-owner", "b");
  expect(first).toBeGreaterThan(0);
  expect(second).toBeGreaterThan(first);
  await document("clean-owner", "a");
  expect(await sequence("clean-owner", "a")).toBe(first);
  await run("DELETE FROM documents WHERE user_id='clean-owner' AND id='b'");
  expect(
    await db
      .prepare(
        "SELECT sequence FROM archive_document_order WHERE user_id='clean-owner' AND document_id='b'",
      )
      .first(),
  ).toBeNull();
  await document("clean-owner", "b");
  expect(await sequence("clean-owner", "b")).toBeGreaterThan(second);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

it("DRIVE-05 populated 0006 upgrade catalogs every existing document without expanding legacy approval", async () => {
  await owner("upgrade-owner");
  await document("upgrade-owner", "old-b");
  await document("upgrade-owner", "old-a");
  await legacyRun("upgrade-owner");
  await run(
    "INSERT INTO archive_backfill_items(user_id,run_id,ordinal,document_id) VALUES('upgrade-owner','legacy-run',1,'old-a')",
  );
  await applyOrdering();
  const cutoff = await sequence("upgrade-owner", "old-b");
  expect(await sequence("upgrade-owner", "old-a")).toBeLessThan(cutoff);
  expect(
    (
      await db
        .prepare(
          "SELECT document_id FROM archive_document_order WHERE user_id='upgrade-owner' ORDER BY sequence",
        )
        .all()
    ).results,
  ).toEqual([{ document_id: "old-a" }, { document_id: "old-b" }]);
  expect(
    await db
      .prepare(
        "SELECT snapshot_sequence,enumerated_through_sequence,processed_count,snapshot_count,has_more,cursor_ordinal,state FROM archive_backfill_runs WHERE user_id='upgrade-owner'",
      )
      .first(),
  ).toEqual({
    snapshot_sequence: null,
    enumerated_through_sequence: 0,
    processed_count: 0,
    snapshot_count: 1,
    has_more: 1,
    cursor_ordinal: 0,
    state: "pending",
  });
  expect(
    (
      await db
        .prepare(
          "SELECT ordinal,document_id FROM archive_backfill_items WHERE user_id='upgrade-owner'",
        )
        .all()
    ).results,
  ).toEqual([{ ordinal: 1, document_id: "old-a" }]);
  await document("upgrade-owner", "later");
  expect(await sequence("upgrade-owner", "later")).toBeGreaterThan(cutoff);
  expect(
    await db
      .prepare(
        "SELECT snapshot_sequence FROM archive_backfill_runs WHERE user_id='upgrade-owner'",
      )
      .first("snapshot_sequence"),
  ).toBeNull();
});

it("DRIVE-05 catalogue ownership uses the document's composite tenant foreign key", async () => {
  await applyOrdering();
  await owner("order-a");
  await owner("order-b");
  await document("order-a", "only-a");
  await expect(
    run(
      "INSERT INTO archive_document_order(user_id,document_id) VALUES('order-b','only-a')",
    ),
  ).rejects.toThrow();
  await expect(
    run(
      "UPDATE archive_document_order SET user_id='order-b' WHERE user_id='order-a' AND document_id='only-a'",
    ),
  ).rejects.toThrow();
  expect(await sequence("order-a", "only-a")).toBeGreaterThan(0);
  expect(
    await db
      .prepare(
        "SELECT sequence FROM archive_document_order WHERE user_id='order-b'",
      )
      .first(),
  ).toBeNull();
});

it.each([
  ["snapshot_sequence", -1],
  ["snapshot_sequence", 1.5],
  ["snapshot_sequence", "poison"],
  ["snapshot_sequence", 9007199254740992],
  ["enumerated_through_sequence", -1],
  ["enumerated_through_sequence", 1.5],
  ["enumerated_through_sequence", "poison"],
  ["enumerated_through_sequence", 6],
  ["processed_count", -1],
  ["processed_count", 1.5],
  ["processed_count", "poison"],
  ["processed_count", 9007199254740992],
])(
  "DRIVE-05 poisoned %s=%s rolls back the entire native batch",
  async (column, value) => {
    await applyOrdering();
    await owner("poison-owner");
    await legacyRun("poison-owner");
    await run(
      "UPDATE archive_backfill_runs SET snapshot_sequence=5 WHERE user_id='poison-owner'",
    );
    await expect(
      db.batch([
        db.prepare(
          "UPDATE archive_backfill_runs SET processed_count=1 WHERE user_id='poison-owner'",
        ),
        db
          .prepare(
            `UPDATE archive_backfill_runs SET ${column}=? WHERE user_id='poison-owner'`,
          )
          .bind(value),
      ]),
    ).rejects.toThrow();
    expect(
      await db
        .prepare(
          "SELECT snapshot_sequence,enumerated_through_sequence,processed_count FROM archive_backfill_runs WHERE user_id='poison-owner'",
        )
        .first(),
    ).toEqual({
      snapshot_sequence: 5,
      enumerated_through_sequence: 0,
      processed_count: 0,
    });
  },
);

it.each([0, -1, 1.5, 9007199254740992])(
  "DRIVE-05 invalid catalogue sequence %s rolls back a preceding run mutation",
  async (invalidSequence) => {
    await applyOrdering();
    await owner("sequence-owner");
    await document("sequence-owner", "document");
    await legacyRun("sequence-owner");
    const original = await sequence("sequence-owner", "document");
    await expect(
      db.batch([
        db.prepare(
          "UPDATE archive_backfill_runs SET processed_count=1 WHERE user_id='sequence-owner'",
        ),
        db
          .prepare(
            "UPDATE archive_document_order SET sequence=? WHERE user_id='sequence-owner'",
          )
          .bind(invalidSequence),
      ]),
    ).rejects.toThrow();
    expect(await sequence("sequence-owner", "document")).toBe(original);
    expect(
      await db
        .prepare(
          "SELECT processed_count FROM archive_backfill_runs WHERE user_id='sequence-owner'",
        )
        .first("processed_count"),
    ).toBe(0);
  },
);
