import type { TenantContext } from "@invoxim/core";
import { expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import {
  encodeLifecycleExport,
  LifecycleError,
} from "../../../packages/core/src/lifecycle/export";
import { createLifecycleService } from "../../../packages/core/src/lifecycle/service";
import type { LifecycleRepository } from "../../../packages/core/src/lifecycle/types";

const tenant = {
  userId: "synthetic-owner",
  authority: "session",
} as TenantContext;
const session = {
  tenant,
  sessionId: "synthetic-session",
  authenticatedAt: 1000,
};
it("LIFECYCLE-01 CSV preserves exact numeric minor magnitudes and separates period and lifecycle", () => {
  const output = encodeLifecycleExport(
    {
      schemaVersion: 1,
      exportedAt: "2026-10-12T00:00:00.000Z",
      filters: { from: "2026-10-01", to: "2026-10-31" },
      preferences: { timezone: "UTC", reportingCurrency: "EUR" },
      overrides: [],
      ledgerEntries: [],
      sources: [],
      observations: [],
      summary: {
        totals: [],
        dateBasis: "event",
        recordCount: 1,
        unpaidCount: 0,
        unknownCount: 0,
        reviewCount: 0,
        excludedEntryCount: 0,
        missingCurrencyCount: 0,
        conversion: "not_configured",
      },
      purchases: [
        {
          id: "p",
          merchant: '=1,"danger"',
          date: "2026-09-01",
          invoiceReference: null,
          orderReference: null,
          category: "other",
          currency: "EUR",
          documentTotalMinor: "9000000000000",
          paymentState: "paid",
          version: 1,
          origin: "source",
          recordStatus: "active",
          evidenceCount: 1,
          reviewReasons: [],
          lifecycle: [
            {
              currency: "EUR",
              paidMinor: "9000000000000",
              refundedMinor: "30",
              netMinor: "8999999999970",
            },
          ],
          period: [
            {
              currency: "EUR",
              paidMinor: "0",
              refundedMinor: "30",
              netMinor: "-30",
            },
          ],
        },
      ],
    },
    "csv",
  );
  expect(output).toContain('"\'=1,""danger"""');
  expect(output).toContain('"lifecycle","EUR",9000000000000,30,8999999999970');
  expect(output).toContain('"period","EUR",0,30,-30');
});
function fakeRepository(
  overrides: Partial<LifecycleRepository>,
): LifecycleRepository {
  const unavailable = async () => {
    throw new LifecycleError("UNAVAILABLE");
  };
  return {
    preview: unavailable,
    disconnect: unavailable,
    deleteData: unavailable,
    authorizeDeletion: unavailable,
    beginDeletion: unavailable,
    acknowledgeJournal: unavailable,
    ...overrides,
  };
}
it("LIFECYCLE-03 missing independent journal disables deletion before any local fence", async () => {
  let authorized = false;
  const repo = fakeRepository({
    authorizeDeletion: async () => {
      authorized = true;
    },
  });
  await expect(
    createLifecycleService(repo, null, () => 1000).deleteAccount(
      session,
      { confirmed: true, version: 1 },
      "synthetic-key-123456",
    ),
  ).rejects.toEqual(new LifecycleError("UNAVAILABLE"));
  expect(authorized).toBe(false);
});
it("LIFECYCLE-03 access fence precedes independent acknowledgment and physical cleanup remains pending", async () => {
  const order: string[] = [];
  const repo = fakeRepository({
    authorizeDeletion: async () => {
      order.push("authorize");
    },
    beginDeletion: async (_s, _r, marker) => {
      order.push("fence");
      return marker;
    },
    acknowledgeJournal: async () => {
      order.push("ack");
    },
  });
  const service = createLifecycleService(
    repo,
    {
      append: async (marker) => {
        expect(marker).toEqual({
          userId: tenant.userId,
          deletedAt: 1000,
          requestId: "synthetic-key-123456",
        });
        order.push("journal");
      },
    },
    () => 1000,
  );
  expect(
    await service.deleteAccount(
      session,
      { confirmed: true, version: 1 },
      "synthetic-key-123456",
    ),
  ).toEqual({
    status: "cleanup_pending",
    accessDisabled: true,
    driveFilesDeleted: false,
    remoteRevocation: "not_attempted",
  });
  expect(order).toEqual(["authorize", "fence", "journal", "ack"]);
});
it("LIFECYCLE-03 configured journal refusal disables access but cannot authorize physical cleanup", async () => {
  let ack = false;
  const repo = fakeRepository({
    authorizeDeletion: async () => {},
    beginDeletion: async (_s, _r, marker) => marker,
    acknowledgeJournal: async () => {
      ack = true;
    },
  });
  const result = await createLifecycleService(
    repo,
    {
      append: async () => {
        throw new Error("synthetic refusal");
      },
    },
    () => 1000,
  ).deleteAccount(
    session,
    { confirmed: true, version: 1 },
    "synthetic-key-123456",
  );
  expect(result.status).toBe("awaiting_journal");
  expect(result.accessDisabled).toBe(true);
  expect(ack).toBe(false);
});

import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

import { createLifecycleCleanup } from "../../../packages/adapters/src/lifecycle/cleanup";
import { createLifecycleRepository } from "../../../packages/adapters/src/lifecycle/repository";
import { createInvocationDatabase } from "../src/invocation-database";

beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((s) => s.trim()))
      await db.prepare(statement).run();
});
async function drainCleanupFixture() {
  // Small fixtures need one unit per explicit leaf stage, plus bounded recomputation units.
  // This ceiling is a test guard; production scheduler cadence is verified separately.
  for (let unit = 0; unit < 64; unit++) {
    const meter = createInvocationDatabase(env.DB, 5);
    const result = await createLifecycleCleanup(meter.db, null).runOne();
    expect(meter.executedStatements()).toBeLessThanOrEqual(5);
    if (result.status === "completed") return;
    expect(result.status).toBe("pending");
  }
  throw new Error(
    "Small lifecycle fixture did not complete within bounded units",
  );
}

async function owner(id: string) {
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)",
    )
    .bind(id, id, `${id}@example.invalid`)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
    )
    .bind(id)
    .run();
  await db
    .prepare(
      "INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,9999999999999,?,1000,1000,?)",
    )
    .bind(`session-${id}`, `token-${id}`, id)
    .run();
  return {
    tenant: { userId: id, authority: "session" } as TenantContext,
    sessionId: `session-${id}`,
    authenticatedAt: 1000,
  };
}
async function connection(user: string, id: string) {
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,credential_ciphertext,credential_key_version,credential_version,scheduling_state) VALUES(?,?,'mailbox','gmail',?,?, 'synthetic-encrypted',1,1,'active')",
    )
    .bind(id, user, id, `${id}@example.invalid`)
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES(?,?,?,1,'synthetic','local',1,1000,1)",
    )
    .bind(`consent-${id}`, user, id)
    .run();
  await db
    .prepare(
      "INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,type,dedupe_key,status,dispatch_at,lease_id,lease_expires_at,fence) VALUES(?,?,?,?,1,'source-extract',?,'leased',1000,'old-lease',9999999999999,1)",
    )
    .bind(`job-${id}`, user, id, `consent-${id}`, `job-${id}`)
    .run();
}
it("LIFECYCLE-04 tenant-owned disconnect cancels a running lease, revokes consent, erases credentials and replays once", async () => {
  const a = await owner("disconnect-a"),
    b = await owner("disconnect-b");
  await connection(a.tenant.userId, "mail-a");
  await connection(b.tenant.userId, "mail-b");
  const repo = createLifecycleRepository(db, () => 1000);
  await expect(
    repo.disconnect(
      a,
      "mail-b",
      { confirmed: true, generation: 1, credentialVersion: 1 },
      "synthetic-command-key",
    ),
  ).rejects.toThrow("CONFLICT");
  expect(
    await repo.disconnect(
      a,
      "mail-a",
      { confirmed: true, generation: 1, credentialVersion: 1 },
      "synthetic-command-key",
    ),
  ).toMatchObject({ generation: 2, recordsRetained: true });
  expect(
    await db
      .prepare(
        "SELECT credential_ciphertext FROM connections WHERE user_id=? AND id='mail-a'",
      )
      .bind(a.tenant.userId)
      .first("credential_ciphertext"),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT state FROM connections WHERE user_id=? AND id='mail-b'")
      .bind(b.tenant.userId)
      .first("state"),
  ).toBe("connected");
  expect(
    await db
      .prepare("SELECT status FROM jobs WHERE id='job-mail-a'")
      .first("status"),
  ).toBe("canceled");
  expect(
    await db
      .prepare(
        "SELECT revoked_at FROM processing_consents WHERE id='consent-mail-a'",
      )
      .first("revoked_at"),
  ).toBe(1000);
  await repo.disconnect(
    a,
    "mail-a",
    { confirmed: true, generation: 1, credentialVersion: 1 },
    "synthetic-command-key",
  );
  expect(
    await db
      .prepare("SELECT generation FROM connections WHERE id='mail-a'")
      .first("generation"),
  ).toBe(2);
  await expect(
    repo.disconnect(
      a,
      "mail-a",
      { confirmed: true, generation: 2, credentialVersion: 2 },
      "synthetic-command-key",
    ),
  ).rejects.toThrow("CONFLICT");
});
it("LIFECYCLE-03 account fence invalidates sessions and consumer writes, cleanup waits for independent journal then erases bounded graph", async () => {
  const a = await owner("delete-a"),
    b = await owner("delete-b");
  await connection(a.tenant.userId, "delete-mail-a");
  await connection(b.tenant.userId, "delete-mail-b");
  const repo = createLifecycleRepository(db, () => 1000);
  await repo.authorizeDeletion(a, { confirmed: true, version: 1 });
  const marker = await repo.beginDeletion(
    a,
    { confirmed: true, version: 1 },
    {
      userId: a.tenant.userId,
      deletedAt: 1000,
      requestId: "synthetic-deletion-key",
    },
  );
  expect(
    await db
      .prepare("SELECT status FROM profiles WHERE user_id=?")
      .bind(a.tenant.userId)
      .first("status"),
  ).toBe("deleting");
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM session WHERE userId=?")
      .bind(a.tenant.userId)
      .first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT status FROM jobs WHERE id='job-delete-mail-a'")
      .first("status"),
  ).toBe("canceled");
  const blocked = await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,payment_state) SELECT 'resurrect',?,'synthetic','synthetic','2026-01-01','unpaid' WHERE EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND status='active')",
    )
    .bind(a.tenant.userId, a.tenant.userId)
    .run();
  expect(blocked.meta.changes).toBe(0);
  expect(await createLifecycleCleanup(db, null).runOne()).toEqual({
    status: "awaiting_journal",
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM connections WHERE user_id=?")
      .bind(a.tenant.userId)
      .first("n"),
  ).toBe(1);
  await repo.acknowledgeJournal(marker);
  await drainCleanupFixture();
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM user WHERE id=?")
      .bind(a.tenant.userId)
      .first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM user WHERE id=?")
      .bind(b.tenant.userId)
      .first("n"),
  ).toBe(1);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
async function evidence(
  user: string,
  mail: string,
  suffix: string,
  purchase: string,
  contentHash: string,
) {
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,?,?,1000,1)",
    )
    .bind(`source-${suffix}`, user, mail, suffix)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES(?,?,?,'body',?,'text/plain',10)",
    )
    .bind(`doc-${suffix}`, user, `source-${suffix}`, contentHash)
    .run();
  await db
    .prepare(
      'INSERT INTO observations(id,user_id,document_id,segment_index,extraction_fingerprint,extraction_version,evidence_code,normalized_fields,review_state) VALUES(?,?,?,0,\'synthetic\',1,\'explicitly-paid\',\'{"schemaVersion":1,"merchant":"Synthetic","date":"2026-01-01","totalMinor":"100","currency":"EUR"}\',\'accepted\')',
    )
    .bind(`obs-${suffix}`, user, `doc-${suffix}`)
    .run();
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,total_minor,currency,payment_state) VALUES(?,?,'Synthetic','synthetic','2026-01-01',100,'EUR','paid') ON CONFLICT DO NOTHING",
    )
    .bind(purchase, user)
    .run();
  await db
    .prepare(
      "INSERT INTO purchase_evidence(user_id,purchase_id,observation_id,relationship) VALUES(?,?,?,'document')",
    )
    .bind(user, purchase, `obs-${suffix}`)
    .run();
}
it("LIFECYCLE-05 previews source deletion, transfers exactly identical independent cash evidence, preserves shared purchase and removes unsupported purchase", async () => {
  const a = await owner("graph-a");
  await connection(a.tenant.userId, "graph-mail-a");
  await connection(a.tenant.userId, "graph-mail-b");
  await evidence(
    a.tenant.userId,
    "graph-mail-a",
    "shared-a",
    "shared-p",
    "exact-content",
  );
  await evidence(
    a.tenant.userId,
    "graph-mail-b",
    "shared-b",
    "shared-p",
    "exact-content",
  );
  await evidence(
    a.tenant.userId,
    "graph-mail-a",
    "sole-a",
    "sole-p",
    "different-content",
  );
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible) VALUES('shared-event',?,'shared-p','obs-shared-a','event-shared','payment',100,'EUR','2026-01-01','explicit-event-date',1)",
    )
    .bind(a.tenant.userId)
    .run();
  const repo = createLifecycleRepository(db, () => 1000);
  const preview = await repo.preview(a.tenant, "graph-mail-a");
  expect(preview).toMatchObject({
    sources: 2,
    documents: 2,
    observations: 2,
    purchasesRemoved: 1,
    purchasesRetained: 1,
    eventsRemoved: 0,
    eventsRetained: 1,
  });
  await expect(repo.preview(a.tenant, "delete-mail-b")).rejects.toThrow(
    "NOT_FOUND",
  );
  const request = {
    confirmed: true as const,
    generation: preview.generation,
    previewFingerprint: preview.fingerprint,
  };
  expect(
    await repo.deleteData(a, "graph-mail-a", request, "synthetic-source-key"),
  ).toEqual({ status: "cleanup_pending", driveFilesDeleted: false });
  await drainCleanupFixture();
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM purchases WHERE user_id=? AND id='shared-p'",
      )
      .bind(a.tenant.userId)
      .first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM purchases WHERE user_id=? AND id='sole-p'",
      )
      .bind(a.tenant.userId)
      .first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT observation_id FROM ledger_entries WHERE user_id=? AND id='shared-event'",
      )
      .bind(a.tenant.userId)
      .first("observation_id"),
  ).toBe("obs-shared-b");
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM source_messages WHERE user_id=? AND connection_id='graph-mail-a'",
      )
      .bind(a.tenant.userId)
      .first("n"),
  ).toBe(0);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

import type { GmailConfiguration } from "@invoxim/adapters";
import {
  createCredentialCipher,
  createMailboxService,
  encodeBase64url,
  GMAIL_AUTHORIZATION_SCOPES,
} from "@invoxim/adapters";
import type { MailboxAuthorizationPort } from "@invoxim/core";

it("LIFECYCLE-05 OAuth reconnect stays fenced during source cleanup and works after cleanup completes", async () => {
  const s = await owner("reconnect-fence");
  await connection(s.tenant.userId, "reconnect-mail");
  const cipher = createCredentialCipher({
    activeVersion: 1,
    keys: { 1: encodeBase64url(new Uint8Array(32).fill(7)) },
  });
  const config: GmailConfiguration = {
    provider: "gmail",
    oauthProvider: "google",
    scopes: GMAIL_AUTHORIZATION_SCOPES,
    login: {
      origin: "https://synthetic.example",
      secret: "synthetic-test-secret-never-use-in-production-123",
      googleClientId: "id",
      googleClientSecret: "secret",
      allowedEmails: ["reconnect-fence@example.invalid"],
    },
    clientId: "mail-id",
    clientSecret: "mail-secret",
    limit: 10,
    cipher,
    callback: "https://synthetic.example/api/oauth/mailbox/gmail/callback",
  };
  const provider: MailboxAuthorizationPort = {
    authorize: async (input) =>
      `https://accounts.google.com/o/oauth2/v2/auth?state=${input.state}`,
    exchange: async () => ({
      identity: {
        subject: "reconnect-mail",
        address: "reconnect-mail@example.invalid",
      },
      canReadMessages: true,
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.readonly",
      ],
      credentials: {
        accessToken: "synthetic-access",
        refreshToken: "synthetic-refresh",
        expiresAt: Date.now() + 3600000,
      },
    }),
    refresh: async () => {
      throw new Error("unused");
    },
  };
  const mailbox = createMailboxService(db, config, provider);
  const mailboxSession = {
    tenant: s.tenant,
    sessionId: s.sessionId,
    createdAtMs: Date.now(),
  };
  await db
    .prepare(
      "UPDATE connections SET state='disconnected',scheduling_state='paused',credential_ciphertext=NULL,credential_key_version=NULL WHERE user_id=? AND id='reconnect-mail'",
    )
    .bind(s.tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO lifecycle_deletions(user_id,scope,target_id,request_id,deleted_at,journal_ack) VALUES(?,'connection','reconnect-mail','synthetic-reconnect-key',1000,1)",
    )
    .bind(s.tenant.userId)
    .run();
  const started = await mailbox.start(mailboxSession, "reconnect-mail");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("fixture state missing");
  await expect(
    mailbox.complete(mailboxSession, { state, code: "synthetic" }),
  ).rejects.toThrow();
  expect(
    await db
      .prepare("SELECT state FROM connections WHERE id='reconnect-mail'")
      .first("state"),
  ).toBe("disconnected");
  await db
    .prepare(
      "DELETE FROM lifecycle_deletions WHERE user_id=? AND scope='connection'",
    )
    .bind(s.tenant.userId)
    .run();
  const again = await mailbox.start(mailboxSession, "reconnect-mail");
  const next = new URL(again.authorizationUrl).searchParams.get("state");
  if (!next) throw new Error("fixture state missing");
  expect(
    await mailbox.complete(mailboxSession, { state: next, code: "synthetic" }),
  ).toMatchObject({ state: "connected" });
});

import { createGoogleCredentialRevoker } from "@invoxim/adapters";

const db = env.DB;

it("LIFECYCLE-04 remote project-wide revocation requires explicit opt-in and remains best effort after local fencing", async () => {
  const s = await owner("revoke-owner");
  await connection(s.tenant.userId, "revoke-mail-a");
  await connection(s.tenant.userId, "revoke-mail-b");
  const cipher = createCredentialCipher({
    activeVersion: 1,
    keys: { 1: encodeBase64url(new Uint8Array(32).fill(9)) },
  });
  for (const id of ["revoke-mail-a", "revoke-mail-b"]) {
    const encrypted = await cipher.seal(
      s.tenant,
      { entityId: id, purpose: "mailbox-credentials" },
      {
        accessToken: "synthetic-access",
        refreshToken: `synthetic-refresh-${id}`,
        expiresAt: 2000,
      },
    );
    await db
      .prepare(
        "UPDATE connections SET credential_ciphertext=? WHERE user_id=? AND id=?",
      )
      .bind(encrypted, s.tenant.userId, id)
      .run();
  }
  let sent = 0;
  const revoker = createGoogleCredentialRevoker(
    db,
    cipher,
    async (input, init) => {
      sent++;
      expect(input).toBe("https://oauth2.googleapis.com/revoke");
      expect(init?.redirect).toBe("error");
      expect(init?.method).toBe("POST");
      expect(
        await db
          .prepare(
            "SELECT credential_ciphertext FROM connections WHERE id='revoke-mail-b'",
          )
          .first("credential_ciphertext"),
      ).toBeNull();
      expect(
        await db
          .prepare("SELECT status FROM jobs WHERE id='job-revoke-mail-b'")
          .first("status"),
      ).toBe("canceled");
      return new Response(null, { status: 500 });
    },
  );
  const service = createLifecycleService(
    createLifecycleRepository(db, () => 1000),
    null,
    () => 1000,
    revoker,
  );
  expect(
    await service.disconnect(
      s,
      "revoke-mail-a",
      { confirmed: true, generation: 1, credentialVersion: 1 },
      "synthetic-default-key",
    ),
  ).toMatchObject({ remoteRevocation: "not_attempted" });
  expect(sent).toBe(0);
  expect(
    await service.disconnect(
      s,
      "revoke-mail-a",
      {
        confirmed: true,
        generation: 1,
        credentialVersion: 1,
        revokeProviderAccess: false,
      },
      "synthetic-default-key",
    ),
  ).toMatchObject({ generation: 2 });
  expect(
    await service.disconnect(
      s,
      "revoke-mail-b",
      {
        confirmed: true,
        generation: 1,
        credentialVersion: 1,
        revokeProviderAccess: true,
      },
      "synthetic-opt-in-key",
    ),
  ).toMatchObject({
    remoteRevocation: "failed",
    localCredentialsRemoved: true,
  });
  expect(sent).toBe(1);
  expect(
    await db
      .prepare("SELECT state FROM connections WHERE id='revoke-mail-b'")
      .first("state"),
  ).toBe("disconnected");
});
it("LIFECYCLE-04 captured stale credential generation cannot be submitted to remote revocation", async () => {
  const s = await owner("stale-revoke");
  await connection(s.tenant.userId, "stale-revoke-mail");
  const cipher = createCredentialCipher({
    activeVersion: 1,
    keys: { 1: encodeBase64url(new Uint8Array(32).fill(9)) },
  });
  const encrypted = await cipher.seal(
    s.tenant,
    { entityId: "stale-revoke-mail", purpose: "mailbox-credentials" },
    { refreshToken: "synthetic-stale-refresh" },
  );
  await db
    .prepare(
      "UPDATE connections SET credential_ciphertext=? WHERE id='stale-revoke-mail'",
    )
    .bind(encrypted)
    .run();
  let sent = 0;
  const revoker = createGoogleCredentialRevoker(db, cipher, async () => {
    sent++;
    return new Response(null, { status: 200 });
  });
  const prepared = await revoker.prepare(s.tenant, "stale-revoke-mail");
  await db
    .prepare(
      "UPDATE connections SET state='disconnected',credential_ciphertext=NULL,credential_key_version=NULL,generation=generation+1,credential_version=credential_version+2 WHERE id='stale-revoke-mail'",
    )
    .run();
  expect(await prepared.revoke()).toBe("failed");
  expect(sent).toBe(0);
});
it("LIFECYCLE-04 successful provider response acknowledges revocation without claiming immediate provider state", async () => {
  const s = await owner("accepted-revoke");
  await connection(s.tenant.userId, "accepted-revoke-mail");
  const cipher = createCredentialCipher({
    activeVersion: 1,
    keys: { 1: encodeBase64url(new Uint8Array(32).fill(9)) },
  });
  const encrypted = await cipher.seal(
    s.tenant,
    { entityId: "accepted-revoke-mail", purpose: "mailbox-credentials" },
    { refreshToken: "synthetic-accepted-refresh" },
  );
  await db
    .prepare(
      "UPDATE connections SET credential_ciphertext=? WHERE user_id=? AND id='accepted-revoke-mail'",
    )
    .bind(encrypted, s.tenant.userId)
    .run();
  let submitted = 0;
  const revoker = createGoogleCredentialRevoker(
    db,
    cipher,
    async (input, init) => {
      submitted++;
      expect(input).toBe("https://oauth2.googleapis.com/revoke");
      expect(init?.redirect).toBe("error");
      expect(
        await db
          .prepare(
            "SELECT state FROM connections WHERE user_id=? AND id='accepted-revoke-mail'",
          )
          .bind(s.tenant.userId)
          .first("state"),
      ).toBe("disconnected");
      return new Response(null, { status: 200 });
    },
  );
  const service = createLifecycleService(
    createLifecycleRepository(db, () => 1000),
    null,
    () => 1000,
    revoker,
  );
  const response = await service.disconnect(
    s,
    "accepted-revoke-mail",
    {
      confirmed: true,
      generation: 1,
      credentialVersion: 1,
      revokeProviderAccess: true,
    },
    "synthetic-accepted-key",
  );
  expect(response.remoteRevocation).toBe("accepted");
  expect(submitted).toBe(1);
});
