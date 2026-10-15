import { env } from "cloudflare:workers";
import type { JobLease, JobPolicy } from "@invoxim/core";
import { DiscoveryError } from "@invoxim/core";
import { afterEach, beforeAll, expect, it } from "vitest";
import folderExclusionsMigration from "../../../packages/adapters/migrations/0004_outlook_folder_exclusions.sql?raw";
import {
  createOutlookFolderStore,
  type OutlookInventoryPage,
} from "../../../packages/adapters/src/discovery/outlook-state";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { OUTLOOK_AUTHORIZATION_SCOPES } from "../../../packages/adapters/src/mailbox/outlook-configuration";
import { createInvocationDatabase } from "../src/invocation-database";
import { installOnboardingQaHooks, owner } from "./onboarding-qa-fixture";
import { seedReviewedConsent } from "./outlook-consent-fixture";
import { faultingDatabase } from "./support/faults";

installOnboardingQaHooks();

const fixtureDatabase = env.DB;
const db = fixtureDatabase;

beforeAll(async () => {
  await db.prepare(folderExclusionsMigration).run();
});

const policy: JobPolicy = {
  dispatchLimit: 1,
  scheduleLimit: 1,
  tenantConcurrency: 2,
  globalConcurrency: 20,
  maxAttempts: 3,
  leaseMs: 300000,
  redeliveryMs: 1000,
  queryLimit: 40,
};
afterEach(async () => {
  await db.prepare("DROP TRIGGER IF EXISTS qa_folder_abort").run();
  await db
    .prepare(
      "UPDATE jobs SET status='completed',lease_id=NULL,lease_expires_at=NULL WHERE user_id LIKE 'qa-outlook-inventory-%' AND status='leased'",
    )
    .run();
});
async function claimed(name: string) {
  const current = await owner(name, "inventory-mailbox", [
    ...OUTLOOK_AUTHORIZATION_SCOPES,
  ]);
  await db
    .prepare(
      "UPDATE connections SET provider='outlook',scheduling_state='active',next_sync_at=NULL WHERE user_id=? AND id='inventory-mailbox'",
    )
    .bind(current.tenant.userId)
    .run();
  const consentId = `pc-${name}`,
    jobId = `j-${name}`;
  await seedReviewedConsent(db, {
    userId: current.tenant.userId,
    consentId,
    connectionId: "inventory-mailbox",
  });
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES(?,?,'inventory-mailbox',?,1,'mailbox-backfill',?,'ready',0)",
    )
    .bind(jobId, current.tenant.userId, consentId, jobId)
    .run();
  const meter = createInvocationDatabase(env.DB, 40);
  const lease = await createJobStore(meter.db, { policy }).claim(jobId);
  if (!lease)
    throw new Error(
      "Positive Outlook inventory fixture must obtain an actual native JobStore lease",
    );
  expect(lease.context.userId).toBe(current.tenant.userId);
  expect(lease.connectionId).toBe("inventory-mailbox");
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  return { lease, meter, store: createOutlookFolderStore(meter.db) };
}
function invocation() {
  const meter = createInvocationDatabase(env.DB, 40);
  return { meter, store: createOutlookFolderStore(meter.db) };
}
function page(id = "safe-folder"): OutlookInventoryPage {
  return {
    parentFolderId: null,
    expectedVersion: 0,
    folders: [
      {
        id,
        parentFolderId: "actual-provider-root",
        childFolderCount: 0,
        isHidden: false,
      },
    ],
    nextLink: null,
  };
}
async function snapshot(lease: JobLease) {
  const folders = await db
    .prepare(
      "SELECT * FROM outlook_folders WHERE user_id=? AND connection_id=? ORDER BY generation,folder_id",
    )
    .bind(lease.context.userId, lease.connectionId)
    .all();
  const states = await db
    .prepare(
      "SELECT * FROM outlook_inventory_states WHERE user_id=? AND connection_id=? ORDER BY generation,scope_key",
    )
    .bind(lease.context.userId, lease.connectionId)
    .all();
  return { folders: folders.results, states: states.results };
}
function batchObserver(
  action: () => Promise<void>,
  errors: string[] = [],
): D1Database {
  const observed = createInvocationDatabase(env.DB, 40).db;
  return {
    prepare: observed.prepare.bind(observed),
    exec: observed.exec.bind(observed),
    dump: observed.dump.bind(observed),
    withSession: observed.withSession.bind(observed),
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      await action();
      try {
        return await observed.batch<T>(statements);
      } catch (error) {
        errors.push(
          error instanceof Error
            ? error.message
            : "Unknown synthetic batch error",
        );
        throw error;
      }
    },
  };
}
it("OUTLOOK-02 fresh approved Outlook lease starts root inventory without claiming mailbox message coverage", async () => {
  const { lease, meter, store } = await claimed("qa-outlook-inventory-root");
  expect(await store.getNextInventory(lease)).toEqual({
    kind: "ready",
    parentFolderId: null,
    expectedVersion: 0,
    nextLink: null,
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM source_messages WHERE user_id=?")
      .bind(lease.context.userId)
      .first("n"),
  ).toBe(0);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-02 nested traversal survives fresh store instances and separates provider folder 'root' from inventory root scope", async () => {
  const { lease } = await claimed("qa-outlook-inventory-nested");
  const first = invocation();
  expect(
    await first.store.commitInventoryPage(lease, {
      parentFolderId: null,
      expectedVersion: 0,
      folders: [
        {
          id: "root",
          parentFolderId: "actual-provider-root",
          childFolderCount: 1,
          isHidden: false,
        },
      ],
      nextLink: null,
    }),
  ).toEqual({ kind: "committed", version: 1 });
  expect(first.meter.executedStatements()).toBeLessThanOrEqual(40);
  const child = invocation();
  expect(await child.store.getNextInventory(lease)).toEqual({
    kind: "ready",
    parentFolderId: "root",
    expectedVersion: 1,
    nextLink: null,
  });
  const link =
    "https://graph.microsoft.com/v1.0/me/mailFolders/root/childFolders?$skiptoken=child%2B%2F%3D";
  expect(
    await child.store.commitInventoryPage(lease, {
      parentFolderId: "root",
      expectedVersion: 1,
      folders: [
        {
          id: "nested",
          parentFolderId: "root",
          childFolderCount: 0,
          isHidden: true,
        },
      ],
      nextLink: link,
    }),
  ).toEqual({ kind: "committed", version: 2 });
  expect(child.meter.executedStatements()).toBeLessThanOrEqual(40);
  const resumed = invocation();
  expect(await resumed.store.getNextInventory(lease)).toEqual({
    kind: "ready",
    parentFolderId: "root",
    expectedVersion: 2,
    nextLink: link,
  });
  expect(
    await resumed.store.commitInventoryPage(lease, {
      parentFolderId: "root",
      expectedVersion: 2,
      folders: [],
      nextLink: null,
    }),
  ).toEqual({ kind: "committed", version: 3 });
  expect(resumed.meter.executedStatements()).toBeLessThanOrEqual(40);
  const finished = invocation();
  expect(await finished.store.getNextInventory(lease)).toEqual({
    kind: "complete",
  });
  expect(finished.meter.executedStatements()).toBeLessThanOrEqual(40);
  expect((await snapshot(lease)).states.map((row) => row.scope_key)).toEqual([
    "folder:root",
    "root",
  ]);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM source_messages WHERE user_id=?")
      .bind(lease.context.userId)
      .first("n"),
  ).toBe(0);
});

it("OUTLOOK-02 replay and stale parent version preserve all folder rows and queued cursors", async () => {
  const { lease } = await claimed("qa-outlook-inventory-cas");
  const first = invocation();
  const initial = {
    ...page("parent"),
    folders: [
      {
        id: "parent",
        parentFolderId: "provider-root",
        childFolderCount: 1,
        isHidden: false,
      },
    ],
  };
  expect(await first.store.commitInventoryPage(lease, initial)).toEqual({
    kind: "committed",
    version: 1,
  });
  const before = await snapshot(lease);
  const replay = invocation();
  expect(await replay.store.commitInventoryPage(lease, initial)).toEqual({
    kind: "conflict",
  });
  expect(
    await replay.store.commitInventoryPage(lease, page("must-not-appear")),
  ).toEqual({ kind: "conflict" });
  expect(await snapshot(lease)).toEqual(before);
  expect(replay.meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-02 identical mailbox and folder IDs remain private under two actual owned job leases", async () => {
  const a = await claimed("qa-outlook-inventory-owner-a"),
    b = await claimed("qa-outlook-inventory-owner-b");
  const linkA =
      "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=owner-A",
    linkB =
      "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=owner-B";
  expect(
    await a.store.commitInventoryPage(a.lease, {
      ...page("same-folder"),
      nextLink: linkA,
    }),
  ).toEqual({ kind: "committed", version: 1 });
  expect(await b.store.getNextInventory(b.lease)).toEqual({
    kind: "ready",
    parentFolderId: null,
    expectedVersion: 0,
    nextLink: null,
  });
  const beforeA = await snapshot(a.lease);
  expect(
    await b.store.commitInventoryPage(b.lease, {
      ...page("same-folder"),
      nextLink: linkB,
    }),
  ).toEqual({ kind: "committed", version: 1 });
  expect(await snapshot(a.lease)).toEqual(beforeA);
  expect(await b.store.getNextInventory(b.lease)).toEqual({
    kind: "ready",
    parentFolderId: null,
    expectedVersion: 1,
    nextLink: linkB,
  });
  for (const meter of [a.meter, b.meter])
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it.each([
  {
    name: "provider",
    sql: "UPDATE connections SET provider='gmail' WHERE user_id=?",
  },
  {
    name: "read-grant",
    sql: "UPDATE connections SET scopes='[\"openid\"]' WHERE user_id=?",
  },
  {
    name: "consent",
    sql: "UPDATE processing_consents SET revoked_at=1 WHERE user_id=?",
  },
  {
    name: "profile",
    sql: "UPDATE profiles SET status='deleting' WHERE user_id=?",
  },
  {
    name: "generation",
    sql: "UPDATE connections SET generation=generation+1 WHERE user_id=?",
  },
  {
    name: "disconnect",
    sql: "UPDATE connections SET state='disconnected',scheduling_state='paused' WHERE user_id=?",
  },
  { name: "lease-fence", sql: "UPDATE jobs SET fence=fence+1 WHERE user_id=?" },
  {
    name: "lease-expiry",
    sql: "UPDATE jobs SET lease_expires_at=0 WHERE user_id=?",
  },
  {
    name: "AI-revision",
    sql: "UPDATE ai_settings SET revision=revision+1 WHERE user_id=?",
  },
])(
  "OUTLOOK-02 stale $name denies inventory reads and writes with zero protected changes",
  async ({ name, sql }) => {
    const { lease } = await claimed(`qa-outlook-inventory-stale-${name}`);
    const retained = invocation();
    expect(
      await retained.store.commitInventoryPage(lease, {
        ...page("retained"),
        nextLink:
          "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=private-retained",
      }),
    ).toEqual({ kind: "committed", version: 1 });
    expect(retained.meter.executedStatements()).toBeLessThanOrEqual(40);
    const before = await snapshot(lease);
    await db.prepare(sql).bind(lease.context.userId).run();
    const current = invocation();
    expect(await current.store.getNextInventory(lease)).toEqual({
      kind: "stale",
    });
    expect(
      await current.store.commitInventoryPage(lease, {
        ...page("must-not-write"),
        expectedVersion: 1,
      }),
    ).toEqual({
      kind: "stale",
    });
    expect(await snapshot(lease)).toEqual(before);
    expect(current.meter.executedStatements()).toBeLessThanOrEqual(40);
  },
);

it("OUTLOOK-02 permission revoked between preflight and batch prevents parent cursor and folder writes atomically", async () => {
  const { lease } = await claimed("qa-outlook-inventory-late-revoke");
  const before = await snapshot(lease);
  let entered = 0;
  const meter = createInvocationDatabase(
    batchObserver(async () => {
      entered++;
      await db
        .prepare("UPDATE processing_consents SET revoked_at=1 WHERE user_id=?")
        .bind(lease.context.userId)
        .run();
    }),
    40,
  );
  expect(
    await createOutlookFolderStore(meter.db).commitInventoryPage(lease, page()),
  ).toEqual({ kind: "stale" });
  expect(entered).toBe(1);
  expect(await snapshot(lease)).toEqual(before);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-02 native folder failure rolls back parent CAS, all folder writes and queued child states", async () => {
  const { lease } = await claimed("qa-outlook-inventory-rollback");
  const first = invocation();
  expect(
    await first.store.commitInventoryPage(lease, {
      ...page("retained"),
      nextLink:
        "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=retained",
    }),
  ).toEqual({ kind: "committed", version: 1 });
  const before = await snapshot(lease);
  await db
    .prepare(
      "CREATE TRIGGER qa_folder_abort BEFORE INSERT ON outlook_folders WHEN NEW.folder_id='crash-folder' BEGIN SELECT RAISE(ABORT,'synthetic-folder-failure'); END",
    )
    .run();
  const errors: string[] = [];
  const meter = createInvocationDatabase(
    batchObserver(async () => {}, errors),
    40,
  );
  let rejectedError: unknown;
  let rejectedResult:
    | Awaited<
        ReturnType<
          ReturnType<typeof createOutlookFolderStore>["commitInventoryPage"]
        >
      >
    | undefined;
  try {
    rejectedResult = await createOutlookFolderStore(
      meter.db,
    ).commitInventoryPage(lease, {
      parentFolderId: null,
      expectedVersion: 1,
      folders: [
        {
          id: "crash-folder",
          parentFolderId: "provider-root",
          childFolderCount: 1,
          isHidden: false,
        },
      ],
      nextLink: null,
    });
  } catch (error) {
    rejectedError = error;
  }
  if (rejectedError !== undefined) expect(rejectedError).toBeInstanceOf(Error);
  else {
    expect(rejectedResult).toBeDefined();
    expect(rejectedResult?.kind).not.toBe("committed");
  }
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("synthetic-folder-failure");
  expect(await snapshot(lease)).toEqual(before);
  expect(
    await db
      .prepare("PRAGMA foreign_key_check")
      .all()
      .then((result) => result.results),
  ).toEqual([]);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-02 maximum five-folder page and the 2000-folder cap remain bounded without declaring over-limit coverage complete", async () => {
  const { lease } = await claimed("qa-outlook-inventory-limit");
  await db
    .prepare(
      "WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<1994) INSERT INTO outlook_folders(user_id,connection_id,generation,folder_id,parent_folder_id,child_folder_count,is_hidden) SELECT ?,?,1,'existing-'||x,'provider-root',0,0 FROM n",
    )
    .bind(lease.context.userId, lease.connectionId)
    .run();
  const current = invocation();
  expect(
    await current.store.commitInventoryPage(lease, {
      parentFolderId: null,
      expectedVersion: 0,
      folders: Array.from({ length: 5 }, (_, i) => ({
        id: `final-${i}`,
        parentFolderId: "provider-root",
        childFolderCount: 0,
        isHidden: false,
      })),
      nextLink:
        "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=more",
    }),
  ).toEqual({ kind: "committed", version: 1 });
  expect(current.meter.executedStatements()).toBeLessThanOrEqual(40);
  const before = await snapshot(lease),
    over = invocation();
  expect(
    await over.store.commitInventoryPage(lease, {
      ...page("over-limit"),
      expectedVersion: 1,
    }),
  ).toEqual({ kind: "limit" });
  expect(await snapshot(lease)).toEqual(before);
  expect(before.folders).toHaveLength(2000);
  expect(before.states.find((row) => row.scope_key === "root")?.state).toBe(
    "pending",
  );
  expect(over.meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("OUTLOOK-02/03 inventory commits opaque cursor and actual provider-root ancestry durably under the same native claim budget", async () => {
  const { lease, meter, store } = await claimed("qa-outlook-inventory-page");
  const nextLink =
    "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=opaque%2B%2F%3D";
  expect(
    await store.commitInventoryPage(lease, {
      parentFolderId: null,
      expectedVersion: 0,
      folders: [
        {
          id: "archive",
          parentFolderId: "actual-provider-root",
          childFolderCount: 1,
          isHidden: false,
        },
      ],
      nextLink,
    }),
  ).toEqual({ kind: "committed", version: 1 });
  expect(
    await db
      .prepare(
        "SELECT folder_id,parent_folder_id,child_folder_count,is_hidden FROM outlook_folders WHERE user_id=? AND connection_id=? AND generation=1",
      )
      .bind(lease.context.userId, lease.connectionId)
      .all()
      .then((result) => result.results),
  ).toEqual([
    {
      folder_id: "archive",
      parent_folder_id: "actual-provider-root",
      child_folder_count: 1,
      is_hidden: 0,
    },
  ]);
  expect(await store.getNextInventory(lease)).toEqual({
    kind: "ready",
    parentFolderId: null,
    expectedVersion: 1,
    nextLink,
  });
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-02 getNext rechecks consent after its protected cursor read before returning any ready or complete state", async () => {
  const { lease } = await claimed("qa-outlook-inventory-read-race");
  const seeded = invocation();
  expect(
    await seeded.store.commitInventoryPage(lease, {
      ...page(),
      nextLink:
        "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=private-cursor",
    }),
  ).toEqual({ kind: "committed", version: 1 });
  const before = await snapshot(lease);
  const existing = createInvocationDatabase(env.DB, 40);
  const { db: faulted, fireCounts } = faultingDatabase(existing.db, [
    {
      match: (sql) =>
        /^(SELECT|WITH)\b/.test(sql.trimStart()) &&
        sql.includes("FROM outlook_inventory_states"),
      on: "first",
      fire: async ({ proceed, native }) => {
        await native
          .prepare(
            "UPDATE processing_consents SET revoked_at=1 WHERE user_id=?",
          )
          .bind(lease.context.userId)
          .run();
        return proceed();
      },
    },
  ]);
  const meter = createInvocationDatabase(faulted, 40);
  const next = await createOutlookFolderStore(meter.db).getNextInventory(lease);
  expect(fireCounts[0]).toBe(1);
  expect(
    await faulted
      .prepare("SELECT revoked_at FROM processing_consents WHERE user_id=?")
      .bind(lease.context.userId)
      .first("revoked_at"),
  ).toBe(1);
  expect(next).toEqual({ kind: "stale" });
  expect(await snapshot(lease)).toEqual(before);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("OUTLOOK-02 cyclic cross-page ancestry cannot overwrite the graph or falsely finish inventory", async () => {
  const { lease } = await claimed("qa-outlook-inventory-cycle");
  const root = invocation();
  expect(
    await root.store.commitInventoryPage(lease, {
      parentFolderId: null,
      expectedVersion: 0,
      folders: [
        {
          id: "A",
          parentFolderId: "provider-root",
          childFolderCount: 1,
          isHidden: false,
        },
      ],
      nextLink: null,
    }),
  ).toEqual({ kind: "committed", version: 1 });
  const child = invocation();
  expect(
    await child.store.commitInventoryPage(lease, {
      parentFolderId: "A",
      expectedVersion: 1,
      folders: [
        { id: "B", parentFolderId: "A", childFolderCount: 1, isHidden: false },
      ],
      nextLink: null,
    }),
  ).toEqual({ kind: "committed", version: 2 });
  const before = await snapshot(lease),
    attempt = invocation();
  let refused = false;
  try {
    const result = await attempt.store.commitInventoryPage(lease, {
      parentFolderId: "B",
      expectedVersion: 1,
      folders: [
        { id: "A", parentFolderId: "B", childFolderCount: 1, isHidden: false },
      ],
      nextLink: null,
    });
    refused = result.kind === "conflict";
  } catch (error) {
    expect(error).toBeInstanceOf(DiscoveryError);
    expect(error).toMatchObject({ code: "INVALID_RANGE" });
    refused = true;
  }
  expect(refused).toBe(true);
  expect(await snapshot(lease)).toEqual(before);
  expect(await attempt.store.getNextInventory(lease)).toEqual({
    kind: "ready",
    parentFolderId: "B",
    expectedVersion: 1,
    nextLink: null,
  });
  for (const meter of [root.meter, child.meter, attempt.meter])
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-02 a legitimate noncyclic folder move preserves one identity and completes only inventory", async () => {
  const { lease } = await claimed("qa-outlook-inventory-move");
  const root = invocation();
  expect(
    await root.store.commitInventoryPage(lease, {
      parentFolderId: null,
      expectedVersion: 0,
      folders: [
        {
          id: "A",
          parentFolderId: "provider-root",
          childFolderCount: 1,
          isHidden: false,
        },
        {
          id: "B",
          parentFolderId: "provider-root",
          childFolderCount: 1,
          isHidden: false,
        },
      ],
      nextLink: null,
    }),
  ).toEqual({ kind: "committed", version: 1 });
  for (const parentFolderId of ["A", "B"]) {
    const current = invocation();
    expect(
      await current.store.commitInventoryPage(lease, {
        parentFolderId,
        expectedVersion: 1,
        folders: [
          { id: "C", parentFolderId, childFolderCount: 0, isHidden: false },
        ],
        nextLink: null,
      }),
    ).toEqual({ kind: "committed", version: 2 });
    expect(current.meter.executedStatements()).toBeLessThanOrEqual(40);
  }
  expect(
    await db
      .prepare(
        "SELECT folder_id,parent_folder_id FROM outlook_folders WHERE user_id=? AND folder_id='C'",
      )
      .bind(lease.context.userId)
      .all()
      .then((result) => result.results),
  ).toEqual([{ folder_id: "C", parent_folder_id: "B" }]);
  const final = invocation();
  expect(await final.store.getNextInventory(lease)).toEqual({
    kind: "complete",
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM source_messages WHERE user_id=?")
      .bind(lease.context.userId)
      .first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE user_id=?")
      .bind(lease.context.userId)
      .first("n"),
  ).toBe(0);
  for (const meter of [root.meter, final.meter])
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
