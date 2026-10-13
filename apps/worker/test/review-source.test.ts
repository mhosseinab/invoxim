import { env } from "cloudflare:workers";
import type { GmailConfiguration } from "@invoxim/adapters";
import { createCredentialCipher } from "@invoxim/adapters";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import {
  createReviewSourceReader,
  loadGmailReviewHeaders,
} from "../../../packages/adapters/src/purchase-views/review-source";

const tenant = { userId: "source-a", authority: "session" } as TenantContext;
const cipher = createCredentialCipher({
  activeVersion: 1,
  keys: { 1: btoa("x".repeat(32)).replace(/=+$/, "") },
});
const configuration: GmailConfiguration = {
  cipher,
  provider: "gmail",
  scopes: [],
  oauthProvider: "google",
  clientId: "synthetic",
  clientSecret: "synthetic",
  callback: "https://example.invalid",
  limit: 3,
  login: {
    origin: "https://example.invalid",
    secret: "synthetic-secret-at-least-32-long",
    googleClientId: "synthetic",
    googleClientSecret: "synthetic",
    allowedEmails: [],
  },
};
beforeAll(async () => {
  for (const sql of baseline.split(";").filter((value) => value.trim()))
    await env.DB.prepare(sql).run();
  await env.DB.prepare(
    "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES('source-a','Synthetic','synthetic@example.invalid',1,0,0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO profiles(user_id,created_at,updated_at) VALUES('source-a',0,0)",
  ).run();
  const encrypted = await cipher.seal(
    tenant,
    { entityId: "mailbox", purpose: "mailbox-credentials" },
    { accessToken: "synthetic-access-token", expiresAt: Date.now() + 600000 },
  );
  await env.DB.prepare(
    "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state,generation,credential_ciphertext,credential_key_version,credential_version) VALUES('mailbox','source-a','mailbox','gmail','synthetic','synthetic@example.invalid','connected',1,?,1,1)",
  )
    .bind(encrypted)
    .run();
  await env.DB.prepare(
    "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('source','source-a','mailbox','api-id',1000,1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('doc','source-a','source','body','hash','text/plain',10)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO review_items(id,user_id,document_id,reason,blocking_scope,created_at) VALUES('review','source-a','doc','extraction-review','financial',0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES('consent','source-a','mailbox',1,'synthetic','local',0,0,1)",
  ).run();
});
const metadata = (headers: { name: string; value: string }[]) =>
  Response.json({ id: "api-id", payload: { headers } });
it("explicit source lookup fetches only headers and returns inert identity plus exact Gmail search", async () => {
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://gmail.googleapis.com");
      expect(url.searchParams.get("format")).toBe("metadata");
      expect(url.searchParams.getAll("metadataHeaders")).toEqual([
        "Subject",
        "From",
        "Message-ID",
      ]);
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeTruthy();
      return metadata([
        { name: "Subject", value: "<script>alert(1)</script>" },
        { name: "From", value: "Synthetic sender" },
        { name: "Message-ID", value: "<invoice@example.invalid>" },
      ]);
    },
  );
  const result = await createReviewSourceReader(
    env.DB,
    configuration,
    fetcher,
  ).read(tenant, "review");
  expect(result.subject).toBe("<script>alert(1)</script>");
  expect(result.originalUrl).toBe(
    "https://mail.google.com/mail/?authuser=synthetic%40example.invalid#search/rfc822msgid%3Ainvoice%40example.invalid",
  );
  expect(
    JSON.stringify(
      (await env.DB.prepare("SELECT * FROM source_messages").all()).results,
    ),
  ).not.toContain("alert");
});
it("cross-tenant and unknown reviews never fetch", async () => {
  const fetcher = vi.fn();
  const reader = createReviewSourceReader(env.DB, configuration, fetcher);
  await expect(
    reader.read(
      { userId: "source-b", authority: "session" } as TenantContext,
      "review",
    ),
  ).rejects.toThrow("not_found");
  await expect(reader.read(tenant, "missing")).rejects.toThrow("not_found");
  expect(fetcher).not.toHaveBeenCalled();
});
it("revoked consent or source disconnect during provider read prevents returning header content", async () => {
  const fetcher = vi.fn(async () => {
    await env.DB.prepare(
      "UPDATE processing_consents SET revoked_at=1 WHERE id='consent'",
    ).run();
    return metadata([{ name: "Subject", value: "private synthetic" }]);
  });
  await expect(
    createReviewSourceReader(env.DB, configuration, fetcher).read(
      tenant,
      "review",
    ),
  ).rejects.toThrow("source_changed");
  await env.DB.prepare(
    "UPDATE processing_consents SET revoked_at=NULL WHERE id='consent'",
  ).run();
  await env.DB.prepare(
    "UPDATE connections SET state='disconnected' WHERE id='mailbox'",
  ).run();
  await expect(
    createReviewSourceReader(env.DB, configuration, fetcher).read(
      tenant,
      "review",
    ),
  ).rejects.toThrow("not_found");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("malicious Message-ID never becomes a search query or external destination", async () => {
  const result = await loadGmailReviewHeaders(
    "api-id",
    "synthetic",
    "synthetic@example.invalid",
    async () =>
      metadata([
        {
          name: "Message-ID",
          value: "<x@example.invalid> OR in:anywhere https://evil.invalid",
        },
      ]),
  );
  expect(result.originalUrl).toBeNull();
});
it("oversized headers and redirects are rejected", async () => {
  await expect(
    loadGmailReviewHeaders(
      "api-id",
      "synthetic",
      "synthetic@example.invalid",
      async () => new Response("x".repeat(16385)),
    ),
  ).rejects.toThrow("source_unavailable");
  await expect(
    loadGmailReviewHeaders(
      "api-id",
      "synthetic",
      "synthetic@example.invalid",
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.invalid" },
        }),
    ),
  ).rejects.toThrow("source_unavailable");
});

it("source generation changes during header lookup discard transient response", async () => {
  await env.DB.prepare(
    "UPDATE connections SET state='connected' WHERE id='mailbox'",
  ).run();
  const fetcher = vi.fn(async () => {
    await env.DB.prepare(
      "UPDATE source_messages SET available=0 WHERE id='source'",
    ).run();
    return metadata([{ name: "Subject", value: "synthetic discarded" }]);
  });
  await expect(
    createReviewSourceReader(env.DB, configuration, fetcher).read(
      tenant,
      "review",
    ),
  ).rejects.toThrow("source_changed");
  await env.DB.prepare(
    "UPDATE source_messages SET available=1 WHERE id='source'",
  ).run();
});
it("wrong message metadata cannot identify a review", async () => {
  await expect(
    loadGmailReviewHeaders(
      "api-id",
      "synthetic",
      "synthetic@example.invalid",
      async () =>
        Response.json({ id: "other-message", payload: { headers: [] } }),
    ),
  ).rejects.toThrow("source_unavailable");
});
