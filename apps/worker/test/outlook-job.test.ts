import { env } from "cloudflare:workers";
import type { JobLease, JobPolicy } from "@invoxim/core";
import { DiscoveryError } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import folderExclusionsMigration from "../../../packages/adapters/migrations/0004_outlook_folder_exclusions.sql?raw";
import type { OutlookGraphDiscoveryPort } from "../../../packages/adapters/src/discovery/outlook";
import { createOutlookJobRunner } from "../../../packages/adapters/src/discovery/outlook-job";
import { sourceKey } from "../../../packages/adapters/src/hash";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { OUTLOOK_AUTHORIZATION_SCOPES } from "../../../packages/adapters/src/mailbox/outlook-configuration";
import { createInvocationDatabase } from "../src/invocation-database";
import { installOnboardingQaHooks, owner } from "./onboarding-qa-fixture";
import { seedReviewedConsent } from "./outlook-consent-fixture";

installOnboardingQaHooks();

beforeAll(async () => {
  await env.DB.prepare(folderExclusionsMigration).run();
});

const defaultExcludedFolderIds = JSON.stringify([
  "qa-junk-folder",
  "qa-deleted-folder",
  "qa-drafts-folder",
  "qa-sent-folder",
]);

const policy: JobPolicy = {
  dispatchLimit: 1,
  scheduleLimit: 1,
  tenantConcurrency: 2,
  globalConcurrency: 20,
  maxAttempts: 5,
  leaseMs: 300000,
  redeliveryMs: 1000,
  queryLimit: 40,
};

async function claimed(
  name: string,
  mode: "live" | "recent" = "live",
  claimDatabase: D1Database = env.DB,
  generation = 1,
): Promise<JobLease> {
  const current = await owner(`qa-outlook-job-${name}`, "outlook-mailbox", [
    ...OUTLOOK_AUTHORIZATION_SCOPES,
  ]);
  const userId = current.tenant.userId;
  await env.DB.prepare(
    "UPDATE connections SET provider='outlook',scheduling_state='active',next_sync_at=NULL,generation=? WHERE user_id=? AND id='outlook-mailbox'",
  )
    .bind(generation, userId)
    .run();
  await seedReviewedConsent(env.DB, {
    userId,
    consentId: `pc-${name}`,
    connectionId: "outlook-mailbox",
  });
  await env.DB.prepare(
    "INSERT INTO import_runs(id,user_id,connection_id,consent_id,connection_generation,frozen_start,frozen_cutoff,timezone,request_fingerprint,started_at) VALUES(?,?,'outlook-mailbox',?,?,'2025-10-12T00:00:00.000Z','2026-10-13T00:00:00.000Z','UTC',?,0)",
  )
    .bind(
      `run-${name}`,
      userId,
      `pc-${name}`,
      generation,
      `fingerprint-${name}`,
    )
    .run();
  if (mode === "live") {
    await env.DB.prepare(
      "INSERT INTO sync_states(id,user_id,connection_id,scope_key,sync_kind,run_key,slice_key,stage,coverage_code) VALUES(?,?,'outlook-mailbox','mailbox','incremental','live','live','queued','candidate_unknown')",
    )
      .bind(`ss-${name}`, userId)
      .run();
  } else {
    for (const slice of ["recent", "older"] as const)
      await env.DB.prepare(
        "INSERT INTO sync_states(id,user_id,connection_id,import_run_id,scope_key,sync_kind,run_key,slice_key,frozen_start,frozen_cutoff,stage,coverage_code) VALUES(?,?,? ,?,'mailbox','backfill',?,?,?,?,?,'candidate_unknown')",
      )
        .bind(
          slice === "recent" ? `ss-${name}` : `older-${name}`,
          userId,
          "outlook-mailbox",
          `run-${name}`,
          `run-${name}`,
          slice,
          slice === "recent"
            ? "2026-09-13T00:00:00.000Z"
            : "2025-10-12T00:00:00.000Z",
          slice === "recent"
            ? "2026-10-13T00:00:00.000Z"
            : "2026-09-13T00:00:00.000Z",
          slice === "recent" ? "queued" : "waiting_recent",
        )
        .run();
  }
  await env.DB.prepare(
    "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at) VALUES(?,?,'outlook-mailbox',?,?,?,?,?,'ready',0)",
  )
    .bind(
      `j-${name}`,
      userId,
      `pc-${name}`,
      generation,
      `ss-${name}`,
      mode === "live" ? "sync" : "discover",
      `j-${name}`,
    )
    .run();
  const lease = await createJobStore(claimDatabase, {
    processingReview: null,
    policy,
  }).claim(`j-${name}`);
  if (!lease) throw new Error("Synthetic Outlook job lease unavailable");
  return lease;
}

function provider(
  folders: OutlookGraphDiscoveryPort["folders"],
): OutlookGraphDiscoveryPort {
  function unused(): never {
    throw new Error("Unexpected message request during inventory");
  }
  const aliasIds: Record<string, string> = {
    junkemail: "qa-junk-folder",
    deleteditems: "qa-deleted-folder",
    drafts: "qa-drafts-folder",
    sentitems: "qa-sent-folder",
  };
  return {
    folders,
    folder: async (alias) => ({
      id: aliasIds[alias] ?? "unsupported-alias",
      parentFolderId: "provider-root",
      displayName: "Synthetic folder",
      childFolderCount: 0,
      isHidden: false,
    }),
    listFolder: unused,
    deltaFolder: unused,
    metadata: unused,
  };
}

async function seedLiveFolder(
  lease: JobLease,
  stateId: string,
  folderId: string,
  historyCursor: string | null = null,
) {
  await env.DB.prepare(
    "INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id,excluded_folder_ids) VALUES(?,?,?,'root',NULL,1,NULL,'complete',?,?)",
  )
    .bind(
      lease.context.userId,
      lease.connectionId,
      lease.generation,
      crypto.randomUUID(),
      defaultExcludedFolderIds,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO outlook_folders(user_id,connection_id,generation,folder_id,parent_folder_id,child_folder_count,is_hidden) VALUES(?,?,?,?,'provider-root',0,0)",
  )
    .bind(lease.context.userId, lease.connectionId, lease.generation, folderId)
    .run();
  await env.DB.prepare(
    "INSERT INTO sync_states(id,user_id,connection_id,scope_key,sync_kind,run_key,slice_key,stage,coverage_code,history_cursor) VALUES(?,?,?,?,'incremental','live','live','queued','candidate_unknown',?)",
  )
    .bind(
      stateId,
      lease.context.userId,
      lease.connectionId,
      `outlook:${lease.generation}:${folderId}`,
      historyCursor,
    )
    .run();
}

it("OUTLOOK-02 inventory page atomically advances its cursor and schedules a fresh job", async () => {
  const lease = await claimed("durable-inventory");
  const nextLink =
    "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=opaque%2B%2F%3D";
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () => provider(async () => ({ folders: [], nextLink })),
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT version,next_link FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND scope_key='root'",
    )
      .bind(lease.context.userId, lease.connectionId, lease.generation)
      .first(),
  ).toEqual({ version: 1, next_link: nextLink });
  expect(
    await env.DB.prepare(
      "SELECT status,outcome_code FROM jobs WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, lease.jobId)
      .first(),
  ).toEqual({ status: "completed", outcome_code: "discovery_staged" });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND connection_id=? AND sync_state_id=? AND type='sync' AND status='ready'",
    )
      .bind(lease.context.userId, lease.connectionId, lease.syncStateId)
      .first("n"),
  ).toBe(1);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-04 initial folder delta durably queues one source and saves the opaque folder cursor", async () => {
  const lease = await claimed("first-delta");
  const folderId = "inbox-folder";
  const messageId = "immutable+message/=";
  const deltaLink = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=opaque%2B%2F%3D`;
  await env.DB.prepare(
    "INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id,excluded_folder_ids) VALUES(?,?,?,'root',NULL,1,NULL,'complete',?,?)",
  )
    .bind(
      lease.context.userId,
      lease.connectionId,
      lease.generation,
      crypto.randomUUID(),
      defaultExcludedFolderIds,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO outlook_folders(user_id,connection_id,generation,folder_id,parent_folder_id,child_folder_count,is_hidden) VALUES(?,?,?,?,'provider-root',0,0)",
  )
    .bind(lease.context.userId, lease.connectionId, lease.generation, folderId)
    .run();
  await env.DB.prepare(
    "INSERT INTO sync_states(id,user_id,connection_id,scope_key,sync_kind,run_key,slice_key,stage,coverage_code) VALUES(?,?,?,?,'incremental','live','live','queued','candidate_unknown')",
  )
    .bind(
      "folder-first-delta",
      lease.context.userId,
      lease.connectionId,
      `outlook:${lease.generation}:${folderId}`,
    )
    .run();
  let deltaCalls = 0;
  const graph: OutlookGraphDiscoveryPort = {
    ...provider(async () => {
      throw new Error("Inventory is complete");
    }),
    deltaFolder: async (input) => {
      deltaCalls++;
      expect(input.folderId).toBe(folderId);
      expect(input.continuationLink).toBeUndefined();
      return { ids: [messageId], folderRemovedIds: [], deltaLink };
    },
    metadata: async (id) => ({
      id,
      parentFolderId: folderId,
      receivedAtMs: Date.parse("2026-10-12T12:00:00.000Z"),
      available: true,
      excluded: false,
      candidate: "unknown",
    }),
  };
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () => graph,
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(deltaCalls).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT stage,history_cursor,page_token,discovery_version FROM sync_states WHERE user_id=? AND id='folder-first-delta'",
    )
      .bind(lease.context.userId)
      .first(),
  ).toEqual({
    stage: "idle",
    history_cursor: deltaLink,
    page_token: null,
    discovery_version: 1,
  });
  expect(
    await env.DB.prepare(
      "SELECT provider_message_id,processing_status,available FROM source_messages WHERE user_id=? AND connection_id=?",
    )
      .bind(lease.context.userId, lease.connectionId)
      .first(),
  ).toEqual({
    provider_message_id: messageId,
    processing_status: "discovered",
    available: 1,
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND type='source-extract' AND status='ready'",
    )
      .bind(lease.context.userId)
      .first("n"),
  ).toBe(1);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-05 expired folder delta resets only its cursor and schedules recovery without a failure attempt", async () => {
  const lease = await claimed("expired-delta");
  const folderId = "archive-folder";
  const stateId = "folder-expired-delta";
  const prior = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=expired`;
  await seedLiveFolder(lease, stateId, folderId, prior);
  const graph: OutlookGraphDiscoveryPort = {
    ...provider(async () => {
      throw new Error("Inventory is complete");
    }),
    deltaFolder: async (input) => {
      expect(input.continuationLink).toBe(prior);
      throw new DiscoveryError("HISTORY_EXPIRED");
    },
  };
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () => graph,
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT stage,page_token,history_cursor,history_reset_count,discovery_version,frozen_start,frozen_cutoff FROM sync_states WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, stateId)
      .first(),
  ).toEqual({
    stage: "recovering",
    page_token: null,
    history_cursor: null,
    history_reset_count: 1,
    discovery_version: 1,
    frozen_start: "2025-10-12T00:00:00.000Z",
    frozen_cutoff: "2026-10-13T00:00:00.000Z",
  });
  expect(
    await env.DB.prepare(
      "SELECT status,retry_count FROM jobs WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, lease.jobId)
      .first(),
  ).toEqual({ status: "completed", retry_count: lease.attempt });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND connection_id=? AND sync_state_id=? AND type='sync' AND status='ready'",
    )
      .bind(lease.context.userId, lease.connectionId, lease.syncStateId)
      .first("n"),
  ).toBe(1);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-04 a moved message remains available when Graph removes it from one folder", async () => {
  const lease = await claimed("moved-message");
  const folderId = "old-folder";
  const messageId = "immutable+move/=";
  await seedLiveFolder(lease, "folder-moved-message", folderId);
  await env.DB.prepare(
    "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,processing_status,generation,available) VALUES(?,?,?,?,?,'processed',?,1)",
  )
    .bind(
      crypto.randomUUID(),
      lease.context.userId,
      lease.connectionId,
      messageId,
      1000,
      lease.generation,
    )
    .run();
  const deltaLink = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=after-move`;
  const graph: OutlookGraphDiscoveryPort = {
    ...provider(async () => {
      throw new Error("Inventory is complete");
    }),
    deltaFolder: async () => ({
      ids: [],
      folderRemovedIds: [messageId],
      deltaLink,
    }),
    metadata: async (id) => ({
      id,
      parentFolderId: "new-folder",
      receivedAtMs: 1000,
      available: true,
      excluded: false,
      candidate: "unknown",
    }),
  };
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () => graph,
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT available,processing_status FROM source_messages WHERE user_id=? AND connection_id=? AND provider_message_id=?",
    )
      .bind(lease.context.userId, lease.connectionId, messageId)
      .first(),
  ).toEqual({ available: 1, processing_status: "processed" });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND type='source-extract'",
    )
      .bind(lease.context.userId)
      .first("n"),
  ).toBe(0);
});

it("OUTLOOK-02 complete inventory seeds bounded recent folder cursors and a durable continuation", async () => {
  const lease = await claimed("recent-seed", "recent");
  await env.DB.prepare(
    "INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id,excluded_folder_ids) VALUES(?,?,?,'root',NULL,1,NULL,'complete',?,?)",
  )
    .bind(
      lease.context.userId,
      lease.connectionId,
      lease.generation,
      crypto.randomUUID(),
      defaultExcludedFolderIds,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO outlook_folders(user_id,connection_id,generation,folder_id,parent_folder_id,child_folder_count,is_hidden) VALUES(?,?,?,'receipt-folder','provider-root',0,0)",
  )
    .bind(lease.context.userId, lease.connectionId, lease.generation)
    .run();
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () =>
      provider(async () => {
        throw new Error("Inventory is already complete");
      }),
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT scope_key,slice_key,stage,frozen_start,frozen_cutoff FROM sync_states WHERE user_id=? AND scope_key='outlook:1:receipt-folder'",
    )
      .bind(lease.context.userId)
      .first(),
  ).toEqual({
    scope_key: "outlook:1:receipt-folder",
    slice_key: "recent",
    stage: "queued",
    frozen_start: "2026-09-13T00:00:00.000Z",
    frozen_cutoff: "2026-10-13T00:00:00.000Z",
  });
  expect(
    await env.DB.prepare(
      "SELECT stage FROM sync_states WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, lease.syncStateId)
      .first("stage"),
  ).toBe("queued");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND sync_state_id=? AND type='discover' AND status='ready'",
    )
      .bind(lease.context.userId, lease.syncStateId)
      .first("n"),
  ).toBe(1);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-02 completed recent folders release the older slice without declaring the import complete", async () => {
  const lease = await claimed("older-release", "recent");
  await env.DB.prepare(
    "INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id,excluded_folder_ids) VALUES(?,?,?,'root',NULL,1,NULL,'complete',?,?)",
  )
    .bind(
      lease.context.userId,
      lease.connectionId,
      lease.generation,
      crypto.randomUUID(),
      defaultExcludedFolderIds,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO outlook_folders(user_id,connection_id,generation,folder_id,parent_folder_id,child_folder_count,is_hidden) VALUES(?,?,?,'archive-folder','provider-root',0,0)",
  )
    .bind(lease.context.userId, lease.connectionId, lease.generation)
    .run();
  await env.DB.prepare(
    "INSERT INTO sync_states(id,user_id,connection_id,import_run_id,scope_key,sync_kind,run_key,slice_key,frozen_start,frozen_cutoff,stage,coverage_code) VALUES(?,?,?,?,'outlook:1:archive-folder','backfill',?,'recent','2026-09-13T00:00:00.000Z','2026-10-13T00:00:00.000Z','discovery_complete','candidate_unknown')",
  )
    .bind(
      "child-older-release",
      lease.context.userId,
      lease.connectionId,
      "run-older-release",
      "run-older-release",
    )
    .run();
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () =>
      provider(async () => {
        throw new Error("No provider read after recent folder completion");
      }),
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT stage FROM sync_states WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, lease.syncStateId)
      .first("stage"),
  ).toBe("discovery_complete");
  expect(
    await env.DB.prepare(
      "SELECT stage FROM sync_states WHERE user_id=? AND id='older-older-release'",
    )
      .bind(lease.context.userId)
      .first("stage"),
  ).toBe("queued");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND sync_state_id='older-older-release' AND type='discover' AND status='ready'",
    )
      .bind(lease.context.userId)
      .first("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT stage FROM import_runs WHERE user_id=? AND id='run-older-release'",
    )
      .bind(lease.context.userId)
      .first("stage"),
  ).toBe("discovering_older");
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-04 hourly sync resumes each folder from its saved opaque delta URL", async () => {
  const lease = await claimed("hourly-resume");
  const folderId = "inbox-folder";
  const stateId = "folder-hourly-resume";
  const prior = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=prior`;
  const next = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=next`;
  await seedLiveFolder(lease, stateId, folderId, prior);
  await env.DB.prepare(
    "UPDATE sync_states SET stage='idle' WHERE user_id=? AND id IN (?,?)",
  )
    .bind(lease.context.userId, lease.syncStateId, stateId)
    .run();
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () =>
      provider(async () => {
        throw new Error("No provider request while scheduling hourly folders");
      }),
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT stage FROM sync_states WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, stateId)
      .first("stage"),
  ).toBe("queued");
  const ready = await env.DB.prepare(
    "SELECT id FROM jobs WHERE user_id=? AND sync_state_id=? AND type='sync' AND status='ready'",
  )
    .bind(lease.context.userId, lease.syncStateId)
    .first<{ id: string }>();
  if (!ready) throw new Error("Hourly continuation missing");
  const nextLease = await createJobStore(env.DB, {
    processingReview: null,
    policy,
  }).claim(ready.id);
  if (!nextLease) throw new Error("Hourly continuation not claimable");
  let requested = 0;
  const graph: OutlookGraphDiscoveryPort = {
    ...provider(async () => {
      throw new Error("Inventory is complete");
    }),
    deltaFolder: async (input) => {
      requested++;
      expect(input.folderId).toBe(folderId);
      expect(input.continuationLink).toBe(prior);
      return { ids: [], folderRemovedIds: [], deltaLink: next };
    },
  };
  const secondMeter = createInvocationDatabase(env.DB, 40);
  const second = createOutlookJobRunner(secondMeter.db, {
    open: async () => graph,
    remainingStatements: secondMeter.remainingStatements,
  });
  expect(
    await second.run(nextLease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(requested).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT stage,history_cursor FROM sync_states WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, stateId)
      .first(),
  ).toEqual({ stage: "idle", history_cursor: next });
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  expect(secondMeter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-05 expired delta performs bounded range recovery before acquiring a new folder token", async () => {
  const lease = await claimed("range-recovery");
  const folderId = "archive-folder";
  const stateId = "folder-range-recovery";
  const expired = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=expired`;
  const fresh = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=fresh`;
  await seedLiveFolder(lease, stateId, folderId, expired);
  const run = async (job: JobLease, graph: OutlookGraphDiscoveryPort) => {
    const meter = createInvocationDatabase(env.DB, 40);
    const runner = createOutlookJobRunner(meter.db, {
      open: async () => graph,
      remainingStatements: meter.remainingStatements,
    });
    const outcome = await runner.run(job, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    });
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
    return outcome;
  };
  const base = provider(async () => {
    throw new Error("Inventory is complete");
  });
  expect(
    await run(lease, {
      ...base,
      deltaFolder: async () => {
        throw new DiscoveryError("HISTORY_EXPIRED");
      },
    }),
  ).toEqual({ kind: "completed" });
  const claimContinuation = async () => {
    const ready = await env.DB.prepare(
      "SELECT id FROM jobs WHERE user_id=? AND sync_state_id=? AND type='sync' AND status='ready' ORDER BY id LIMIT 1",
    )
      .bind(lease.context.userId, lease.syncStateId)
      .first<{ id: string }>();
    if (!ready) throw new Error("Recovery continuation missing");
    const nextLease = await createJobStore(env.DB, {
      processingReview: null,
      policy,
    }).claim(ready.id);
    if (!nextLease) throw new Error("Recovery continuation not claimable");
    return nextLease;
  };
  let listed = 0;
  expect(
    await run(await claimContinuation(), {
      ...base,
      listFolder: async (input) => {
        listed++;
        expect(input.folderId).toBe(folderId);
        expect(input.range.startMs).toBe(
          Date.parse("2025-10-12T00:00:00.000Z"),
        );
        expect(input.range.cutoffMs).toBe(
          Date.parse("2026-10-13T00:00:00.000Z"),
        );
        return { ids: [] };
      },
    }),
  ).toEqual({ kind: "completed" });
  expect(listed).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT stage FROM sync_states WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, stateId)
      .first("stage"),
  ).toBe("recovering_delta");
  expect(
    await run(await claimContinuation(), {
      ...base,
      deltaFolder: async (input) => {
        expect(input.continuationLink).toBeUndefined();
        return { ids: [], folderRemovedIds: [], deltaLink: fresh };
      },
    }),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT stage,history_cursor FROM sync_states WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, stateId)
      .first(),
  ).toEqual({ stage: "idle", history_cursor: fresh });
});

it("OUTLOOK-04 a stale folder CAS cannot queue source work or settle the losing lease", async () => {
  const lease = await claimed("stale-folder-cas");
  const folderId = "inbox-folder";
  const stateId = "folder-stale-cas";
  const messageId = "immutable+stale/=";
  const deltaLink = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=fresh`;
  await seedLiveFolder(lease, stateId, folderId);
  const graph: OutlookGraphDiscoveryPort = {
    ...provider(async () => {
      throw new Error("Inventory is complete");
    }),
    deltaFolder: async () => ({
      ids: [messageId],
      folderRemovedIds: [],
      deltaLink,
    }),
    metadata: async (id) => {
      await env.DB.prepare(
        "UPDATE sync_states SET discovery_version=discovery_version+1 WHERE user_id=? AND id=?",
      )
        .bind(lease.context.userId, stateId)
        .run();
      return {
        id,
        parentFolderId: folderId,
        receivedAtMs: Date.parse("2026-10-12T12:00:00.000Z"),
        available: true,
        excluded: false,
        candidate: "unknown" as const,
      };
    },
  };
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () => graph,
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "retry", code: "transient" });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM source_messages WHERE user_id=? AND connection_id=?",
    )
      .bind(lease.context.userId, lease.connectionId)
      .first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT status FROM jobs WHERE user_id=? AND id=?")
      .bind(lease.context.userId, lease.jobId)
      .first("status"),
  ).toBe("leased");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND type='source-extract'",
    )
      .bind(lease.context.userId)
      .first("n"),
  ).toBe(0);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-05 Graph 429 durably defers a folder without consuming a job failure attempt or its cursor", async () => {
  const lease = await claimed("rate-limited-folder");
  const folderId = "inbox-folder";
  const stateId = "folder-rate-limited";
  const prior = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=prior`;
  await seedLiveFolder(lease, stateId, folderId, prior);
  const before = Date.now();
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () => ({
      ...provider(async () => {
        throw new Error("Inventory is complete");
      }),
      deltaFolder: async (input) => {
        expect(input.continuationLink).toBe(prior);
        throw new DiscoveryError("RATE_LIMITED", 60_000);
      },
    }),
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT stage,page_token,history_cursor,retry_at FROM sync_states WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, stateId)
      .first(),
  ).toEqual({
    stage: "queued",
    page_token: null,
    history_cursor: prior,
    retry_at: expect.any(Number),
  });
  expect(
    await env.DB.prepare(
      "SELECT status,retry_count FROM jobs WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, lease.jobId)
      .first(),
  ).toEqual({ status: "completed", retry_count: lease.attempt });
  const continuation = await env.DB.prepare(
    "SELECT status,dispatch_at FROM jobs WHERE user_id=? AND sync_state_id=? AND type='sync' AND id<>?",
  )
    .bind(lease.context.userId, lease.syncStateId, lease.jobId)
    .first<{ status: string; dispatch_at: number }>();
  expect(continuation?.status).toBe("ready");
  expect(continuation?.dispatch_at).toBeGreaterThanOrEqual(before + 60_000);
  expect(continuation?.dispatch_at).toBeLessThanOrEqual(Date.now() + 60_000);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM source_messages WHERE user_id=? AND connection_id=?",
    )
      .bind(lease.context.userId, lease.connectionId)
      .first("n"),
  ).toBe(0);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-04 initial live delta admits only messages in the approved import interval", async () => {
  const lease = await claimed("live-approved-range");
  const folderId = "inbox-folder";
  const stateId = "folder-live-approved-range";
  const outsideId = "immutable+old/=";
  const insideId = "immutable+recent/=";
  const deltaLink = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=approved`;
  await seedLiveFolder(lease, stateId, folderId);
  const graph: OutlookGraphDiscoveryPort = {
    ...provider(async () => {
      throw new Error("Inventory is complete");
    }),
    deltaFolder: async () => ({
      ids: [outsideId, insideId],
      folderRemovedIds: [],
      deltaLink,
    }),
    metadata: async (id) => ({
      id,
      parentFolderId: folderId,
      receivedAtMs: Date.parse(
        id === outsideId
          ? "2025-10-11T23:59:59.000Z"
          : "2026-10-12T12:00:00.000Z",
      ),
      available: true,
      excluded: false,
      candidate: "unknown",
    }),
  };
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () => graph,
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT provider_message_id FROM source_messages WHERE user_id=? AND connection_id=?",
    )
      .bind(lease.context.userId, lease.connectionId)
      .all(),
  ).toMatchObject({ results: [{ provider_message_id: insideId }] });
  expect(
    await env.DB.prepare(
      "SELECT provider_message_id,candidate_kind FROM discovery_seen_refs WHERE user_id=? AND sync_state_id=? ORDER BY provider_message_id",
    )
      .bind(lease.context.userId, stateId)
      .all(),
  ).toMatchObject({
    results: [
      { provider_message_id: outsideId, candidate_kind: "excluded" },
      { provider_message_id: insideId, candidate_kind: "unknown" },
    ],
  });
  expect(
    await env.DB.prepare(
      "SELECT history_cursor FROM sync_states WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, stateId)
      .first("history_cursor"),
  ).toBe(deltaLink);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-05 a rate-paused recent folder cannot complete its parent or release the older slice", async () => {
  const lease = await claimed("paused-recent-child", "recent");
  const folderId = "archive-folder";
  await env.DB.prepare(
    "INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id,excluded_folder_ids) VALUES(?,?,?,'root',NULL,1,NULL,'complete',?,?)",
  )
    .bind(
      lease.context.userId,
      lease.connectionId,
      lease.generation,
      crypto.randomUUID(),
      defaultExcludedFolderIds,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO outlook_folders(user_id,connection_id,generation,folder_id,parent_folder_id,child_folder_count,is_hidden) VALUES(?,?,?,?,'provider-root',0,0)",
  )
    .bind(lease.context.userId, lease.connectionId, lease.generation, folderId)
    .run();
  await env.DB.prepare(
    "INSERT INTO sync_states(id,user_id,connection_id,import_run_id,scope_key,sync_kind,run_key,slice_key,frozen_start,frozen_cutoff,stage,coverage_code,consecutive_failures) VALUES(?,?,?,? ,?,'backfill',?,'recent','2026-09-13T00:00:00.000Z','2026-10-13T00:00:00.000Z','paused_rate','candidate_unknown',5)",
  )
    .bind(
      "folder-paused-recent-child",
      lease.context.userId,
      lease.connectionId,
      `run-paused-recent-child`,
      `outlook:${lease.generation}:${folderId}`,
      `run-paused-recent-child`,
    )
    .run();
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () =>
      provider(async () => {
        throw new Error("No provider read while a folder is paused");
      }),
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT stage FROM sync_states WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, lease.syncStateId)
      .first("stage"),
  ).toBe("paused_rate");
  expect(
    await env.DB.prepare(
      "SELECT stage FROM sync_states WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, "older-paused-recent-child")
      .first("stage"),
  ).toBe("waiting_recent");
  expect(
    await env.DB.prepare(
      "SELECT stage FROM import_runs WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, "run-paused-recent-child")
      .first("stage"),
  ).not.toBe("processing_pending");
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-02 resolves exact well-known alias IDs and skips excluded roots during inventory", async () => {
  const lease = await claimed("excluded-inventory");
  const aliases = {
    junkemail: "a-junk-folder",
    deleteditems: "b-deleted-folder",
    drafts: "c-drafts-folder",
    sentitems: "d-sent-folder",
  } as const;
  const lookups: string[] = [];
  const graph: OutlookGraphDiscoveryPort = {
    ...provider(async () => ({
      folders: [
        {
          id: aliases.junkemail,
          parentFolderId: "provider-root",
          displayName: "Localized A",
          childFolderCount: 1,
          isHidden: false,
        },
        {
          id: "z-archive-folder",
          parentFolderId: "provider-root",
          displayName: "Localized B",
          childFolderCount: 1,
          isHidden: false,
        },
      ],
    })),
    folder: async (alias) => {
      lookups.push(alias);
      return {
        id: aliases[alias as keyof typeof aliases],
        parentFolderId: "provider-root",
        displayName: "Name is not an exclusion key",
        childFolderCount: 1,
        isHidden: false,
      };
    },
  };
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () => graph,
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(lookups).toEqual(["junkemail", "deleteditems", "drafts", "sentitems"]);
  const root = await env.DB.prepare(
    "SELECT excluded_folder_ids FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND scope_key='root'",
  )
    .bind(lease.context.userId, lease.connectionId, lease.generation)
    .first<{ excluded_folder_ids: string }>();
  expect(JSON.parse(root?.excluded_folder_ids ?? "null")).toEqual([
    aliases.junkemail,
    aliases.deleteditems,
    aliases.drafts,
    aliases.sentitems,
  ]);
  expect(
    await env.DB.prepare(
      "SELECT folder_id FROM outlook_folders WHERE user_id=? AND connection_id=? AND generation=?",
    )
      .bind(lease.context.userId, lease.connectionId, lease.generation)
      .all(),
  ).toMatchObject({ results: [{ folder_id: "z-archive-folder" }] });
  expect(
    await env.DB.prepare(
      "SELECT scope_key FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND scope_key LIKE 'folder:%'",
    )
      .bind(lease.context.userId, lease.connectionId, lease.generation)
      .all(),
  ).toMatchObject({ results: [{ scope_key: "folder:z-archive-folder" }] });
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-02 existing excluded folder descendants cannot seed backfill work", async () => {
  const lease = await claimed("excluded-existing", "recent");
  const exclusions = [
    "a-junk-folder",
    "b-deleted-folder",
    "c-drafts-folder",
    "d-sent-folder",
  ];
  await env.DB.prepare(
    "INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id,excluded_folder_ids) VALUES(?,?,?,'root',NULL,1,NULL,'complete',?,?)",
  )
    .bind(
      lease.context.userId,
      lease.connectionId,
      lease.generation,
      crypto.randomUUID(),
      JSON.stringify(exclusions),
    )
    .run();
  for (const [folderId, parentFolderId] of [
    ["a-junk-folder", "provider-root"],
    ["a-junk-child", "a-junk-folder"],
    ["z-archive-folder", "provider-root"],
  ]) {
    await env.DB.prepare(
      "INSERT INTO outlook_folders(user_id,connection_id,generation,folder_id,parent_folder_id,child_folder_count,is_hidden) VALUES(?,?,?,?,?,0,0)",
    )
      .bind(
        lease.context.userId,
        lease.connectionId,
        lease.generation,
        folderId,
        parentFolderId,
      )
      .run();
  }
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () =>
      provider(async () => {
        throw new Error("Inventory is complete");
      }),
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT scope_key FROM sync_states WHERE user_id=? AND scope_key LIKE 'outlook:%' ORDER BY scope_key",
    )
      .bind(lease.context.userId)
      .all(),
  ).toMatchObject({
    results: [{ scope_key: "outlook:1:z-archive-folder" }],
  });
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-02 cannot begin inventory when a required exclusion alias is unavailable", async () => {
  const lease = await claimed("missing-exclusion-alias");
  let inventoryCalls = 0;
  const graph: OutlookGraphDiscoveryPort = {
    ...provider(async () => {
      inventoryCalls++;
      return { folders: [] };
    }),
    folder: async () => {
      throw new DiscoveryError("SOURCE_UNAVAILABLE");
    },
  };
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () => graph,
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "terminal", code: "unsupported" });
  expect(inventoryCalls).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=?",
    )
      .bind(lease.context.userId, lease.connectionId, lease.generation)
      .first("n"),
  ).toBe(0);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-02 cold alias resolution makes durable progress under the real shared job checkpoint budget", async () => {
  const meter = createInvocationDatabase(env.DB, 40);
  const lease = await claimed("cold-alias-budget", "live", meter.db);
  const jobs = createJobStore(meter.db, { processingReview: null, policy });
  const checkpoint = () => jobs.checkpoint(lease);
  expect(await checkpoint()).toBe(true);
  const lookedUp: string[] = [];
  const graph: OutlookGraphDiscoveryPort = {
    ...provider(async () => ({ folders: [] })),
    folder: async (alias) => {
      lookedUp.push(alias);
      return {
        id: `qa-${alias}-folder`,
        parentFolderId: "provider-root",
        displayName: "Synthetic",
        childFolderCount: 0,
        isHidden: false,
      };
    },
  };
  const runner = createOutlookJobRunner(meter.db, {
    open: async () => graph,
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint,
    }),
  ).toEqual({ kind: "completed" });
  expect(lookedUp).toEqual([
    "junkemail",
    "deleteditems",
    "drafts",
    "sentitems",
  ]);
  const root = await env.DB.prepare(
    "SELECT excluded_folder_ids FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND scope_key='root'",
  )
    .bind(lease.context.userId, lease.connectionId, lease.generation)
    .first<{ excluded_folder_ids: string }>();
  expect(JSON.parse(root?.excluded_folder_ids ?? "null")).toEqual([
    "qa-junkemail-folder",
    "qa-deleteditems-folder",
    "qa-drafts-folder",
    "qa-sentitems-folder",
  ]);
  expect(
    await env.DB.prepare("SELECT status FROM jobs WHERE user_id=? AND id=?")
      .bind(lease.context.userId, lease.jobId)
      .first("status"),
  ).toBe("completed");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND connection_id=? AND sync_state_id=? AND status='ready'",
    )
      .bind(lease.context.userId, lease.connectionId, lease.syncStateId)
      .first("n"),
  ).toBe(1);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-05 inventory 429 retains its opaque cursor and schedules a future job without a failure attempt", async () => {
  const lease = await claimed("rate-limited-inventory");
  const prior =
    "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=prior%2B%2F%3D";
  await env.DB.prepare(
    "INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id,excluded_folder_ids) VALUES(?,?,?,'root',NULL,1,?,'pending',?,?)",
  )
    .bind(
      lease.context.userId,
      lease.connectionId,
      lease.generation,
      prior,
      crypto.randomUUID(),
      defaultExcludedFolderIds,
    )
    .run();
  const before = Date.now();
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () =>
      provider(async (input) => {
        expect(input.nextLink).toBe(prior);
        throw new DiscoveryError("RATE_LIMITED", 60_000);
      }),
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT version,next_link FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND scope_key='root'",
    )
      .bind(lease.context.userId, lease.connectionId, lease.generation)
      .first(),
  ).toEqual({ version: 1, next_link: prior });
  expect(
    await env.DB.prepare(
      "SELECT status,retry_count FROM jobs WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, lease.jobId)
      .first(),
  ).toEqual({ status: "completed", retry_count: lease.attempt });
  const continuation = await env.DB.prepare(
    "SELECT dispatch_at FROM jobs WHERE user_id=? AND connection_id=? AND sync_state_id=? AND status='ready' AND id<>?",
  )
    .bind(
      lease.context.userId,
      lease.connectionId,
      lease.syncStateId,
      lease.jobId,
    )
    .first<{ dispatch_at: number }>();
  expect(continuation?.dispatch_at).toBeGreaterThanOrEqual(before + 60_000);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-05 alias lookup 429 defers before inventory without consuming a failure attempt", async () => {
  const lease = await claimed("rate-limited-alias");
  let inventoryCalls = 0;
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () => ({
      ...provider(async () => {
        inventoryCalls++;
        return { folders: [] };
      }),
      folder: async () => {
        throw new DiscoveryError("RATE_LIMITED", 30_000);
      },
    }),
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(inventoryCalls).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT status,retry_count FROM jobs WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, lease.jobId)
      .first(),
  ).toEqual({ status: "completed", retry_count: lease.attempt });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND connection_id=? AND sync_state_id=? AND status='ready' AND id<>?",
    )
      .bind(
        lease.context.userId,
        lease.connectionId,
        lease.syncStateId,
        lease.jobId,
      )
      .first("n"),
  ).toBe(1);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("OUTLOOK-05 an over-day or unusable Graph Retry-After pauses rate service without an early retry or budget label", async () => {
  for (const [suffix, delayMs] of [
    ["25h", 25 * 60 * 60 * 1000],
    ["transport-sentinel", 86_400_001],
  ] as const) {
    const lease = await claimed(`long-rate-floor-${suffix}`, "recent");
    const prior =
      "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=long-rate-prior";
    await env.DB.prepare(
      "INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id,excluded_folder_ids) VALUES(?,?,?,'root',NULL,1,?,'pending',?,?)",
    )
      .bind(
        lease.context.userId,
        lease.connectionId,
        lease.generation,
        prior,
        crypto.randomUUID(),
        defaultExcludedFolderIds,
      )
      .run();
    const meter = createInvocationDatabase(env.DB, 40);
    const runner = createOutlookJobRunner(meter.db, {
      open: async () =>
        provider(async () => {
          throw new DiscoveryError("RATE_LIMITED", delayMs);
        }),
      remainingStatements: meter.remainingStatements,
    });
    expect(
      await runner.run(lease, {
        signal: new AbortController().signal,
        checkpoint: async () => true,
      }),
    ).toEqual({ kind: "completed" });
    expect(
      await env.DB.prepare(
        "SELECT status,outcome_code,retry_count FROM jobs WHERE user_id=? AND id=?",
      )
        .bind(lease.context.userId, lease.jobId)
        .first(),
    ).toEqual({
      status: "completed",
      outcome_code: "rate_paused",
      retry_count: lease.attempt,
    });
    expect(
      await env.DB.prepare(
        "SELECT version,next_link FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND scope_key='root'",
      )
        .bind(lease.context.userId, lease.connectionId, lease.generation)
        .first(),
    ).toEqual({ version: 1, next_link: prior });
    expect(
      await env.DB.prepare(
        "SELECT stage FROM sync_states WHERE user_id=? AND id=?",
      )
        .bind(lease.context.userId, lease.syncStateId)
        .first("stage"),
    ).toBe("paused_rate");
    expect(
      await env.DB.prepare(
        "SELECT stage FROM import_runs WHERE user_id=? AND id=?",
      )
        .bind(lease.context.userId, `run-long-rate-floor-${suffix}`)
        .first("stage"),
    ).toBe("paused_rate");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND connection_id=? AND sync_state_id=? AND status='ready' AND id<>?",
      )
        .bind(
          lease.context.userId,
          lease.connectionId,
          lease.syncStateId,
          lease.jobId,
        )
        .first("n"),
    ).toBe(0);
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  }
});

it("INT-5/G1 rediscovery after reconnect cannot enqueue a second extraction job for an already-queued source", async () => {
  const lease = await claimed("cross-generation", "live", env.DB, 2);
  const folderId = "inbox-folder";
  const messageId = "immutable-cross-generation";
  const deltaLink = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=cross-generation`;
  await seedLiveFolder(lease, "folder-cross-generation", folderId);
  // Generation 1 already discovered, queued and extracted this message.
  await env.DB.prepare(
    "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,processing_status,generation,available) VALUES('source-cross-generation',?,?,?,?,'processed',1,1)",
  )
    .bind(
      lease.context.userId,
      lease.connectionId,
      messageId,
      Date.parse("2026-10-12T12:00:00.000Z"),
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at) VALUES('extract-generation-1',?,?,?,1,'source-extract',?,'completed',0)",
  )
    .bind(
      lease.context.userId,
      lease.connectionId,
      lease.consentId,
      await sourceKey(lease.context.userId, lease.connectionId, messageId, 1),
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO discovery_source_jobs(user_id,job_id,source_message_id) VALUES(?,'extract-generation-1','source-cross-generation')",
  )
    .bind(lease.context.userId)
    .run();
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () => ({
      ...provider(async () => {
        throw new Error("Inventory is complete");
      }),
      deltaFolder: async () => ({
        ids: [messageId],
        folderRemovedIds: [],
        deltaLink,
      }),
      metadata: async (id) => ({
        id,
        parentFolderId: folderId,
        receivedAtMs: Date.parse("2026-10-12T12:00:00.000Z"),
        available: true,
        excluded: false,
        candidate: "matched",
      }),
    }),
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT stage,history_cursor FROM sync_states WHERE user_id=? AND id='folder-cross-generation'",
    )
      .bind(lease.context.userId)
      .first(),
  ).toEqual({ stage: "idle", history_cursor: deltaLink });
  expect(
    await env.DB.prepare(
      "SELECT j.id FROM jobs j JOIN discovery_source_jobs d ON d.user_id=j.user_id AND d.job_id=j.id WHERE j.user_id=? AND j.type='source-extract' AND d.source_message_id='source-cross-generation'",
    )
      .bind(lease.context.userId)
      .all(),
  ).toMatchObject({ results: [{ id: "extract-generation-1" }] });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND type='source-extract'",
    )
      .bind(lease.context.userId)
      .first("n"),
  ).toBe(1);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

const reviewedConsentDrift = {
  "digest-missing":
    "UPDATE processing_consents SET accepted_configuration_digest=NULL WHERE user_id=?",
  destination:
    "UPDATE ai_settings SET provider_id='unreviewed-destination' WHERE user_id=?",
  disclosure: "UPDATE ai_settings SET consent_version=2 WHERE user_id=?",
  credential:
    "UPDATE connections SET credential_ciphertext=NULL,credential_key_version=NULL WHERE user_id=?",
} as const;

it.each(
  Object.keys(reviewedConsentDrift) as (keyof typeof reviewedConsentDrift)[],
)(
  "INT-5/G2 %s drift before the run stops Outlook discovery before any Graph read",
  async (drift) => {
    const lease = await claimed(`g2-before-${drift}`);
    await seedLiveFolder(lease, `folder-g2-before-${drift}`, "inbox-folder");
    await env.DB.prepare(reviewedConsentDrift[drift])
      .bind(lease.context.userId)
      .run();
    let reads = 0;
    const meter = createInvocationDatabase(env.DB, 40);
    const runner = createOutlookJobRunner(meter.db, {
      open: async () => ({
        ...provider(async () => {
          reads++;
          return { folders: [] };
        }),
        deltaFolder: async () => {
          reads++;
          return {
            ids: [],
            folderRemovedIds: [],
            deltaLink:
              "https://graph.microsoft.com/v1.0/me/mailFolders/inbox-folder/messages/delta?$deltatoken=g2-before",
          };
        },
      }),
      remainingStatements: meter.remainingStatements,
    });
    expect(
      await runner.run(lease, {
        signal: new AbortController().signal,
        checkpoint: async () => true,
      }),
    ).toEqual({ kind: "paused", code: "auth" });
    expect(reads).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT stage,discovery_version FROM sync_states WHERE user_id=? AND id=?",
      )
        .bind(lease.context.userId, `folder-g2-before-${drift}`)
        .first(),
    ).toEqual({ stage: "queued", discovery_version: 0 });
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  },
);

it.each(
  Object.keys(reviewedConsentDrift) as (keyof typeof reviewedConsentDrift)[],
)(
  "INT-5/G2 %s drift during a Graph delta read cannot stage sources or advance the folder cursor",
  async (drift) => {
    const lease = await claimed(`g2-during-${drift}`);
    const folderId = "inbox-folder";
    const stateId = `folder-g2-during-${drift}`;
    await seedLiveFolder(lease, stateId, folderId);
    const meter = createInvocationDatabase(env.DB, 40);
    const runner = createOutlookJobRunner(meter.db, {
      open: async () => ({
        ...provider(async () => {
          throw new Error("Inventory is complete");
        }),
        deltaFolder: async () => {
          await env.DB.prepare(reviewedConsentDrift[drift])
            .bind(lease.context.userId)
            .run();
          return {
            ids: ["g2-message"],
            folderRemovedIds: [],
            deltaLink: `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=g2`,
          };
        },
        metadata: async (id) => ({
          id,
          parentFolderId: folderId,
          receivedAtMs: Date.parse("2026-10-12T12:00:00.000Z"),
          available: true,
          excluded: false,
          candidate: "matched",
        }),
      }),
      remainingStatements: meter.remainingStatements,
    });
    expect(
      await runner.run(lease, {
        signal: new AbortController().signal,
        checkpoint: async () => true,
      }),
    ).not.toEqual({ kind: "completed" });
    expect(
      await env.DB.prepare(
        "SELECT stage,history_cursor,discovery_version FROM sync_states WHERE user_id=? AND id=?",
      )
        .bind(lease.context.userId, stateId)
        .first(),
    ).toEqual({ stage: "queued", history_cursor: null, discovery_version: 0 });
    expect(
      await env.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM source_messages WHERE user_id=?1) AS sources,(SELECT COUNT(*) FROM jobs WHERE user_id=?1 AND type='source-extract') AS extractions,(SELECT COUNT(*) FROM discovery_seen_refs WHERE user_id=?1) AS refs",
      )
        .bind(lease.context.userId)
        .first(),
    ).toEqual({ sources: 0, extractions: 0, refs: 0 });
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  },
);

it("INT-5/G3 Outlook backfill writes folder enumerated/matched/unknown counters and the run's discovered count", async () => {
  const lease = await claimed("g3-counters", "recent");
  const folderId = "receipt-folder";
  await env.DB.prepare(
    "INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id,excluded_folder_ids) VALUES(?,?,?,'root',NULL,1,NULL,'complete',?,?)",
  )
    .bind(
      lease.context.userId,
      lease.connectionId,
      lease.generation,
      crypto.randomUUID(),
      defaultExcludedFolderIds,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO outlook_folders(user_id,connection_id,generation,folder_id,parent_folder_id,child_folder_count,is_hidden) VALUES(?,?,?,?,'provider-root',0,0)",
  )
    .bind(lease.context.userId, lease.connectionId, lease.generation, folderId)
    .run();
  await env.DB.prepare(
    "INSERT INTO sync_states(id,user_id,connection_id,import_run_id,scope_key,sync_kind,run_key,slice_key,frozen_start,frozen_cutoff,stage,coverage_code) VALUES('child-g3-counters',?,?,'run-g3-counters',?,'backfill','run-g3-counters','recent','2026-09-13T00:00:00.000Z','2026-10-13T00:00:00.000Z','queued','candidate_unknown')",
  )
    .bind(
      lease.context.userId,
      lease.connectionId,
      `outlook:${lease.generation}:${folderId}`,
    )
    .run();
  const inRange = Date.parse("2026-10-01T12:00:00.000Z");
  const references = {
    "g3-matched": { receivedAtMs: inRange, candidate: "matched" },
    "g3-unknown": { receivedAtMs: inRange, candidate: "unknown" },
    "g3-outside": {
      receivedAtMs: Date.parse("2026-08-01T12:00:00.000Z"),
      candidate: "matched",
    },
  } as const;
  const graph: OutlookGraphDiscoveryPort = {
    ...provider(async () => {
      throw new Error("Inventory is complete");
    }),
    listFolder: async (input) => {
      expect(input.folderId).toBe(folderId);
      return { ids: Object.keys(references) };
    },
    metadata: async (id) => ({
      id,
      parentFolderId: folderId,
      available: true,
      excluded: false,
      ...references[id as keyof typeof references],
    }),
  };
  const control = {
    signal: new AbortController().signal,
    checkpoint: async () => true,
  };
  const page = createInvocationDatabase(env.DB, 40);
  expect(
    await createOutlookJobRunner(page.db, {
      open: async () => graph,
      remainingStatements: page.remainingStatements,
    }).run(lease, control),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT stage,enumerated_count,matched_count,unknown_count FROM sync_states WHERE user_id=? AND id='child-g3-counters'",
    )
      .bind(lease.context.userId)
      .first(),
  ).toEqual({
    stage: "discovery_complete",
    enumerated_count: 3,
    matched_count: 1,
    unknown_count: 1,
  });
  expect(page.executedStatements()).toBeLessThanOrEqual(40);
  const continuation = await env.DB.prepare(
    "SELECT id FROM jobs WHERE user_id=? AND dedupe_key=?",
  )
    .bind(lease.context.userId, `outlook:page:${lease.jobId}`)
    .first<string>("id");
  if (!continuation) throw new Error("Missing Outlook page continuation");
  const next = await createJobStore(env.DB, {
    processingReview: null,
    policy,
  }).claim(continuation);
  if (!next) throw new Error("Outlook page continuation lease unavailable");
  const parent = createInvocationDatabase(env.DB, 40);
  expect(
    await createOutlookJobRunner(parent.db, {
      open: async () => graph,
      remainingStatements: parent.remainingStatements,
    }).run(next, control),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT stage,discovered_count FROM import_runs WHERE user_id=? AND id='run-g3-counters'",
    )
      .bind(lease.context.userId)
      .first(),
  ).toEqual({ stage: "discovering_older", discovered_count: 2 });
  expect(parent.executedStatements()).toBeLessThanOrEqual(40);
});

async function seedPendingInventory(lease: JobLease, nextLink: string) {
  await env.DB.prepare(
    "INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id,excluded_folder_ids) VALUES(?,?,?,'root',NULL,1,?,'pending',?,?)",
  )
    .bind(
      lease.context.userId,
      lease.connectionId,
      lease.generation,
      nextLink,
      crypto.randomUUID(),
      defaultExcludedFolderIds,
    )
    .run();
}

it("INT-5/G4 consecutive inventory 429s pause rate service at the shared failure cap instead of deferring forever", async () => {
  let lease = await claimed("g4-inventory-cap", "recent");
  await seedPendingInventory(
    lease,
    "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=g4-cap",
  );
  const outcomes: string[] = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    const meter = createInvocationDatabase(env.DB, 40);
    const runner = createOutlookJobRunner(meter.db, {
      open: async () =>
        provider(async () => {
          throw new DiscoveryError("RATE_LIMITED", 60_000);
        }),
      remainingStatements: meter.remainingStatements,
    });
    expect(
      await runner.run(lease, {
        signal: new AbortController().signal,
        checkpoint: async () => true,
      }),
    ).toEqual({ kind: "completed" });
    expect(meter.executedStatements()).toBeLessThanOrEqual(40);
    outcomes.push(
      (await env.DB.prepare(
        "SELECT outcome_code FROM jobs WHERE user_id=? AND id=?",
      )
        .bind(lease.context.userId, lease.jobId)
        .first<string>("outcome_code")) ?? "missing",
    );
    const continuation = await env.DB.prepare(
      "SELECT id FROM jobs WHERE user_id=? AND sync_state_id=? AND status='ready' AND id<>?",
    )
      .bind(lease.context.userId, lease.syncStateId, lease.jobId)
      .first<string>("id");
    if (!continuation) break;
    await env.DB.prepare(
      "UPDATE jobs SET dispatch_at=0 WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, continuation)
      .run();
    const next = await createJobStore(env.DB, {
      processingReview: null,
      policy,
    }).claim(continuation);
    if (!next) throw new Error("Outlook rate continuation lease unavailable");
    lease = next;
  }
  expect(outcomes).toEqual([
    "rate_deferred",
    "rate_deferred",
    "rate_deferred",
    "rate_deferred",
    "rate_paused",
  ]);
  expect(
    await env.DB.prepare(
      "SELECT (SELECT stage FROM sync_states WHERE user_id=?1 AND id='ss-g4-inventory-cap') AS slice,(SELECT stage FROM import_runs WHERE user_id=?1 AND id='run-g4-inventory-cap') AS run,(SELECT COUNT(*) FROM jobs WHERE user_id=?1 AND status='ready') AS ready",
    )
      .bind(lease.context.userId)
      .first(),
  ).toEqual({ slice: "paused_rate", run: "paused_rate", ready: 0 });
});

it("INT-5/G4 a folder already at the failure cap pauses on the next 429 without overflowing its counter", async () => {
  const lease = await claimed("g4-folder-cap");
  const folderId = "inbox-folder";
  const stateId = "folder-g4-cap";
  const prior = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=g4-cap`;
  await seedLiveFolder(lease, stateId, folderId, prior);
  await env.DB.prepare(
    "UPDATE sync_states SET consecutive_failures=5 WHERE user_id=? AND id=?",
  )
    .bind(lease.context.userId, stateId)
    .run();
  const meter = createInvocationDatabase(env.DB, 40);
  const runner = createOutlookJobRunner(meter.db, {
    open: async () => ({
      ...provider(async () => {
        throw new Error("Inventory is complete");
      }),
      deltaFolder: async () => {
        throw new DiscoveryError("RATE_LIMITED", 60_000);
      },
    }),
    remainingStatements: meter.remainingStatements,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT stage,consecutive_failures,history_cursor,retry_at FROM sync_states WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, stateId)
      .first(),
  ).toEqual({
    stage: "paused_rate",
    consecutive_failures: 5,
    history_cursor: prior,
    retry_at: null,
  });
  expect(
    await env.DB.prepare(
      "SELECT outcome_code FROM jobs WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, lease.jobId)
      .first("outcome_code"),
  ).toBe("rate_paused");
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});

it("INT-5/G4 an over-day inventory Retry-After pauses within the same statement reservation as a short deferral", async () => {
  const lease = await claimed("g4-long-reservation", "recent");
  await seedPendingInventory(
    lease,
    "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=g4-long",
  );
  const meter = createInvocationDatabase(env.DB, 40);
  let limited = false;
  const runner = createOutlookJobRunner(meter.db, {
    open: async () =>
      provider(async () => {
        limited = true;
        throw new DiscoveryError("RATE_LIMITED", 25 * 60 * 60 * 1000);
      }),
    // After the 429 only a short deferral's reservation is left.
    remainingStatements: () =>
      limited
        ? Math.min(3, meter.remainingStatements())
        : meter.remainingStatements(),
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "completed" });
  expect(
    await env.DB.prepare(
      "SELECT outcome_code FROM jobs WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, lease.jobId)
      .first("outcome_code"),
  ).toBe("rate_paused");
});

it("INT-5/O5 Outlook statement shortfall before any Graph access returns retry/transient (OD-11 pin)", async () => {
  const lease = await claimed("o5-start-shortfall");
  await seedLiveFolder(lease, "folder-o5-start", "inbox-folder");
  let opens = 0;
  const runner = createOutlookJobRunner(env.DB, {
    open: async () => {
      opens++;
      return provider(async () => ({ folders: [] }));
    },
    remainingStatements: () => 19,
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "retry", code: "transient" });
  expect(opens).toBe(0);
  expect(
    await env.DB.prepare("SELECT status FROM jobs WHERE user_id=? AND id=?")
      .bind(lease.context.userId, lease.jobId)
      .first("status"),
  ).toBe("leased");
});

it("INT-5/O5 Outlook page-commit shortfall after Graph reads returns retry/transient without staging (OD-11 pin)", async () => {
  const lease = await claimed("o5-commit-shortfall");
  const folderId = "inbox-folder";
  const stateId = "folder-o5-commit";
  await seedLiveFolder(lease, stateId, folderId);
  const meter = createInvocationDatabase(env.DB, 40);
  let read = false;
  const runner = createOutlookJobRunner(meter.db, {
    open: async () => ({
      ...provider(async () => {
        throw new Error("Inventory is complete");
      }),
      deltaFolder: async () => ({
        ids: ["o5-message"],
        folderRemovedIds: [],
        deltaLink: `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=o5`,
      }),
      metadata: async (id) => {
        read = true;
        return {
          id,
          parentFolderId: folderId,
          receivedAtMs: Date.parse("2026-10-12T12:00:00.000Z"),
          available: true,
          excluded: false,
          candidate: "matched",
        };
      },
    }),
    // One reference needs 4 + 5 statements to commit; leave one short.
    remainingStatements: () =>
      read
        ? Math.min(8, meter.remainingStatements())
        : meter.remainingStatements(),
  });
  expect(
    await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).toEqual({ kind: "retry", code: "transient" });
  expect(
    await env.DB.prepare(
      "SELECT stage,history_cursor,discovery_version FROM sync_states WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, stateId)
      .first(),
  ).toEqual({ stage: "queued", history_cursor: null, discovery_version: 0 });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM source_messages WHERE user_id=?",
    )
      .bind(lease.context.userId)
      .first("n"),
  ).toBe(0);
});

it("INT-5/O5 a persistent Outlook statement shortfall exhausts the job at the retry cap (current OD-11 outcome)", async () => {
  let lease = await claimed("o5-retry-cap");
  await seedLiveFolder(lease, "folder-o5-cap", "inbox-folder");
  const jobs = createJobStore(env.DB, { processingReview: null, policy });
  const runner = createOutlookJobRunner(env.DB, {
    open: async () => {
      throw new Error("A budget shortfall must not open Graph");
    },
    remainingStatements: () => 19,
  });
  const settled: unknown[] = [];
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    expect(lease.attempt).toBe(attempt);
    const outcome = await runner.run(lease, {
      signal: new AbortController().signal,
      checkpoint: async () => true,
    });
    expect(outcome).toEqual({ kind: "retry", code: "transient" });
    expect(await jobs.finish(lease, outcome)).toBe(true);
    settled.push(
      await env.DB.prepare(
        "SELECT status,outcome_code FROM jobs WHERE user_id=? AND id=?",
      )
        .bind(lease.context.userId, lease.jobId)
        .first(),
    );
    if (attempt === policy.maxAttempts) break;
    await env.DB.prepare(
      "UPDATE jobs SET dispatch_at=0 WHERE user_id=? AND id=?",
    )
      .bind(lease.context.userId, lease.jobId)
      .run();
    const next = await jobs.claim(lease.jobId);
    if (!next) throw new Error("Outlook retry lease unavailable");
    lease = next;
  }
  // retry/transient consumes an attempt per shortfall; at the cap the job
  // store makes it terminal and nothing re-queues the mailbox sync state.
  expect(settled).toEqual([
    ...Array.from({ length: policy.maxAttempts - 1 }, () => ({
      status: "retry_wait",
      outcome_code: "transient",
    })),
    { status: "terminal", outcome_code: "attempts-exhausted" },
  ]);
  expect(await jobs.claim(lease.jobId)).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND sync_state_id=? AND status IN ('ready','retry_wait','leased')",
    )
      .bind(lease.context.userId, lease.syncStateId)
      .first("n"),
  ).toBe(0);
});
