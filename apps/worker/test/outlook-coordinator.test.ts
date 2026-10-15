import { env } from "cloudflare:workers";
import type { JobLease, JobPolicy } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import folderExclusionsMigration from "../../../packages/adapters/migrations/0004_outlook_folder_exclusions.sql?raw";
import type { OutlookGraphDiscoveryPort } from "../../../packages/adapters/src/discovery/outlook";
import { createOutlookInventoryCoordinator } from "../../../packages/adapters/src/discovery/outlook-coordinator";
import { createOutlookFolderStore } from "../../../packages/adapters/src/discovery/outlook-state";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { OUTLOOK_AUTHORIZATION_SCOPES } from "../../../packages/adapters/src/mailbox/outlook-configuration";
import { createInvocationDatabase } from "../src/invocation-database";
import { installOnboardingQaHooks, owner } from "./onboarding-qa-fixture";
import { seedReviewedConsent } from "./outlook-consent-fixture";

installOnboardingQaHooks();

beforeAll(async () => {
  await env.DB.prepare(folderExclusionsMigration).run();
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
async function claimed(
  name: string,
  claimDatabase: D1Database = env.DB,
): Promise<JobLease> {
  const current = await owner(
    `qa-outlook-coordinator-${name}`,
    "inventory-mailbox",
    [...OUTLOOK_AUTHORIZATION_SCOPES],
  );
  const userId = current.tenant.userId;
  await env.DB.prepare(
    "UPDATE connections SET provider='outlook',scheduling_state='active',next_sync_at=NULL WHERE user_id=? AND id='inventory-mailbox'",
  )
    .bind(userId)
    .run();
  await seedReviewedConsent(env.DB, {
    userId,
    consentId: `pc-${name}`,
    connectionId: "inventory-mailbox",
  });
  await env.DB.prepare(
    "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES(?,?,'inventory-mailbox',?,1,'mailbox-backfill',?,'ready',0)",
  )
    .bind(`j-${name}`, userId, `pc-${name}`, `j-${name}`)
    .run();
  const lease = await createJobStore(claimDatabase, { policy }).claim(
    `j-${name}`,
  );
  if (!lease) throw new Error("Synthetic Outlook lease unavailable");
  return lease;
}
function provider(
  folders: OutlookGraphDiscoveryPort["folders"],
): OutlookGraphDiscoveryPort {
  function unused(): never {
    throw new Error("Unexpected content request during inventory");
  }
  return {
    folders,
    folder: unused,
    listFolder: unused,
    deltaFolder: unused,
    metadata: unused,
  };
}
function invocation(
  lease: JobLease,
  graph: OutlookGraphDiscoveryPort,
  checkpoint: () => Promise<boolean> = async () => true,
) {
  const meter = createInvocationDatabase(env.DB, 40);
  const coordinator = createOutlookInventoryCoordinator(meter.db, {
    open: async () => graph,
    remainingStatements: meter.remainingStatements,
  });
  return {
    meter,
    run: () =>
      coordinator.runPage(lease, {
        signal: new AbortController().signal,
        checkpoint,
      }),
  };
}
it("OUTLOOK-02 coordinator recursively resumes inventory in fresh invocations without reading message content", async () => {
  const lease = await claimed("nested");
  const scopes: (string | undefined)[] = [];
  const graph = provider(async (input) => {
    scopes.push(input.parentFolderId);
    return {
      folders: [
        {
          id: input.parentFolderId ? "child" : "parent",
          parentFolderId: input.parentFolderId ?? "provider-root",
          displayName: "Synthetic private folder",
          childFolderCount: input.parentFolderId ? 0 : 1,
          isHidden: false,
        },
      ],
    };
  });
  const first = invocation(lease, graph);
  expect(await first.run()).toEqual({ kind: "progressed" });
  expect(first.meter.executedStatements()).toBeLessThanOrEqual(40);
  const second = invocation(lease, graph);
  expect(await second.run()).toEqual({ kind: "progressed" });
  expect(second.meter.executedStatements()).toBeLessThanOrEqual(40);
  expect(await invocation(lease, graph).run()).toEqual({
    kind: "inventory-complete",
  });
  expect(scopes).toEqual([undefined, "parent"]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM outlook_folders WHERE user_id=?",
    )
      .bind(lease.context.userId)
      .first("n"),
  ).toBe(2);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM source_messages WHERE user_id=?",
    )
      .bind(lease.context.userId)
      .first("n"),
  ).toBe(0);
});
it("OUTLOOK-02 revoked consent after folder response cannot commit cursor or children", async () => {
  const lease = await claimed("revoke");
  const graph = provider(async () => {
    await env.DB.prepare(
      "UPDATE processing_consents SET revoked_at=1 WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, lease.consentId)
      .run();
    return {
      folders: [
        {
          id: "must-not-save",
          parentFolderId: "provider-root",
          displayName: "Synthetic",
          childFolderCount: 1,
          isHidden: false,
        },
      ],
    };
  });
  expect(await invocation(lease, graph).run()).toEqual({ kind: "stale" });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM outlook_inventory_states WHERE user_id=?",
    )
      .bind(lease.context.userId)
      .first("n"),
  ).toBe(0);
});
it("OUTLOOK-02 missing Start authorization performs no provider request", async () => {
  const lease = await claimed("no-start");
  await env.DB.prepare(
    "UPDATE processing_consents SET background_authorized=0 WHERE user_id=?",
  )
    .bind(lease.context.userId)
    .run();
  let calls = 0;
  const graph = provider(async () => {
    calls++;
    return { folders: [] };
  });
  expect(await invocation(lease, graph).run()).toEqual({ kind: "stale" });
  expect(calls).toBe(0);
});
it("OUTLOOK-02 opaque inventory continuation survives response and process restart byte for byte", async () => {
  const lease = await claimed("opaque");
  const link =
    "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=opaque%2B%2F%3D";
  const received: (string | undefined)[] = [];
  const graph = provider(async (input) => {
    received.push(input.nextLink);
    return received.length === 1
      ? { folders: [], nextLink: link }
      : { folders: [] };
  });
  expect(await invocation(lease, graph).run()).toEqual({ kind: "progressed" });
  expect(await invocation(lease, graph).run()).toEqual({ kind: "progressed" });
  expect(received).toEqual([undefined, link]);
});
it("OUTLOOK-02 repeated empty inventory cursor cannot advance its version or loop forever", async () => {
  const lease = await claimed("cursor-loop");
  const firstLink =
    "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=first%2B%2F%3D";
  const secondLink =
    "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=second%2B%2F%3D";
  let calls = 0;
  const graph = provider(async (input) => {
    calls++;
    expect(input.nextLink).toBe(calls === 1 ? undefined : firstLink);
    return { folders: [], nextLink: calls === 3 ? secondLink : firstLink };
  });
  expect(await invocation(lease, graph).run()).toEqual({ kind: "progressed" });
  const persisted = () =>
    env.DB.prepare(
      "SELECT version,next_link FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND scope_key='root'",
    )
      .bind(lease.context.userId, lease.connectionId, lease.generation)
      .first<{ version: number; next_link: string | null }>();
  expect(await persisted()).toEqual({ version: 1, next_link: firstLink });
  expect(await invocation(lease, graph).run()).toEqual({
    kind: "cursor-loop",
  });
  expect(await persisted()).toEqual({ version: 1, next_link: firstLink });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM outlook_folders WHERE user_id=? AND connection_id=? AND generation=?",
    )
      .bind(lease.context.userId, lease.connectionId, lease.generation)
      .first("n"),
  ).toBe(0);
  expect(await invocation(lease, graph).run()).toEqual({ kind: "progressed" });
  expect(await persisted()).toEqual({ version: 2, next_link: secondLink });
});
it("OUTLOOK-02 canceled control and insufficient combined invocation allowance perform no network call", async () => {
  const lease = await claimed("budget");
  let opens = 0;
  const meter = createInvocationDatabase(env.DB, 40);
  const coordinator = createOutlookInventoryCoordinator(meter.db, {
    open: async () => {
      opens++;
      return provider(async () => ({ folders: [] }));
    },
    remainingStatements: () => 3,
  });
  expect(
    await coordinator.runPage(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "budget" });
  expect(meter.executedStatements()).toBeLessThanOrEqual(0);
  const controller = new AbortController();
  controller.abort();
  expect(
    await coordinator.runPage(lease, {
      signal: controller.signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "stale" });
  expect(opens).toBe(0);
});
it("OUTLOOK-02 false checkpoint after credential opening prevents the folder request", async () => {
  const lease = await claimed("checkpoint");
  let folders = 0,
    checks = 0;
  const graph = provider(async () => {
    folders++;
    return { folders: [] };
  });
  expect(
    await invocation(lease, graph, async () => ++checks < 3).run(),
  ).toEqual({ kind: "stale" });
  expect(folders).toBe(0);
});
it("OUTLOOK-02 processing revision changed while opening credentials stops the next network boundary", async () => {
  const lease = await claimed("processing-change");
  let requests = 0;
  const meter = createInvocationDatabase(env.DB, 40);
  const coordinator = createOutlookInventoryCoordinator(meter.db, {
    remainingStatements: meter.remainingStatements,
    open: async () => {
      await env.DB.prepare(
        "UPDATE processing_consents SET ai_settings_revision=2 WHERE user_id=? AND id=?",
      )
        .bind(lease.context.userId, lease.consentId)
        .run();
      return provider(async () => {
        requests++;
        return { folders: [] };
      });
    },
  });
  expect(
    await coordinator.runPage(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "stale" });
  expect(requests).toBe(0);
});

it("OUTLOOK-02 claim, credential read, real checkpoints, page commit and settlement share at most forty statements", async () => {
  const meter = createInvocationDatabase(env.DB, 40);
  const lease = await claimed("combined-meter", meter.db);
  const jobs = createJobStore(meter.db, { policy });
  let requests = 0;
  const coordinator = createOutlookInventoryCoordinator(meter.db, {
    remainingStatements: meter.remainingStatements,
    open: async () => {
      expect(
        await meter.db
          .prepare("SELECT id FROM connections WHERE user_id=? AND id=?")
          .bind(lease.context.userId, lease.connectionId)
          .first("id"),
      ).toBe(lease.connectionId);
      return provider(async () => {
        requests++;
        return { folders: [] };
      });
    },
  });
  expect(
    await coordinator.runPage(lease, {
      signal: new AbortController().signal,
      checkpoint: () => jobs.checkpoint(lease),
    }),
  ).toEqual({ kind: "progressed" });
  expect(requests).toBe(1);
  // This bounded phase has no message handler yet; settlement must not claim import completion.
  expect(
    await jobs.finish(lease, { kind: "paused", code: "handler-unavailable" }),
  ).toBe(true);
  expect(meter.executedStatements()).toBeGreaterThan(15);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("OUTLOOK-02 losing inventory CAS preserves the winning page and returns conflict", async () => {
  const lease = await claimed("cas-conflict");
  const winner =
    "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=winner%2B%2F%3D";
  const graph = provider(async () => {
    expect(
      await createOutlookFolderStore(env.DB).commitInventoryPage(lease, {
        parentFolderId: null,
        expectedVersion: 0,
        nextLink: winner,
        folders: [
          {
            id: "winner",
            parentFolderId: "provider-root",
            childFolderCount: 0,
            isHidden: false,
          },
        ],
      }),
    ).toEqual({ kind: "committed", version: 1 });
    return {
      folders: [
        {
          id: "loser",
          parentFolderId: "provider-root",
          displayName: "Synthetic",
          childFolderCount: 0,
          isHidden: false,
        },
      ],
    };
  });
  expect(await invocation(lease, graph).run()).toEqual({ kind: "conflict" });
  expect(
    await env.DB.prepare(
      "SELECT next_link FROM outlook_inventory_states WHERE user_id=? AND scope_key='root'",
    )
      .bind(lease.context.userId)
      .first("next_link"),
  ).toBe(winner);
  expect(
    (
      await env.DB.prepare(
        "SELECT folder_id FROM outlook_folders WHERE user_id=? ORDER BY folder_id",
      )
        .bind(lease.context.userId)
        .all()
    ).results,
  ).toEqual([{ folder_id: "winner" }]);
});
