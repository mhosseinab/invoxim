import { env } from "cloudflare:workers";
import { createLoginAuth, createProfileService } from "@invoxim/adapters";
import type { ArchiveAuthorizationPort, TenantContext } from "@invoxim/core";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import sessionMigration from "../../../packages/adapters/migrations/0002_archive_upload_sessions.sql?raw";
import backfillMigration from "../../../packages/adapters/migrations/0006_archive_dispatch_backfill.sql?raw";
import { createArchiveObjectStore } from "../../../packages/adapters/src/drive/objects";
import { createDriveArchiveWorkflow } from "../../../packages/adapters/src/drive/workflow";
import { createCredentialCipher } from "../../../packages/adapters/src/security/cipher";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;
let tenant: TenantContext;
const selectedText = "Synthetic exact body receipt.";
const bytes = new TextEncoder().encode(selectedText);
const originalText =
  "From: synthetic@example.test\r\nContent-Type: text/plain\r\n\r\n" +
  selectedText +
  "x".repeat(6 * 1024 * 1024);
const originalBytes = new TextEncoder().encode(originalText);
let sha256: string, originalHash: string;
async function hash(value: Uint8Array) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function base64url(value: string) {
  return btoa(value).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
const login = {
  origin: "https://synthetic.example",
  secret: "synthetic-workflow-login-secret-123456789",
  googleClientId: "synthetic-login.apps.googleusercontent.com",
  googleClientSecret: "synthetic-login-secret",
  allowedEmails: ["workflow-login@example.test"],
};

beforeAll(async () => {
  sha256 = await hash(bytes);
  originalHash = await hash(originalBytes);
  for (const sql of [baseline, sessionMigration, backfillMigration])
    for (const statement of sql.split(";").filter((value) => value.trim()))
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
  await db.prepare("DELETE FROM archive_upload_sessions").run();
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
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('synthetic-doc',?,'synthetic-source','body',?,'text/plain',?)",
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

const cipher = createCredentialCipher({
  activeVersion: 1,
  keys: {
    1: base64url(String.fromCharCode(...new Uint8Array(32).fill(9))),
  },
});
const unusedAuthorization: ArchiveAuthorizationPort = {
  authorize: async () => {
    throw new Error("Synthetic unexpected OAuth");
  },
  exchange: async () => {
    throw new Error("Synthetic unexpected OAuth");
  },
  refresh: async () => {
    throw new Error("Synthetic unexpected refresh");
  },
};
async function credentials() {
  for (const id of ["synthetic-mail", "synthetic-drive"]) {
    const sealed = await cipher.seal(
      tenant,
      {
        entityId: id,
        purpose:
          id === "synthetic-mail"
            ? "mailbox-credentials"
            : "storage-credentials",
      },
      {
        accessToken: `synthetic-access-${id}`,
        refreshToken: `synthetic-refresh-${id}`,
        expiresAt: Date.now() + 3600000,
      },
    );
    await db
      .prepare(
        "UPDATE connections SET credential_ciphertext=?,scopes=? WHERE user_id=? AND id=?",
      )
      .bind(
        sealed,
        JSON.stringify([
          id === "synthetic-mail"
            ? "https://www.googleapis.com/auth/gmail.readonly"
            : "https://www.googleapis.com/auth/drive.file",
        ]),
        tenant.userId,
        id,
      )
      .run();
  }
}

it("stages a six-MiB Gmail original with durable IDs/encrypted session before bytes and reconciles a lost final response with three settlement statements reserved", async () => {
  await credentials();
  const financial = await financialSnapshot();
  const objectId = await createArchiveObjectStore(db).request(tenant, {
    documentId: "synthetic-doc",
    storageConnectionId: "synthetic-drive",
    settingsVersion: 1,
  });
  const stored = new Map<string, Record<string, unknown>>();
  const sessionUrl =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=synthetic-staged-session";
  let generated = 0,
    uploaded = 0,
    starts = 0,
    probes = 0;
  const chunkSizes: number[] = [];
  const mailFetcher: typeof fetch = vi.fn(async (input) => {
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/synthetic-message",
    );
    if (url.searchParams.get("format") === "full") {
      expect(url.searchParams.get("fields")).toBe("id,payload");
      return Response.json({
        id: "synthetic-message",
        payload: {
          partId: "body",
          mimeType: "text/plain",
          body: { size: bytes.length, data: base64url(selectedText) },
        },
      });
    }
    expect(url.searchParams.get("format")).toBe("raw");
    expect(url.searchParams.get("fields")).toBe("id,raw");
    return Response.json({
      id: "synthetic-message",
      raw: base64url(originalText),
    });
  });
  const driveHttp = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    expect(url.origin).toBe("https://www.googleapis.com");
    expect(request.headers.get("Authorization")).toBe(
      "Bearer synthetic-access-synthetic-drive",
    );
    if (url.pathname.endsWith("/generateIds")) {
      return Response.json({
        kind: "drive#generatedIds",
        space: "drive",
        ids: [
          ++generated === 1
            ? "synthetic-staged-folder"
            : "synthetic-staged-file",
        ],
      });
    }
    if (request.method === "GET") {
      const id = url.pathname.split("/").at(-1) ?? "";
      return stored.has(id)
        ? Response.json(stored.get(id))
        : new Response(null, { status: 404 });
    }
    if (url.pathname === "/drive/v3/files") {
      const metadata = (await request.json()) as Record<string, unknown>;
      expect(
        await db
          .prepare(
            "SELECT planned_file_id FROM archive_folders WHERE user_id=?",
          )
          .bind(tenant.userId)
          .first(),
      ).toEqual({ planned_file_id: metadata.id });
      const folder = { ...metadata, ownedByMe: true, trashed: false };
      stored.set(String(metadata.id), folder);
      return Response.json(folder);
    }
    expect(url.pathname).toBe("/upload/drive/v3/files");
    expect(url.searchParams.get("uploadType")).toBe("resumable");
    if (request.method === "POST") {
      starts++;
      expect(url.searchParams.has("upload_id")).toBe(false);
      const metadata = (await request.json()) as Record<string, unknown>;
      expect(
        await db
          .prepare(
            "SELECT planned_file_id,original_size,original_sha256 FROM archive_objects WHERE user_id=? AND id=?",
          )
          .bind(tenant.userId, objectId)
          .first(),
      ).toEqual({
        planned_file_id: "synthetic-staged-file",
        original_size: originalBytes.length,
        original_sha256: originalHash,
      });
      expect(metadata.id).toBe("synthetic-staged-file");
      stored.set("synthetic-pending-metadata", metadata);
      return new Response(null, {
        status: 200,
        headers: { Location: sessionUrl },
      });
    }
    expect(request.url).toBe(sessionUrl);
    const body = new Uint8Array(await request.arrayBuffer());
    if (
      request.headers.get("Content-Range") === `bytes */${originalBytes.length}`
    ) {
      probes++;
      expect(body.length).toBe(0);
      return uploaded === originalBytes.length
        ? new Response(null, { status: 200 })
        : new Response(null, {
            status: 308,
            headers: uploaded ? { Range: `bytes=0-${uploaded - 1}` } : {},
          });
    }
    const persisted = await db
      .prepare(
        "SELECT reference_ciphertext,uploaded_bytes FROM archive_upload_sessions WHERE user_id=? AND object_id=?",
      )
      .bind(tenant.userId, objectId)
      .first<{ reference_ciphertext: string; uploaded_bytes: number }>();
    expect(persisted).not.toBeNull();
    expect(persisted?.reference_ciphertext).not.toContain("upload_id");
    expect(persisted?.uploaded_bytes).toBe(uploaded);
    expect(request.headers.get("Content-Range")).toBe(
      `bytes ${uploaded}-${uploaded + body.length - 1}/${originalBytes.length}`,
    );
    expect(await hash(body)).toBe(
      await hash(originalBytes.subarray(uploaded, uploaded + body.length)),
    );
    expect(body.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    chunkSizes.push(body.length);
    uploaded += body.length;
    if (uploaded === originalBytes.length) {
      const metadata = stored.get("synthetic-pending-metadata");
      if (!metadata) throw new Error("Synthetic upload plan absent");
      stored.set("synthetic-staged-file", {
        ...metadata,
        size: String(originalBytes.length),
        sha256Checksum: originalHash,
        ownedByMe: true,
        trashed: false,
      });
      throw new Error("Synthetic lost completed response");
    }
    return new Response(null, {
      status: 308,
      headers: { Range: `bytes=0-${uploaded - 1}` },
    });
  });
  const counts: number[] = [];
  for (const [index, expected] of [
    "deferred",
    "deferred",
    "deferred",
    "archived",
  ].entries()) {
    const invocation = createInvocationDatabase(db, 40);
    for (let prefix = 0; prefix < 4; prefix++)
      await invocation.db.prepare("SELECT 1").first();
    const configured = {
      db: invocation.db,
      remainingStatements: invocation.remainingStatements,
      cipher,
      driveHttp,
      mailFetcher,
      driveAuthorization: () => unusedAuthorization,
      refreshMailbox: async () => {
        throw new Error("Synthetic fresh mailbox must not refresh");
      },
    };
    const workflow = createDriveArchiveWorkflow(configured);
    const chunksBefore = chunkSizes.length;
    await expect(
      workflow.run(tenant, objectId, new AbortController().signal),
    ).resolves.toEqual({ status: expected });
    expect(chunkSizes.length - chunksBefore).toBeLessThanOrEqual(1);
    expect(invocation.remainingStatements()).toBeGreaterThanOrEqual(3);
    for (let settlement = 0; settlement < 3; settlement++)
      await invocation.db.prepare("SELECT 1").first();
    counts.push(invocation.executedStatements());
    expect(invocation.executedStatements()).toBeLessThanOrEqual(40);
    if (index === 0) {
      expect(generated).toBe(1);
      expect(starts).toBe(0);
      expect(
        await db
          .prepare(
            "SELECT planned_file_id FROM archive_objects WHERE user_id=? AND id=?",
          )
          .bind(tenant.userId, objectId)
          .first(),
      ).toEqual({ planned_file_id: null });
    }
    if (index === 1) {
      expect(starts).toBe(1);
      expect(uploaded).toBe(0);
    }
  }
  expect(counts).toHaveLength(4);
  expect(generated).toBe(2);
  expect(starts).toBe(1);
  expect(probes).toBe(3);
  expect(chunkSizes).toEqual([
    4 * 1024 * 1024,
    originalBytes.length - 4 * 1024 * 1024,
  ]);
  expect(
    await db
      .prepare(
        "SELECT state,planned_file_id FROM archive_objects WHERE user_id=? AND id=?",
      )
      .bind(tenant.userId, objectId)
      .first(),
  ).toEqual({ state: "archived", planned_file_id: "synthetic-staged-file" });
  expect(await financialSnapshot()).toEqual(financial);
});

it.each([22, 36, 37])(
  "defers a consumed shared invocation with prefix %i before any provider request while preserving three settlement statements",
  async (prefixCount) => {
    await credentials();
    const objectId = await createArchiveObjectStore(db).request(tenant, {
      documentId: "synthetic-doc",
      storageConnectionId: "synthetic-drive",
      settingsVersion: 1,
    });
    const financial = await financialSnapshot();
    const invocation = createInvocationDatabase(db, 40);
    for (let prefix = 0; prefix < prefixCount; prefix++)
      await invocation.db.prepare("SELECT 1").first();
    const driveHttp = vi.fn(async (): Promise<Response> => {
      throw new Error("Synthetic insufficient budget must prevent Drive HTTP");
    });
    const mailFetcher: typeof fetch = vi.fn(async (): Promise<Response> => {
      throw new Error("Synthetic insufficient budget must prevent source HTTP");
    });
    const configured = {
      db: invocation.db,
      remainingStatements: invocation.remainingStatements,
      cipher,
      driveHttp,
      mailFetcher,
      driveAuthorization: () => unusedAuthorization,
      refreshMailbox: async () => {
        throw new Error("Synthetic unexpected refresh");
      },
    };
    await expect(
      createDriveArchiveWorkflow(configured).run(
        tenant,
        objectId,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "deferred" });
    expect(driveHttp).not.toHaveBeenCalled();
    expect(mailFetcher).not.toHaveBeenCalled();
    expect(invocation.executedStatements()).toBeLessThanOrEqual(
      prefixCount >= 36 ? prefixCount : prefixCount + 2,
    );
    expect(
      await db
        .prepare("SELECT fence FROM archive_objects WHERE user_id=? AND id=?")
        .bind(tenant.userId, objectId)
        .first(),
    ).toEqual({ fence: prefixCount >= 36 ? 0 : 1 });
    expect(
      await db
        .prepare(
          "SELECT lease_id,lease_expires_at,planned_file_id,state FROM archive_objects WHERE user_id=? AND id=?",
        )
        .bind(tenant.userId, objectId)
        .first(),
    ).toEqual({
      lease_id: null,
      lease_expires_at: 0,
      planned_file_id: null,
      state: "pending",
    });
    expect(invocation.remainingStatements()).toBeGreaterThanOrEqual(3);
    for (let settlement = 0; settlement < 3; settlement++)
      await invocation.db.prepare("SELECT 1").first();
    expect(invocation.executedStatements()).toBeLessThanOrEqual(40);
    expect(await financialSnapshot()).toEqual(financial);
  },
);
