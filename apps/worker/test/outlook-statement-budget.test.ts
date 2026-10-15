import { env } from "cloudflare:workers";
import type { JobLease, JobPolicy } from "@invoxim/core";
import { DiscoveryError } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import folderExclusionsMigration from "../../../packages/adapters/migrations/0004_outlook_folder_exclusions.sql?raw";
import type { OutlookGraphDiscoveryPort } from "../../../packages/adapters/src/discovery/outlook";
import { createOutlookJobRunner } from "../../../packages/adapters/src/discovery/outlook-job";
import { createOutlookFolderStore } from "../../../packages/adapters/src/discovery/outlook-state";
import { createJobStore } from "../../../packages/adapters/src/jobs/store";
import { OUTLOOK_AUTHORIZATION_SCOPES } from "../../../packages/adapters/src/mailbox/outlook-configuration";
import { createInvocationDatabase } from "../src/invocation-database";
import { installOnboardingQaHooks, owner } from "./onboarding-qa-fixture";

/**
 * G-40 evidence: exact D1 statement counts for the Outlook steps the T17
 * runners tuned to the 40-statement invocation budget. Self-contained (it
 * seeds a reviewed consent inline) so the same scenarios can be measured on
 * the T17 baseline. Counts are whole invocations as metered by
 * createInvocationDatabase.
 */
installOnboardingQaHooks();

beforeAll(async () => {
  await env.DB.prepare(folderExclusionsMigration).run();
});

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
const excluded = JSON.stringify([
  "qa-junk-folder",
  "qa-deleted-folder",
  "qa-drafts-folder",
  "qa-sent-folder",
]);
const overDay = 25 * 60 * 60 * 1000;
const folderId = "inbox-folder";

async function claimed(
  name: string,
  mode: "live" | "recent",
): Promise<JobLease> {
  const current = await owner(`qa-outlook-g40-${name}`, "outlook-mailbox", [
    ...OUTLOOK_AUTHORIZATION_SCOPES,
  ]);
  const userId = current.tenant.userId;
  await env.DB.prepare(
    "UPDATE connections SET provider='outlook',scheduling_state='active',next_sync_at=NULL WHERE user_id=? AND id='outlook-mailbox'",
  )
    .bind(userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO ai_settings(user_id,mode,provider_id,model_id,config_version,revision,consent_version,status) VALUES(?,'hosted','synthetic','synthetic-model','synthetic-v1',1,1,'active') ON CONFLICT(user_id) DO NOTHING",
  )
    .bind(userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized,accepted_configuration_digest) VALUES(?,?,'outlook-mailbox',1,'synthetic','local',1,0,1,?)",
  )
    .bind(`pc-${name}`, userId, "5".repeat(64))
    .run();
  await env.DB.prepare(
    "INSERT INTO import_runs(id,user_id,connection_id,consent_id,connection_generation,frozen_start,frozen_cutoff,timezone,request_fingerprint,started_at) VALUES(?,?,'outlook-mailbox',?,1,'2025-10-12T00:00:00.000Z','2026-10-13T00:00:00.000Z','UTC',?,0)",
  )
    .bind(`run-${name}`, userId, `pc-${name}`, `fingerprint-${name}`)
    .run();
  await env.DB.prepare(
    mode === "live"
      ? "INSERT INTO sync_states(id,user_id,connection_id,scope_key,sync_kind,run_key,slice_key,stage,coverage_code) VALUES(?,?,'outlook-mailbox','mailbox','incremental','live','live','queued','candidate_unknown')"
      : "INSERT INTO sync_states(id,user_id,connection_id,import_run_id,scope_key,sync_kind,run_key,slice_key,frozen_start,frozen_cutoff,stage,coverage_code) VALUES(?,?,'outlook-mailbox',?,'mailbox','backfill',?,'recent','2026-09-13T00:00:00.000Z','2026-10-13T00:00:00.000Z','queued','candidate_unknown')",
  )
    .bind(
      `ss-${name}`,
      userId,
      ...(mode === "live" ? [] : [`run-${name}`, `run-${name}`]),
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at) VALUES(?,?,'outlook-mailbox',?,1,?,?,?,'ready',0)",
  )
    .bind(
      `j-${name}`,
      userId,
      `pc-${name}`,
      `ss-${name}`,
      mode === "live" ? "sync" : "discover",
      `j-${name}`,
    )
    .run();
  const lease = await createJobStore(env.DB, { policy }).claim(`j-${name}`);
  if (!lease) throw new Error("Synthetic Outlook lease unavailable");
  return lease;
}
async function pendingInventory(lease: JobLease) {
  await env.DB.prepare(
    "INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id,excluded_folder_ids) VALUES(?,?,1,'root',NULL,1,'https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=g40-prior','pending',?,?)",
  )
    .bind(
      lease.context.userId,
      lease.connectionId,
      crypto.randomUUID(),
      excluded,
    )
    .run();
}
async function liveFolder(lease: JobLease) {
  await env.DB.prepare(
    "INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id,excluded_folder_ids) VALUES(?,?,1,'root',NULL,1,NULL,'complete',?,?)",
  )
    .bind(
      lease.context.userId,
      lease.connectionId,
      crypto.randomUUID(),
      excluded,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO outlook_folders(user_id,connection_id,generation,folder_id,parent_folder_id,child_folder_count,is_hidden) VALUES(?,?,1,?,'provider-root',0,0)",
  )
    .bind(lease.context.userId, lease.connectionId, folderId)
    .run();
  await env.DB.prepare(
    "INSERT INTO sync_states(id,user_id,connection_id,scope_key,sync_kind,run_key,slice_key,stage,coverage_code,history_cursor) VALUES(?,?,?,?,'incremental','live','live','queued','candidate_unknown',?)",
  )
    .bind(
      `folder-${lease.jobId}`,
      lease.context.userId,
      lease.connectionId,
      `outlook:1:${folderId}`,
      `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=g40-prior`,
    )
    .run();
}
function graph(
  overrides: Partial<OutlookGraphDiscoveryPort>,
): OutlookGraphDiscoveryPort {
  const unused = (): never => {
    throw new Error("Unexpected Graph request");
  };
  return {
    folders: unused,
    folder: unused,
    listFolder: unused,
    deltaFolder: unused,
    metadata: unused,
    ...overrides,
  };
}
async function statements(
  lease: JobLease,
  provider: OutlookGraphDiscoveryPort,
) {
  const meter = createInvocationDatabase(env.DB, 40);
  const outcome = await createOutlookJobRunner(meter.db, {
    open: async () => provider,
    remainingStatements: meter.remainingStatements,
  }).run(lease, {
    signal: new AbortController().signal,
    checkpoint: async () => true,
  });
  return { outcome, count: meter.executedStatements() };
}
function rateLimited(delayMs: number) {
  return async (): Promise<never> => {
    throw new DiscoveryError("RATE_LIMITED", delayMs);
  };
}
/**
 * Exact whole-invocation counts. "t17" is the T17 baseline (33afa0e)
 * measured with this same suite; INT-5 G4's single-batch rate deferral
 * (reusing the inventory's closing live read) lowered both inventory rate
 * paths. A change here must be explained against G-40, never raised past 40.
 */
const expected = {
  "inventory-read": { now: 5, t17: 5 },
  "inventory-rate-defer": { now: 7, t17: 8 },
  "inventory-rate-pause": { now: 8, t17: 10 },
  "folder-rate-defer": { now: 14, t17: 14 },
  "folder-rate-pause": { now: 13, t17: 13 },
  "folder-commit-1": { now: 18, t17: 18 },
  "folder-commit-5": { now: 34, t17: 34 },
} as const;
function record(name: keyof typeof expected, count: number) {
  expect(count).toBe(expected[name].now);
  expect(count).toBeLessThanOrEqual(expected[name].t17);
  expect(count).toBeLessThanOrEqual(40);
}

it("G-40 inventory read", async () => {
  const lease = await claimed("inventory-read", "recent");
  await pendingInventory(lease);
  const meter = createInvocationDatabase(env.DB, 40);
  const next = await createOutlookFolderStore(meter.db).getNextInventory(lease);
  expect(next.kind).toBe("ready");
  record("inventory-read", meter.executedStatements());
});

it("G-40 inventory rate defer", async () => {
  const lease = await claimed("inventory-defer", "recent");
  await pendingInventory(lease);
  const run = await statements(lease, graph({ folders: rateLimited(60_000) }));
  expect(run.outcome).toEqual({ kind: "completed" });
  record("inventory-rate-defer", run.count);
});

it("G-40 inventory rate pause", async () => {
  const lease = await claimed("inventory-pause", "recent");
  await pendingInventory(lease);
  const run = await statements(lease, graph({ folders: rateLimited(overDay) }));
  expect(run.outcome).toEqual({ kind: "completed" });
  record("inventory-rate-pause", run.count);
});

it("G-40 folder rate defer", async () => {
  const lease = await claimed("folder-defer", "live");
  await liveFolder(lease);
  const run = await statements(
    lease,
    graph({ deltaFolder: rateLimited(60_000) }),
  );
  expect(run.outcome).toEqual({ kind: "completed" });
  record("folder-rate-defer", run.count);
});

it("G-40 folder rate pause", async () => {
  const lease = await claimed("folder-pause", "live");
  await liveFolder(lease);
  const run = await statements(
    lease,
    graph({ deltaFolder: rateLimited(overDay) }),
  );
  expect(run.outcome).toEqual({ kind: "completed" });
  record("folder-rate-pause", run.count);
});

for (const references of [1, 5] as const) {
  it(`G-40 folder commit with ${references} candidate reference(s)`, async () => {
    const lease = await claimed(`folder-commit-${references}`, "live");
    await liveFolder(lease);
    const ids = Array.from(
      { length: references },
      (_, index) => `g40-message-${index}`,
    );
    const run = await statements(
      lease,
      graph({
        deltaFolder: async () => ({
          ids,
          folderRemovedIds: [],
          deltaLink: `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages/delta?$deltatoken=g40-next`,
        }),
        metadata: async (id) => ({
          id,
          parentFolderId: folderId,
          receivedAtMs: Date.now() - 60_000,
          available: true,
          excluded: false,
          candidate: "matched",
        }),
      }),
    );
    expect(run.outcome).toEqual({ kind: "completed" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM source_messages WHERE user_id=?",
      )
        .bind(lease.context.userId)
        .first("n"),
    ).toBe(references);
    record(references === 1 ? "folder-commit-1" : "folder-commit-5", run.count);
  });
}
