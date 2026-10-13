import { env } from "cloudflare:workers";
import type { ArchiveAuthorizationPort } from "@invoxim/core";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import sessions from "../../../packages/adapters/migrations/0002_archive_upload_sessions.sql?raw";
import dispatch from "../../../packages/adapters/migrations/0006_archive_dispatch_backfill.sql?raw";
import { createDriveArchiveJob } from "../../../packages/adapters/src/drive/archive-job";
import { createArchiveDispatchStore } from "../../../packages/adapters/src/drive/dispatch-store";
import { createArchiveObjectStore } from "../../../packages/adapters/src/drive/objects";
import { createCredentialCipher } from "../../../packages/adapters/src/security/cipher";
import { createInvocationDatabase } from "../src/invocation-database";
import { owner } from "./onboarding-qa-fixture";

const db = env.DB;
const bytes = new Uint8Array([
  37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 255, 13, 10,
]);
const cipher = createCredentialCipher({
  activeVersion: 1,
  keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
});
const unusedAuthorization: ArchiveAuthorizationPort = {
  async authorize() {
    throw new Error("Archive must not authorize interactively");
  },
  async exchange() {
    throw new Error("Archive must not exchange");
  },
  async refresh() {
    throw new Error("Fresh archive must not refresh");
  },
};
beforeAll(async () => {
  for (const sql of [sessions, dispatch])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
});
afterEach(() => vi.restoreAllMocks());
it.each(["complete", "lost_response", "disabled"] as const)(
  "executes authoritative archive queue work with exact originals and no financial writes: %s",
  async (mode) => {
    const mailId = `synthetic-job-mail-${mode}`,
      storageId = `synthetic-job-drive-${mode}`;
    const session = await owner(`synthetic-archive-job-${mode}`, mailId);
    const context = session.tenant;
    const sha = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes) VALUES(?,?,'storage','google-drive',?,'drive-independent@example.invalid',?)",
      )
      .bind(
        storageId,
        context.userId,
        `synthetic-drive-subject-${mode}`,
        JSON.stringify(["https://www.googleapis.com/auth/drive.file"]),
      )
      .run();
    for (const id of [mailId, storageId]) {
      const ciphertext = await cipher.seal(
        context,
        {
          entityId: id,
          purpose:
            id === mailId ? "mailbox-credentials" : "storage-credentials",
        },
        {
          accessToken: `synthetic-access-${id}`,
          refreshToken: `synthetic-refresh-${id}`,
          expiresAt: Date.now() + 3600000,
        },
      );
      await db
        .prepare(
          "UPDATE connections SET credential_ciphertext=?,credential_key_version=1 WHERE user_id=? AND id=?",
        )
        .bind(ciphertext, context.userId, id)
        .run();
    }
    await db
      .prepare(
        "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES(?,?,?,'synthetic-job-message',0,1)",
      )
      .bind(`synthetic-source-${mode}`, context.userId, mailId)
      .run();
    await db
      .prepare(
        "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES(?,?,?,'1',?,'application/pdf',?)",
      )
      .bind(
        `synthetic-doc-${mode}`,
        context.userId,
        `synthetic-source-${mode}`,
        sha,
        bytes.length,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO archive_settings(user_id,enabled,version,connection_id,connection_generation,disclosure_version,accepted_at) VALUES(?,1,1,?,1,1,?)",
      )
      .bind(context.userId, storageId, Date.now())
      .run();
    const objectId = await createArchiveObjectStore(db).request(context, {
      documentId: `synthetic-doc-${mode}`,
      storageConnectionId: storageId,
      settingsVersion: 1,
    });
    const queueId = `synthetic-opaque-${mode}`,
      store = createArchiveDispatchStore(db);
    expect(await store.enqueue(context, objectId, queueId)).toBe(true);
    const candidate = (await store.due(50)).find(
      (value) => value.queueId === queueId,
    );
    if (!candidate) throw new Error("Synthetic queued candidate unavailable");
    expect(await store.reserve(candidate)).not.toBeNull();
    if (mode === "disabled")
      await db
        .prepare(
          "UPDATE archive_settings SET enabled=0,version=2,connection_id=NULL,connection_generation=NULL,disclosure_version=NULL,accepted_at=NULL WHERE user_id=?",
        )
        .bind(context.userId)
        .run();
    const mailFetcher: typeof fetch = vi.fn(async (input) => {
      expect(String(input)).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/synthetic-job-message?format=full&fields=id,payload",
      );
      return Response.json({
        id: "synthetic-job-message",
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
    const remote = new Map<string, Record<string, unknown>>();
    let ids = 0,
      uploads = 0;
    const driveHttp = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(url.origin).toBe("https://www.googleapis.com");
      if (url.pathname.endsWith("/generateIds"))
        return Response.json({
          kind: "drive#generatedIds",
          space: "drive",
          ids: [`synthetic-planned-${mode}-${++ids}`],
        });
      if (request.method === "GET") {
        const id = url.pathname.split("/").at(-1) ?? "";
        return remote.has(id)
          ? Response.json(remote.get(id))
          : new Response(null, { status: 404 });
      }
      if (url.pathname === "/drive/v3/files") {
        const metadata = (await request.json()) as Record<string, unknown>;
        expect(
          await db
            .prepare(
              "SELECT planned_file_id FROM archive_folders WHERE user_id=?",
            )
            .bind(context.userId)
            .first("planned_file_id"),
        ).toBe(metadata.id);
        const result = { ...metadata, ownedByMe: true, trashed: false };
        remote.set(String(metadata.id), result);
        return Response.json(result);
      }
      expect(url.pathname).toBe("/upload/drive/v3/files");
      uploads++;
      const body = new Uint8Array(await request.arrayBuffer()),
        text = new TextDecoder().decode(body);
      const metadata = JSON.parse(
        text.slice(text.indexOf("{")).split("\r\n")[0] ?? "null",
      ) as Record<string, unknown>;
      const marker = new Uint8Array([13, 10, 13, 10]);
      let delimiters = 0,
        start = -1;
      for (let i = 0; i < body.length - marker.length; i++)
        if (
          marker.every((value, index) => body[i + index] === value) &&
          ++delimiters === 2
        ) {
          start = i + marker.length;
          break;
        }
      expect(start).toBeGreaterThan(0);
      expect(body.subarray(start, start + bytes.length)).toEqual(bytes);
      expect(
        await db
          .prepare(
            "SELECT planned_file_id FROM archive_objects WHERE user_id=? AND id=?",
          )
          .bind(context.userId, objectId)
          .first("planned_file_id"),
      ).toBe(metadata.id);
      const result = {
        ...metadata,
        size: String(bytes.length),
        sha256Checksum: sha,
        ownedByMe: true,
        trashed: false,
      };
      remote.set(String(metadata.id), result);
      if (mode === "lost_response")
        throw new Error("Synthetic uploaded response lost");
      return Response.json(result);
    });
    const financial = async () =>
      (
        await db
          .prepare("SELECT * FROM ledger_entries WHERE user_id=? ORDER BY id")
          .bind(context.userId)
          .all()
      ).results;
    const before = await financial();
    function job() {
      const meter = createInvocationDatabase(db, 40);
      return {
        meter,
        processor: createDriveArchiveJob({
          db: meter.db,
          remainingStatements: meter.remainingStatements,
          cipher,
          driveAuthorization: () => unusedAuthorization,
          refreshMailbox: async () => {
            throw new Error("Fresh mailbox must not refresh");
          },
          mailFetcher,
          driveHttp,
          queue: {
            send: async () => {
              throw new Error("Consumer must not publish");
            },
          },
        }),
      };
    }
    const first = job();
    expect(
      await first.processor.consume({ schemaVersion: 2, archiveId: queueId }),
    ).toBe("ack");
    expect(first.meter.executedStatements()).toBeLessThanOrEqual(40);
    if (mode === "disabled") {
      expect(mailFetcher).not.toHaveBeenCalled();
      expect(driveHttp).not.toHaveBeenCalled();
      expect(uploads).toBe(0);
    } else {
      expect(uploads).toBe(1);
      expect(ids).toBe(2);
      expect(
        await db
          .prepare("SELECT state FROM archive_objects WHERE user_id=? AND id=?")
          .bind(context.userId, objectId)
          .first("state"),
      ).toBe("archived");
      expect(
        await db
          .prepare("SELECT status FROM archive_dispatch WHERE queue_id=?")
          .bind(queueId)
          .first("status"),
      ).toBe("completed");
      const calls = driveHttp.mock.calls.length;
      const replay = job();
      expect(
        await replay.processor.consume({
          schemaVersion: 2,
          archiveId: queueId,
        }),
      ).toBe("ack");
      expect(driveHttp).toHaveBeenCalledTimes(calls);
      expect(mailFetcher).toHaveBeenCalledTimes(1);
    }
    expect(await financial()).toEqual(before);
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM processing_consents WHERE user_id=?")
        .bind(context.userId)
        .first("n"),
    ).toBe(0);
  },
);
