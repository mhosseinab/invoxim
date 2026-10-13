import { env } from "cloudflare:workers";
import { createLoginAuth, createProfileService } from "@invoxim/adapters";
import type {
  ArchiveAuthorizationPort,
  ArchiveCredentials,
  ArchiveIdentity,
  TenantContext,
} from "@invoxim/core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import backfillMigration from "../../../packages/adapters/migrations/0006_archive_dispatch_backfill.sql?raw";
import { createArchiveFolderStore } from "../../../packages/adapters/src/drive/folders";
import { createArchiveObjectStore } from "../../../packages/adapters/src/drive/objects";
import { createDriveArchiveWorkflow } from "../../../packages/adapters/src/drive/workflow";
import { OUTLOOK_AUTHORIZATION_SCOPES } from "../../../packages/adapters/src/mailbox/outlook-configuration";
import { createCredentialCipher } from "../../../packages/adapters/src/security/cipher";
import { createArchiveWorkflow } from "../../../packages/core/src/archive/workflow";
import type {
  ArchiveWorkflowPorts,
  ArchiveWorkflowRemote,
} from "../../../packages/core/src/archive/workflow-types";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;
let tenant: TenantContext;
const bytes = new Uint8Array([0, 255, 10, 13, 128, 65]);
const sha256 =
  "a9b6ec3f62bd58b9bd73ebbc14f5bd2d53e0cc723d4cef38829efc2789890c76";
const login = {
  origin: "https://synthetic.example",
  secret: "synthetic-workflow-login-secret-123456789",
  googleClientId: "synthetic-login.apps.googleusercontent.com",
  googleClientSecret: "synthetic-login-secret",
  allowedEmails: ["workflow-login@example.test"],
};

beforeAll(async () => {
  for (const migration of [baseline, backfillMigration])
    for (const statement of migration
      .split(";")
      .filter((value) => value.trim()))
      await db.prepare(statement).run();
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('synthetic-workflow-user','Synthetic','workflow-login@example.test',1,?,?)",
    )
    .bind(now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES('synthetic-workflow-user',?,?)",
    )
    .bind(now, now)
    .run();
  const auth = createLoginAuth(db, login);
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(
    "synthetic-workflow-user",
    false,
  );
  if (!session) throw new Error("Synthetic workflow session unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(login.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(session.token),
  );
  const cookie =
    "__Secure-better-auth.session_token=" +
    encodeURIComponent(
      session.token +
        "." +
        btoa(String.fromCharCode(...new Uint8Array(signature))),
    );
  const profile = await createProfileService(db, auth, login).current(
    new Headers({ Cookie: cookie }),
  );
  if (!profile)
    throw new Error("Synthetic workflow session verification failed");
  tenant = profile.tenant;
  await db
    .prepare(
      "INSERT INTO purchases(id,user_id,merchant_raw,merchant_normalized,document_date,currency,payment_state) VALUES('synthetic-existing-purchase',?,'Synthetic','synthetic','2026-10-13','EUR','paid')",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO ledger_entries(id,user_id,purchase_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,origin) VALUES('synthetic-existing-payment',?,'synthetic-existing-purchase','synthetic-payment-key','payment',1234,'EUR','2026-10-13','synthetic',1,'user-confirmed')",
    )
    .bind(tenant.userId)
    .run();
});
beforeEach(async () => {
  await db.prepare("DELETE FROM archive_objects").run();
  await db.prepare("DELETE FROM archive_folders").run();
  await db.prepare("DELETE FROM archive_settings").run();
  await db.prepare("DELETE FROM documents").run();
  await db.prepare("DELETE FROM source_messages").run();
  await db.prepare("DELETE FROM connections").run();
  for (const [id, kind, provider] of [
    ["synthetic-mail", "mailbox", "gmail"],
    ["synthetic-drive", "storage", "google-drive"],
  ]) {
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,credential_ciphertext,credential_key_version,scopes) VALUES(?,?,?,?,?,'synthetic@example.test','synthetic-sealed',1,?)",
      )
      .bind(
        id,
        tenant.userId,
        kind,
        provider,
        `synthetic-subject-${id}`,
        JSON.stringify(["https://www.googleapis.com/auth/drive.file"]),
      )
      .run();
  }
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('synthetic-source',?,'synthetic-mail','synthetic-message',0,1)",
    )
    .bind(tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('synthetic-doc',?,'synthetic-source','1',?,'application/pdf',?)",
    )
    .bind(tenant.userId, sha256, bytes.length)
    .run();
  await db
    .prepare(
      "INSERT INTO archive_settings(user_id,enabled,version,connection_id,connection_generation,disclosure_version,accepted_at) VALUES(?,1,1,'synthetic-drive',1,1,?)",
    )
    .bind(tenant.userId, Date.now())
    .run();
});
async function financialSnapshot() {
  const rows = await db
    .prepare("SELECT * FROM ledger_entries WHERE user_id=? ORDER BY id")
    .bind(tenant.userId)
    .all();
  return rows.results;
}
function ports(remote: ArchiveWorkflowRemote): ArchiveWorkflowPorts {
  return {
    objects: createArchiveObjectStore(db),
    folders: createArchiveFolderStore(db),
    originals: {
      async read(_context, work, control) {
        await control.authorize();
        return {
          status: "ready",
          bytes: new Uint8Array(bytes),
          mimeType: "application/pdf",
          sourceIdentity: {
            providerMessageId: work.providerMessageId,
            partKey: work.partKey,
            sha256,
            mimeType: "application/pdf",
            size: bytes.length,
          },
        };
      },
    },
    openRemote: async (_context, _work, control) => {
      await control.authorize();
      return remote;
    },
    workspaceMarker: async () => "synthetic-workflow-workspace-marker",
  };
}
async function pendingObject() {
  return createArchiveObjectStore(db).request(tenant, {
    documentId: "synthetic-doc",
    storageConnectionId: "synthetic-drive",
    settingsVersion: 1,
  });
}
describe("T18 native archive workflow first multipart slice", () => {
  it("persists each exact remote ID before creation and completes the durable original without money writes", async () => {
    let generated = 0;
    const remote: ArchiveWorkflowRemote = {
      generateFileId: async () =>
        ++generated === 1 ? "synthetic-folder-id" : "synthetic-file-id",
      ensureFolder: async (plan) => {
        expect(
          await db
            .prepare(
              "SELECT planned_file_id FROM archive_folders WHERE user_id=? AND connection_id='synthetic-drive'",
            )
            .bind(tenant.userId)
            .first(),
        ).toEqual({ planned_file_id: plan.fileId });
      },
      inspectOriginal: async () => false,
      uploadOriginal: async (plan, original) => {
        expect(original).toEqual(bytes);
        expect(plan).toMatchObject({
          fileId: "synthetic-file-id",
          parentId: "synthetic-folder-id",
          mimeType: "application/pdf",
          size: bytes.length,
          sha256,
        });
        expect(
          await db
            .prepare(
              "SELECT planned_file_id,original_sha256 FROM archive_objects WHERE user_id=?",
            )
            .bind(tenant.userId)
            .first(),
        ).toEqual({ planned_file_id: plan.fileId, original_sha256: sha256 });
      },
    };
    const objectId = await pendingObject();
    const before = await financialSnapshot();
    await expect(
      createArchiveWorkflow(ports(remote)).run(
        tenant,
        objectId,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "archived" });
    expect(
      await db
        .prepare(
          "SELECT state,remote_id FROM archive_objects WHERE user_id=? AND id=?",
        )
        .bind(tenant.userId, objectId)
        .first(),
    ).toEqual({ state: "archived", remote_id: "synthetic-file-id" });
    expect(await financialSnapshot()).toEqual(before);
    expect(generated).toBe(2);
  });
  it("does not allocate remote IDs after source identity bytes no longer match the admitted document", async () => {
    const generateFileId = vi.fn(async () => "synthetic-unused-id");
    const remote: ArchiveWorkflowRemote = {
      generateFileId,
      ensureFolder: vi.fn(async () => {}),
      inspectOriginal: vi.fn(async () => false),
      uploadOriginal: vi.fn(async () => {}),
    };
    const configured = ports(remote);
    configured.originals = {
      async read(_context, work, control) {
        await control.authorize();
        return {
          status: "ready",
          bytes: new Uint8Array([1, 255, 10, 13, 128, 65]),
          mimeType: "application/pdf",
          sourceIdentity: {
            providerMessageId: work.providerMessageId,
            partKey: work.partKey,
            sha256: "0".repeat(64),
            mimeType: "application/pdf",
            size: bytes.length,
          },
        };
      },
    };
    await expect(
      createArchiveWorkflow(configured).run(
        tenant,
        await pendingObject(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(generateFileId).not.toHaveBeenCalled();
    expect(
      await db
        .prepare(
          "SELECT planned_file_id,state FROM archive_objects WHERE user_id=?",
        )
        .bind(tenant.userId)
        .first(),
    ).toEqual({ planned_file_id: null, state: "pending" });
  });
});

const cipher = createCredentialCipher({
  activeVersion: 1,
  keys: {
    1: btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_"),
  },
});
const unusedAuthorization: ArchiveAuthorizationPort = {
  authorize: async () => {
    throw new Error("Synthetic workflow must not authorize");
  },
  exchange: async () => {
    throw new Error("Synthetic workflow must not exchange");
  },
  refresh: async () => {
    throw new Error("Synthetic fresh credentials must not refresh");
  },
};
async function sealFreshCredentials() {
  for (const connectionId of ["synthetic-mail", "synthetic-drive"]) {
    const ciphertext = await cipher.seal(
      tenant,
      {
        entityId: connectionId,
        purpose:
          connectionId === "synthetic-mail"
            ? "mailbox-credentials"
            : "storage-credentials",
      },
      {
        accessToken: `synthetic-access-${connectionId}`,
        refreshToken: `synthetic-refresh-${connectionId}`,
        expiresAt: Date.now() + 3600000,
      },
    );
    await db
      .prepare(
        "UPDATE connections SET credential_ciphertext=?,credential_key_version=1,scopes=? WHERE user_id=? AND id=?",
      )
      .bind(
        ciphertext,
        JSON.stringify(
          connectionId === "synthetic-mail"
            ? [
                "openid",
                "email",
                "profile",
                "https://www.googleapis.com/auth/gmail.readonly",
              ]
            : [
                "openid",
                "email",
                "profile",
                "https://www.googleapis.com/auth/drive.file",
              ],
        ),
        tenant.userId,
        connectionId,
      )
      .run();
  }
}
it("composes actual encrypted credentials, exact Gmail original bytes and fenced Drive HTTP within forty SQL statements", async () => {
  await sealFreshCredentials();
  const objectId = await pendingObject();
  const stored = new Map<string, Record<string, unknown>>();
  let ids = 0;
  const mailFetcher: typeof fetch = vi.fn(async (input) => {
    expect(String(input)).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/synthetic-message?format=full&fields=id,payload",
    );
    return Response.json({
      id: "synthetic-message",
      payload: {
        partId: "1",
        mimeType: "application/pdf",
        filename: "receipt.pdf",
        body: {
          size: bytes.length,
          data: btoa(String.fromCharCode(...bytes))
            .replace(/=+$/, "")
            .replace(/\+/g, "-")
            .replace(/\//g, "_"),
        },
      },
    });
  });
  const driveHttp = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    expect(request.headers.get("Authorization")).toBe(
      "Bearer synthetic-access-synthetic-drive",
    );
    if (url.pathname.endsWith("/generateIds"))
      return Response.json({
        kind: "drive#generatedIds",
        space: "drive",
        ids: [++ids === 1 ? "synthetic-real-folder" : "synthetic-real-file"],
      });
    if (request.method === "GET") {
      const id = url.pathname.split("/").at(-1) ?? "";
      return stored.has(id)
        ? Response.json(stored.get(id))
        : new Response(null, { status: 404 });
    }
    if (url.pathname === "/drive/v3/files") {
      const body = (await request.json()) as Record<string, unknown>;
      expect(
        await db
          .prepare(
            "SELECT planned_file_id FROM archive_folders WHERE user_id=?",
          )
          .bind(tenant.userId)
          .first(),
      ).toEqual({ planned_file_id: body.id });
      const metadata = { ...body, ownedByMe: true, trashed: false };
      stored.set(String(body.id), metadata);
      return Response.json(metadata);
    }
    expect(url.pathname).toBe("/upload/drive/v3/files");
    const body = new Uint8Array(await request.arrayBuffer());
    const start = new TextDecoder().decode(body).indexOf("{");
    const marker = new TextEncoder().encode("\r\n\r\n");
    const prefix = new TextDecoder()
      .decode(body.subarray(start))
      .split("\r\n")[0];
    if (!prefix) throw new Error("Synthetic multipart metadata missing");
    const metadata = JSON.parse(prefix) as Record<string, unknown>;
    let separators = 0,
      binaryStart = -1;
    for (let i = 0; i < body.length - marker.length; i++)
      if (
        marker.every((value, index) => body[i + index] === value) &&
        ++separators === 2
      ) {
        binaryStart = i + marker.length;
        break;
      }
    expect(binaryStart).toBeGreaterThan(0);
    expect(body.subarray(binaryStart, binaryStart + bytes.length)).toEqual(
      bytes,
    );
    expect(
      await db
        .prepare(
          "SELECT planned_file_id,original_sha256 FROM archive_objects WHERE user_id=? AND id=?",
        )
        .bind(tenant.userId, objectId)
        .first(),
    ).toEqual({ planned_file_id: metadata.id, original_sha256: sha256 });
    const result = {
      ...metadata,
      size: String(bytes.length),
      sha256Checksum: sha256,
      ownedByMe: true,
      trashed: false,
    };
    stored.set(String(metadata.id), result);
    return Response.json(result);
  });
  const meter = createInvocationDatabase(db, 40);
  const before = await financialSnapshot();
  await expect(
    createDriveArchiveWorkflow({
      db: meter.db,
      remainingStatements: meter.remainingStatements,
      cipher,
      driveAuthorization: () => unusedAuthorization,
      refreshMailbox: async () => {
        throw new Error("Synthetic fresh mailbox must not refresh");
      },
      driveHttp,
      mailFetcher,
    }).run(tenant, objectId, new AbortController().signal),
  ).resolves.toEqual({ status: "archived" });
  expect(meter.executedStatements()).toBe(33);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  expect(mailFetcher).toHaveBeenCalledTimes(1);
  expect(ids).toBe(2);
  expect(await financialSnapshot()).toEqual(before);
});

it.each(["synthetic-mail", "synthetic-drive"] as const)(
  "preserves typed refusal when %s credentials change between source HTTP requests",
  async (connectionId) => {
    await sealFreshCredentials();
    const objectId = await pendingObject();
    const mailFetcher: typeof fetch = vi.fn(async () => {
      await db
        .prepare(
          "UPDATE connections SET credential_version=credential_version+1 WHERE user_id=? AND id=?",
        )
        .bind(tenant.userId, connectionId)
        .run();
      return Response.json({
        id: "synthetic-message",
        payload: {
          partId: "1",
          mimeType: "application/pdf",
          filename: "receipt.pdf",
          body: { size: bytes.length, attachmentId: "synthetic-attachment" },
        },
      });
    });
    const driveHttp = vi.fn(async () => {
      throw new Error("Synthetic revoked source must not reach Drive");
    });
    const before = await financialSnapshot();
    const meter = createInvocationDatabase(db, 40);
    await expect(
      createDriveArchiveWorkflow({
        db: meter.db,
        remainingStatements: meter.remainingStatements,
        cipher,
        driveAuthorization: () => unusedAuthorization,
        refreshMailbox: async () => {
          throw new Error("Synthetic fresh mailbox must not refresh");
        },
        driveHttp,
        mailFetcher,
      }).run(tenant, objectId, new AbortController().signal),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mailFetcher).toHaveBeenCalledTimes(1);
    expect(driveHttp).not.toHaveBeenCalled();
    expect(
      await db
        .prepare(
          "SELECT planned_file_id,state FROM archive_objects WHERE user_id=? AND id=?",
        )
        .bind(tenant.userId, objectId)
        .first(),
    ).toEqual({ planned_file_id: null, state: "pending" });
    expect(await financialSnapshot()).toEqual(before);
  },
);

it("defers after one fenced Drive refresh with zero original reads or ID allocation and a released own lease", async () => {
  await sealFreshCredentials();
  const expired = await cipher.seal(
    tenant,
    { entityId: "synthetic-drive", purpose: "storage-credentials" },
    {
      accessToken: "synthetic-expired-drive-access",
      refreshToken: "synthetic-expired-drive-refresh",
      expiresAt: Date.now() - 1000,
    },
  );
  await db
    .prepare(
      "UPDATE connections SET credential_ciphertext=? WHERE user_id=? AND id='synthetic-drive'",
    )
    .bind(expired, tenant.userId)
    .run();
  const objectId = await pendingObject();
  const mailFetcher: typeof fetch = vi.fn(async () => {
    throw new Error("Synthetic deferred workflow must not read originals");
  });
  const driveHttp = vi.fn(async () => {
    throw new Error("Synthetic deferred workflow must not allocate IDs");
  });
  const refresh = vi.fn(
    async (_credentials: ArchiveCredentials, expected: ArchiveIdentity) => {
      expect(expected).toEqual({
        subject: "synthetic-subject-synthetic-drive",
        address: "synthetic@example.test",
      });
      return {
        accessToken: "synthetic-refreshed-drive-access",
        expiresAt: Date.now() + 3600000,
      };
    },
  );
  const meter = createInvocationDatabase(db, 40);
  await expect(
    createDriveArchiveWorkflow({
      db: meter.db,
      remainingStatements: meter.remainingStatements,
      cipher,
      driveAuthorization: (authorize) => ({
        ...unusedAuthorization,
        refresh: async (credentials, expected) => {
          await authorize();
          return refresh(credentials, expected);
        },
      }),
      refreshMailbox: async () => {
        throw new Error("Synthetic fresh mailbox must not refresh");
      },
      driveHttp,
      mailFetcher,
    }).run(tenant, objectId, new AbortController().signal),
  ).resolves.toEqual({ status: "deferred" });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(mailFetcher).not.toHaveBeenCalled();
  expect(driveHttp).not.toHaveBeenCalled();
  expect(meter.executedStatements()).toBe(19);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  expect(
    await db
      .prepare(
        "SELECT state,planned_file_id,lease_id,lease_expires_at FROM archive_objects WHERE user_id=? AND id=?",
      )
      .bind(tenant.userId, objectId)
      .first(),
  ).toEqual({
    state: "pending",
    planned_file_id: null,
    lease_id: null,
    lease_expires_at: 0,
  });
  expect(
    await db
      .prepare(
        "SELECT credential_version FROM connections WHERE user_id=? AND id='synthetic-drive'",
      )
      .bind(tenant.userId)
      .first(),
  ).toEqual({ credential_version: 1 });
});

it("refuses to release a replaced object lease or clear its higher fence", async () => {
  const objects = createArchiveObjectStore(db);
  const objectId = await pendingObject();
  const work = await objects.claim(tenant, objectId);
  if (!work) throw new Error("Synthetic archive work unavailable");
  await db
    .prepare(
      "UPDATE archive_objects SET lease_id='synthetic-newer-lease',fence=fence+1 WHERE user_id=? AND id=?",
    )
    .bind(tenant.userId, objectId)
    .run();
  await expect(objects.release(tenant, work.lease)).resolves.toBe(false);
  expect(
    await db
      .prepare(
        "SELECT lease_id,fence FROM archive_objects WHERE user_id=? AND id=?",
      )
      .bind(tenant.userId, objectId)
      .first(),
  ).toEqual({ lease_id: "synthetic-newer-lease", fence: work.lease.fence + 1 });
});

it("archives a canonical Outlook Mail.Read grant as exact original EML without external reference fetches", async () => {
  await sealFreshCredentials();
  const content = "Synthetic receipt body";
  const selected = new TextEncoder().encode(content);
  const selectedHash = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", selected)),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const original = new TextEncoder().encode(
    "From: synthetic@example.test\r\nSubject: Synthetic receipt\r\nContent-Type: text/plain\r\n\r\n" +
      content,
  );
  const originalHash = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", original)),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await db
    .prepare(
      "UPDATE connections SET provider='outlook',scopes=? WHERE user_id=? AND id='synthetic-mail'",
    )
    .bind(JSON.stringify(OUTLOOK_AUTHORIZATION_SCOPES), tenant.userId)
    .run();
  await db
    .prepare(
      "UPDATE documents SET part_key='body',content_hash=?,mime='text/plain',byte_length=? WHERE user_id=? AND id='synthetic-doc'",
    )
    .bind(selectedHash, selected.length, tenant.userId)
    .run();
  const objectId = await pendingObject();
  const mailUrls: string[] = [];
  const mailFetcher: typeof fetch = vi.fn(async (input) => {
    const url = String(input);
    mailUrls.push(url);
    const base =
      "https://graph.microsoft.com/v1.0/me/messages/synthetic-message";
    if (url === `${base}?$select=id,body,hasAttachments`)
      return Response.json({
        id: "synthetic-message",
        body: { contentType: "text", content },
        hasAttachments: false,
      });
    if (url === `${base}/attachments?$top=8`)
      return Response.json({ value: [] });
    if (url === `${base}?$select=id`)
      return Response.json({ id: "synthetic-message" });
    expect(url).toBe(`${base}/$value`);
    return new Response(original, {
      headers: { "Content-Type": "message/rfc822" },
    });
  });
  const saved = new Map<string, Record<string, unknown>>();
  let ids = 0;
  const driveHttp = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/generateIds"))
      return Response.json({
        kind: "drive#generatedIds",
        space: "drive",
        ids: [
          ++ids === 1 ? "synthetic-outlook-folder" : "synthetic-outlook-eml",
        ],
      });
    if (request.method === "GET") {
      const id = url.pathname.split("/").at(-1) ?? "";
      return saved.has(id)
        ? Response.json(saved.get(id))
        : new Response(null, { status: 404 });
    }
    if (url.pathname === "/drive/v3/files") {
      const input = (await request.json()) as Record<string, unknown>;
      const value = { ...input, ownedByMe: true, trashed: false };
      saved.set(String(input.id), value);
      return Response.json(value);
    }
    expect(url.pathname).toBe("/upload/drive/v3/files");
    const body = new Uint8Array(await request.arrayBuffer());
    const text = new TextDecoder().decode(body);
    const prefix = text.slice(text.indexOf("{")).split("\r\n")[0];
    if (!prefix) throw new Error("Synthetic EML metadata missing");
    const input = JSON.parse(prefix) as Record<string, unknown>;
    expect(input.mimeType).toBe("message/rfc822");
    expect(input.appProperties).toMatchObject({ sha256: originalHash });
    expect(text).toContain(new TextDecoder().decode(original));
    const value = {
      ...input,
      size: String(original.length),
      sha256Checksum: originalHash,
      ownedByMe: true,
      trashed: false,
    };
    saved.set(String(input.id), value);
    return Response.json(value);
  });
  const meter = createInvocationDatabase(db, 40);
  await expect(
    createDriveArchiveWorkflow({
      db: meter.db,
      remainingStatements: meter.remainingStatements,
      cipher,
      driveAuthorization: () => unusedAuthorization,
      refreshMailbox: async () => {
        throw new Error("Synthetic fresh Outlook mailbox must not refresh");
      },
      driveHttp,
      mailFetcher,
    }).run(tenant, objectId, new AbortController().signal),
  ).resolves.toEqual({ status: "archived" });
  expect(mailUrls).toEqual([
    "https://graph.microsoft.com/v1.0/me/messages/synthetic-message?$select=id,body,hasAttachments",
    "https://graph.microsoft.com/v1.0/me/messages/synthetic-message/attachments?$top=8",
    "https://graph.microsoft.com/v1.0/me/messages/synthetic-message?$select=id",
    "https://graph.microsoft.com/v1.0/me/messages/synthetic-message/$value",
  ]);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("refuses a shortened ungranted Outlook scope before any source or Drive HTTP", async () => {
  await sealFreshCredentials();
  await db
    .prepare(
      "UPDATE connections SET provider='outlook',scopes=? WHERE user_id=? AND id='synthetic-mail'",
    )
    .bind(JSON.stringify(["openid", "Mail.Read"]), tenant.userId)
    .run();
  const objectId = await pendingObject();
  const mailFetcher: typeof fetch = vi.fn(async () => {
    throw new Error("Synthetic missing canonical scope must not fetch");
  });
  const driveHttp = vi.fn(async () => {
    throw new Error("Synthetic missing canonical scope must not allocate IDs");
  });
  const meter = createInvocationDatabase(db, 40);
  await expect(
    createDriveArchiveWorkflow({
      db: meter.db,
      remainingStatements: meter.remainingStatements,
      cipher,
      driveAuthorization: () => unusedAuthorization,
      refreshMailbox: async () => {
        throw new Error("Synthetic missing canonical scope must not refresh");
      },
      driveHttp,
      mailFetcher,
    }).run(tenant, objectId, new AbortController().signal),
  ).rejects.toMatchObject({ code: "MISSING_PERMISSION" });
  expect(mailFetcher).not.toHaveBeenCalled();
  expect(driveHttp).not.toHaveBeenCalled();
});
