import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { cleanupM1Leaves } from "../../../packages/adapters/src/lifecycle/m1-leaf-cleanup";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;

beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
});
async function seed(user: string, scope: "account" | "connection") {
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
    )
    .bind(user, "Synthetic", `${user}@example.test`)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,status,created_at,updated_at) VALUES(?,?,0,0)",
    )
    .bind(user, scope === "account" ? "deleting" : "active")
    .run();
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,stage,journal_ack) VALUES(?,?,?,?,0,8,1)",
    )
    .bind(
      user,
      scope,
      scope === "account" ? "account" : "target",
      `request-${user}`,
    )
    .run();
  return {
    user_id: user,
    scope,
    target_id: scope === "account" ? "account" : "target",
    request_id: `request-${user}`,
    stage: 8,
    deleted_at: 0,
  } as const;
}
async function connection(user: string, id: string) {
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state) VALUES(?,?,'storage','google-drive',?,'synthetic@example.test','disconnected')",
    )
    .bind(id, user, id)
    .run();
}
it("storage connection erasure clears destination while preserving the consent revision against ABA", async () => {
  const item = await seed("drive-leaf-connection", "connection");
  await connection(item.user_id, "target");
  await db
    .prepare(
      "INSERT INTO archive_settings(user_id,enabled,version,connection_id,connection_generation,disclosure_version,accepted_at) VALUES(?,1,7,'target',1,1,0)",
    )
    .bind(item.user_id)
    .run();
  const invocation = createInvocationDatabase(env.DB, 5);
  expect(await cleanupM1Leaves(invocation.db, item)).toBe(true);
  expect(
    await db
      .prepare(
        "SELECT enabled,version,connection_id FROM archive_settings WHERE user_id=?",
      )
      .bind(item.user_id)
      .first(),
  ).toEqual({ enabled: 0, version: 8, connection_id: null });
  await db
    .prepare("DELETE FROM connections WHERE user_id=? AND id='target'")
    .bind(item.user_id)
    .run();
});
it("account erasure drains at most100 storage refresh leases before parent cascades", async () => {
  const item = await seed("drive-leaf-account", "account");
  for (let index = 0; index < 250; index++) {
    const id = `synthetic-${index}`;
    await connection(item.user_id, id);
    await db
      .prepare(
        "INSERT INTO storage_refresh_leases(user_id,connection_id,lease_id,lease_expires_at,connection_generation,credential_version,fence) VALUES(?,?,NULL,0,1,0,1)",
      )
      .bind(item.user_id, id)
      .run();
  }
  expect(
    await cleanupM1Leaves(createInvocationDatabase(env.DB, 5).db, item),
  ).toBe(true);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM storage_refresh_leases WHERE user_id=?",
      )
      .bind(item.user_id)
      .first<number>("count"),
  ).toBe(150);
});
