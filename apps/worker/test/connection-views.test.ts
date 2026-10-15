import { env } from "cloudflare:workers";
import { createConnectionsViewRepository } from "@invoxim/adapters";
import { beforeAll, expect, it } from "vitest";
import { useCurrentSchema } from "./support/db";
import { faultingDatabase } from "./support/faults";
import { seedTenant } from "./support/tenant";

const probe = "SELECT name FROM sqlite_schema";

beforeAll(async () => {
  await useCurrentSchema(env.DB);
});

async function seedDrive(userId: string) {
  const seeded = await seedTenant(env.DB, { userId });
  const connectionId = `drive-${userId}`;
  await env.DB.prepare(
    "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state,scopes,credential_ciphertext,credential_key_version,credential_version) VALUES(?,?,'storage','google-drive',?,'drive@example.invalid','connected','[]','synthetic-encrypted-token',1,1)",
  )
    .bind(connectionId, userId, connectionId)
    .run();
  await env.DB.prepare(
    "INSERT INTO archive_settings(user_id,enabled,connection_id,connection_generation,disclosure_version,accepted_at) VALUES(?,1,?,1,1,0)",
  )
    .bind(userId, connectionId)
    .run();
  return seeded.tenant;
}

it("S11 a transient schema-probe failure is not cached for the database handle", async () => {
  const tenant = await seedDrive("connection-views-transient");
  const { db } = faultingDatabase(env.DB, [
    {
      match: probe,
      on: "first",
      fire: () => Promise.reject(new Error("D1_ERROR: synthetic transient")),
    },
  ]);
  const views = createConnectionsViewRepository(db);
  await expect(views.list(tenant)).rejects.toThrow("synthetic transient");
  const recovered = await views.list(tenant);
  expect(recovered.connections).toHaveLength(1);
  expect(recovered.connections[0]).toMatchObject({
    kind: "storage",
    archivingEnabled: true,
  });
});

it("S11 a missing archive_settings table is re-probed so a later migration is observed", async () => {
  const tenant = await seedDrive("connection-views-negative");
  const { db } = faultingDatabase(env.DB, [
    // First probe reports the table as absent (pre-migration handle).
    { match: probe, on: "first", fire: () => Promise.resolve(null) },
  ]);
  const views = createConnectionsViewRepository(db);
  expect((await views.list(tenant)).connections[0]).toMatchObject({
    archivingEnabled: false,
  });
  expect((await views.list(tenant)).connections[0]).toMatchObject({
    archivingEnabled: true,
  });
});

it("S11 a present archive_settings table is probed once per database handle", async () => {
  const tenant = await seedDrive("connection-views-positive");
  const { db, fireCounts } = faultingDatabase(env.DB, [
    {
      match: probe,
      on: "first",
      once: false,
      fire: ({ proceed }) => proceed(),
    },
  ]);
  const views = createConnectionsViewRepository(db);
  await views.list(tenant);
  await views.list(tenant);
  await createConnectionsViewRepository(db).list(tenant);
  expect(fireCounts[0]).toBe(1);
});
