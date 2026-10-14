import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { createOnboardingImportPreparation } from "../../../packages/adapters/src/onboarding/import-preparation";
import { createOnboardingRepository } from "../../../packages/adapters/src/onboarding/repository";
import {
  configuredAi,
  now,
  owner,
  query,
  runtime,
  startBody, installOnboardingQaHooks } from "./onboarding-qa-fixture";

installOnboardingQaHooks();

const db = env.DB;
async function outlookOwner(id: string) {
  const session = await owner(id, query.connectionId, [
    "https://graph.microsoft.com/Mail.Read",
  ]);
  await db
    .prepare(
      "UPDATE connections SET provider='outlook' WHERE user_id=? AND id=?",
    )
    .bind(session.tenant.userId, query.connectionId)
    .run();
  return session;
}
function repository() {
  return createOnboardingRepository(db, {
    ai: configuredAi(),
    ready: true,
    mailboxProviders: ["gmail", "outlook"],
    signingSecret: "synthetic-onboarding-review-secret-12345",
    mailboxLimit: 3,
    remainingStatements: () => 40,
    clock: () => now,
  });
}

it("OUTLOOK-01/ONBOARD-06 explicit Outlook Start seeds recent-first parents with no history anchor or Graph call", async () => {
  const session = await outlookOwner("qa-outlook-start");
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Start must not call Graph"));
  const first = runtime();
  const disclosure = await first.usecases.disclosure(session, query);
  expect(disclosure.canStartImport).toBe(true);
  const result = await runtime().usecases.start(
    session,
    startBody(disclosure),
    "outlook-start",
  );
  expect(result.reused).toBe(false);
  expect(transport).not.toHaveBeenCalled();
  expect(
    await db
      .prepare(
        "SELECT slice_key,scope_key,stage,history_cursor,recovery_anchor FROM sync_states WHERE user_id=? ORDER BY slice_key",
      )
      .bind(session.tenant.userId)
      .all(),
  ).toMatchObject({
    results: [
      {
        slice_key: "live",
        scope_key: "mailbox",
        stage: "queued",
        history_cursor: null,
        recovery_anchor: null,
      },
      {
        slice_key: "older",
        scope_key: "mailbox",
        stage: "waiting_recent",
        history_cursor: null,
        recovery_anchor: null,
      },
      {
        slice_key: "recent",
        scope_key: "mailbox",
        stage: "queued",
        history_cursor: null,
        recovery_anchor: null,
      },
    ],
  });
  expect(
    await db
      .prepare("SELECT type,priority FROM jobs WHERE user_id=?")
      .bind(session.tenant.userId)
      .all(),
  ).toMatchObject({ results: [{ type: "discover", priority: 0 }] });
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM outlook_folders WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(0);
  const replay = runtime();
  expect(
    await replay.usecases.start(
      session,
      startBody(disclosure),
      "outlook-start",
    ),
  ).toEqual({ ...result, reused: true });
  expect(replay.opens()).toBe(0);
  expect(replay.meter.executedStatements()).toBeLessThanOrEqual(40);
  transport.mockRestore();
});

it("OUTLOOK-01 Gmail readiness cannot enable Start for an unconfigured Outlook provider", async () => {
  const session = await outlookOwner("qa-outlook-disabled-provider");
  const repo = createOnboardingRepository(db, {
    ai: configuredAi(),
    ready: true,
    mailboxProviders: ["gmail"],
    signingSecret: "synthetic-onboarding-review-secret-12345",
    mailboxLimit: 3,
    remainingStatements: () => 40,
    clock: () => now,
  });
  const disclosure = await repo.disclosure(session, query);
  expect(disclosure.availability).toBe("configuration");
  expect(disclosure.canStartImport).toBe(false);
  const view = await repo.view(session, query.connectionId);
  expect(view.view.canStartImport).toBe(false);
  expect(view.view.state).toBe("processing_unavailable");
  expect(view.view.primaryAction).toBe("view_example");
});

it.each(["provider", "scopes"] as const)(
  "ONBOARD-06 Outlook Start atomically refuses a changed %s snapshot",
  async (field) => {
    const session = await outlookOwner(`qa-outlook-snapshot-${field}`);
    const disclosure = await runtime().usecases.disclosure(session, query);
    expect(disclosure.canStartImport).toBe(true);
    const repo = repository();
    const prepared = await repo.prepareStart(
      session,
      startBody(disclosure),
      `outlook-${field}`,
    );
    if (prepared.kind !== "ready")
      throw new Error("Synthetic Start preparation failed");
    if (field === "provider")
      await db
        .prepare(
          "UPDATE connections SET provider='gmail',scopes=? WHERE user_id=? AND id=?",
        )
        .bind(
          JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
          session.tenant.userId,
          query.connectionId,
        )
        .run();
    else
      await db
        .prepare("UPDATE connections SET scopes=? WHERE user_id=? AND id=?")
        .bind(
          JSON.stringify(["Mail.Read", "Mail.ReadWrite"]),
          session.tenant.userId,
          query.connectionId,
        )
        .run();
    await expect(
      repo.commitStart(session, prepared.prepared, { provider: "outlook" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM import_runs WHERE user_id=?")
        .bind(session.tenant.userId)
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM processing_consents WHERE user_id=?")
        .bind(session.tenant.userId)
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM onboarding_commands WHERE user_id=?")
        .bind(session.tenant.userId)
        .first("n"),
    ).toBe(0);
  },
);

it.each(["provider", "scopes"] as const)(
  "ONBOARD-06 signed Outlook review rejects a changed %s before preparation or any Start writes",
  async (field) => {
    const session = await outlookOwner(`qa-outlook-signed-review-${field}`);
    const disclosure = await runtime().usecases.disclosure(session, query);
    expect(disclosure.canStartImport).toBe(true);
    if (field === "provider")
      await db
        .prepare(
          "UPDATE connections SET provider='gmail',scopes=? WHERE user_id=? AND id=?",
        )
        .bind(
          JSON.stringify(["https://www.googleapis.com/auth/gmail.readonly"]),
          session.tenant.userId,
          query.connectionId,
        )
        .run();
    else
      await db
        .prepare("UPDATE connections SET scopes=? WHERE user_id=? AND id=?")
        .bind(
          JSON.stringify(["Mail.Read", "openid"]),
          session.tenant.userId,
          query.connectionId,
        )
        .run();
    const started = runtime();
    await expect(
      started.usecases.start(
        session,
        startBody(disclosure),
        `outlook-signed-${field}`,
      ),
    ).rejects.toMatchObject({ code: "PROCESSING_REVIEW_REQUIRED" });
    expect(started.opens()).toBe(0);
    for (const table of [
      "onboarding_commands",
      "processing_consents",
      "import_runs",
      "jobs",
    ])
      expect(
        await db
          .prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`)
          .bind(session.tenant.userId)
          .first("n"),
      ).toBe(0);
  },
);

it("ONBOARD-06 null bootstrap cannot authorize a fresh Outlook import", async () => {
  const session = await outlookOwner("qa-outlook-null-seed");
  const disclosure = await runtime().usecases.disclosure(session, query);
  expect(disclosure.canStartImport).toBe(true);
  const repo = repository();
  const ready = await repo.prepareStart(
    session,
    startBody(disclosure),
    "outlook-null",
  );
  if (ready.kind !== "ready") throw new Error("Synthetic preparation failed");
  await expect(
    repo.commitStart(session, ready.prepared, null),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM import_runs WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(0);
});

it("ONBOARD-06 reconnect resume rebinds Outlook folder generations and preserves pending and completed progress", async () => {
  const session = await outlookOwner("qa-outlook-resume");
  const disclosure = await runtime().usecases.disclosure(session, query);
  expect(disclosure.canStartImport).toBe(true);
  const started = await runtime().usecases.start(
    session,
    startBody(disclosure),
    "outlook-initial",
  );
  const cursor =
    "https://graph.microsoft.com/v1.0/me/mailFolders/synthetic-folder/messages?$skiptoken=synthetic-page";
  const delta =
    "https://graph.microsoft.com/v1.0/me/mailFolders/synthetic-folder/messages/delta?$deltatoken=synthetic-delta";
  await db
    .prepare(
      "INSERT INTO sync_states(id,user_id,connection_id,import_run_id,scope_key,sync_kind,run_key,slice_key,stage,page_token,frozen_start,frozen_cutoff) SELECT 'outlook-pending-child',user_id,connection_id,import_run_id,'outlook:1:synthetic-folder',sync_kind,run_key,slice_key,'paused_auth',?,frozen_start,frozen_cutoff FROM sync_states WHERE user_id=? AND import_run_id=? AND scope_key='mailbox' AND slice_key='recent'",
    )
    .bind(cursor, session.tenant.userId, started.importRunId)
    .run();
  await db
    .prepare(
      "INSERT INTO sync_states(id,user_id,connection_id,import_run_id,scope_key,sync_kind,run_key,slice_key,stage,frozen_start,frozen_cutoff) SELECT 'outlook-completed-child',user_id,connection_id,import_run_id,'outlook:1:synthetic-complete',sync_kind,run_key,slice_key,'discovery_complete',frozen_start,frozen_cutoff FROM sync_states WHERE user_id=? AND import_run_id=? AND scope_key='mailbox' AND slice_key='recent'",
    )
    .bind(session.tenant.userId, started.importRunId)
    .run();
  await db
    .prepare(
      "INSERT INTO sync_states(id,user_id,connection_id,scope_key,sync_kind,run_key,slice_key,stage,history_cursor) VALUES('outlook-live-child',?,?,'outlook:1:synthetic-folder','incremental','live','live','paused_auth',?)",
    )
    .bind(session.tenant.userId, query.connectionId, delta)
    .run();
  await db
    .prepare(
      "UPDATE connections SET generation=2,credential_version=2,scheduling_state='paused' WHERE user_id=? AND id=?",
    )
    .bind(session.tenant.userId, query.connectionId)
    .run();
  await db
    .prepare(
      "UPDATE import_runs SET pause_reason='auth' WHERE user_id=? AND id=?",
    )
    .bind(session.tenant.userId, started.importRunId)
    .run();
  await db
    .prepare("UPDATE processing_consents SET revoked_at=? WHERE user_id=?")
    .bind(now, session.tenant.userId)
    .run();
  await db
    .prepare(
      "UPDATE jobs SET status='canceled',outcome_code='authorization-changed' WHERE user_id=?",
    )
    .bind(session.tenant.userId)
    .run();
  const review = await runtime().usecases.disclosure(session, query);
  const resumed = runtime();
  expect(
    await resumed.usecases.start(session, startBody(review), "outlook-resume"),
  ).toEqual({ importRunId: started.importRunId, reused: true });
  expect(resumed.opens()).toBe(0);
  expect(resumed.meter.executedStatements()).toBeLessThanOrEqual(40);
  expect(
    await db
      .prepare(
        "SELECT id,scope_key,stage,page_token,history_cursor FROM sync_states WHERE user_id=? AND id IN ('outlook-pending-child','outlook-completed-child','outlook-live-child') ORDER BY id",
      )
      .bind(session.tenant.userId)
      .all(),
  ).toMatchObject({
    results: [
      {
        id: "outlook-completed-child",
        scope_key: "outlook:2:synthetic-complete",
        stage: "discovery_complete",
      },
      {
        id: "outlook-live-child",
        scope_key: "outlook:2:synthetic-folder",
        stage: "idle",
        history_cursor: delta,
      },
      {
        id: "outlook-pending-child",
        scope_key: "outlook:2:synthetic-folder",
        stage: "queued",
        page_token: cursor,
      },
    ],
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM import_runs WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(1);
});

it("ONBOARD-06 an Outlook generation-key collision rolls back consent, profile, command and cursor changes", async () => {
  const session = await outlookOwner("qa-outlook-resume-collision");
  const disclosure = await runtime().usecases.disclosure(session, query);
  const started = await runtime().usecases.start(
    session,
    startBody(disclosure),
    "outlook-before-collision",
  );
  const cursor =
    "https://graph.microsoft.com/v1.0/me/mailFolders/synthetic-folder/messages?$skiptoken=synthetic";
  for (const generation of [1, 2])
    await db
      .prepare(
        "INSERT INTO sync_states(id,user_id,connection_id,import_run_id,scope_key,sync_kind,run_key,slice_key,stage,page_token,frozen_start,frozen_cutoff) SELECT ?,user_id,connection_id,import_run_id,?,sync_kind,run_key,slice_key,'paused_auth',?,frozen_start,frozen_cutoff FROM sync_states WHERE user_id=? AND import_run_id=? AND scope_key='mailbox' AND slice_key='recent'",
      )
      .bind(
        `outlook-collision-${generation}`,
        `outlook:${generation}:synthetic-folder`,
        cursor,
        session.tenant.userId,
        started.importRunId,
      )
      .run();
  await db
    .prepare(
      "UPDATE connections SET generation=2,credential_version=2,scheduling_state='paused' WHERE user_id=? AND id=?",
    )
    .bind(session.tenant.userId, query.connectionId)
    .run();
  await db
    .prepare(
      "UPDATE import_runs SET pause_reason='auth' WHERE user_id=? AND id=?",
    )
    .bind(session.tenant.userId, started.importRunId)
    .run();
  await db
    .prepare("UPDATE processing_consents SET revoked_at=? WHERE user_id=?")
    .bind(now, session.tenant.userId)
    .run();
  await db
    .prepare(
      "UPDATE jobs SET status='canceled',outcome_code='authorization-changed' WHERE user_id=?",
    )
    .bind(session.tenant.userId)
    .run();
  const profileBefore = await db
    .prepare("SELECT version FROM profiles WHERE user_id=?")
    .bind(session.tenant.userId)
    .first("version");
  const runBefore = await db
    .prepare(
      "SELECT consent_id,connection_generation FROM import_runs WHERE user_id=? AND id=?",
    )
    .bind(session.tenant.userId, started.importRunId)
    .first();
  const fresh = await runtime().usecases.disclosure(session, query);
  await expect(
    runtime().usecases.start(
      session,
      startBody(fresh),
      "outlook-key-collision",
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(
    await db
      .prepare("SELECT version FROM profiles WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("version"),
  ).toBe(profileBefore);
  expect(
    await db
      .prepare(
        "SELECT consent_id,connection_generation FROM import_runs WHERE user_id=? AND id=?",
      )
      .bind(session.tenant.userId, started.importRunId)
      .first(),
  ).toEqual(runBefore);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM processing_consents WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM onboarding_commands WHERE user_id=?")
      .bind(session.tenant.userId)
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT id,scope_key,page_token FROM sync_states WHERE user_id=? AND id LIKE 'outlook-collision-%' ORDER BY id",
      )
      .bind(session.tenant.userId)
      .all(),
  ).toMatchObject({
    results: [
      {
        id: "outlook-collision-1",
        scope_key: "outlook:1:synthetic-folder",
        page_token: cursor,
      },
      {
        id: "outlook-collision-2",
        scope_key: "outlook:2:synthetic-folder",
        page_token: cursor,
      },
    ],
  });
});

it("OUTLOOK-01 Start preparation never opens the Gmail factory or performs Graph requests for Outlook", async () => {
  const session = await outlookOwner("qa-outlook-pure-preparation");
  const open = vi
    .fn()
    .mockRejectedValue(new Error("Outlook cannot open Gmail"));
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No provider calls during preparation"));
  expect(
    await createOnboardingImportPreparation({ open }, true).prepare(
      session.tenant,
      { provider: "outlook", connectionId: query.connectionId, generation: 1 },
      new AbortController().signal,
    ),
  ).toEqual({ provider: "outlook" });
  expect(open).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
  await expect(
    createOnboardingImportPreparation({ open }, false).prepare(
      session.tenant,
      { provider: "outlook", connectionId: query.connectionId, generation: 1 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  transport.mockRestore();
});

it("ONBOARD-06 Gmail preparation captures only its actual anchor through the established discovery factory", async () => {
  const session = await owner("qa-gmail-start-preparation");
  const anchor = vi.fn().mockResolvedValue("98765");
  const forbidden = vi
    .fn()
    .mockRejectedValue(new Error("Start cannot list or read mail"));
  const open = vi.fn().mockResolvedValue({
    anchor,
    list: forbidden,
    metadata: forbidden,
    history: forbidden,
  });
  const signal = new AbortController().signal;
  expect(
    await createOnboardingImportPreparation({ open }, false).prepare(
      session.tenant,
      { provider: "gmail", connectionId: query.connectionId, generation: 1 },
      signal,
    ),
  ).toEqual({ provider: "gmail", historyAnchor: "98765" });
  expect(open).toHaveBeenCalledWith(
    session.tenant,
    { provider: "gmail", connectionId: query.connectionId, generation: 1 },
    signal,
  );
  expect(anchor).toHaveBeenCalledWith(signal);
  expect(forbidden).not.toHaveBeenCalled();
});
