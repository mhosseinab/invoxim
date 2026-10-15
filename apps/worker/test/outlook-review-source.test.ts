import { env } from "cloudflare:workers";
import {
  createCredentialCipher,
  createLoginAuth,
  loginConfiguration,
  outlookConfiguration,
} from "@invoxim/adapters";
import { afterEach, expect, it, vi } from "vitest";
import { createReviewSourceReader } from "../../../packages/adapters/src/purchase-views/review-source";
import worker from "../src/index";
import { createInvocationDatabase } from "../src/invocation-database";
import { installOnboardingQaHooks, owner } from "./onboarding-qa-fixture";
import { signedSession } from "./support/tenant";

installOnboardingQaHooks();

const db = env.DB;
const keyring = {
  activeVersion: 1,
  keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
};
let sequence = 0;
async function fixture(expired = false) {
  const current = await owner(`outlook-review-${++sequence}`, "outlook", [
    "https://graph.microsoft.com/Mail.Read",
  ]);
  const bindings = {
    DB: db,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://qa-outlook-review.example.invalid",
    AUTH_SECRET: "synthetic-outlook-review-secret-never-live-12345",
    AUTH_GOOGLE_CLIENT_ID: "synthetic-google",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
    AUTH_ALLOWED_EMAILS: JSON.stringify([current.loginEmail]),
    OUTLOOK_ENABLED: "true",
    OUTLOOK_CLIENT_ID: "11111111-2222-4333-8444-555555555555",
    OUTLOOK_CLIENT_SECRET: "synthetic-microsoft-secret",
    CREDENTIAL_KEYRING: JSON.stringify(keyring),
  };
  const configuration = outlookConfiguration(bindings);
  if (!configuration)
    throw new Error("Synthetic Outlook configuration missing");
  const ciphertext = await createCredentialCipher(keyring).seal(
    current.tenant,
    { entityId: "outlook", purpose: "mailbox-credentials" },
    {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: Date.now() + (expired ? -1000 : 3600000),
    },
  );
  await db
    .prepare(
      "UPDATE connections SET provider='outlook',provider_subject=?,credential_ciphertext=? WHERE user_id=? AND id='outlook'",
    )
    .bind(
      "https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222/v2.0|synthetic-sub",
      ciphertext,
      current.tenant.userId,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized) VALUES('consent',?,'outlook',1,'synthetic','local',0,0,1)",
    )
    .bind(current.tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO source_messages(id,user_id,connection_id,provider_message_id,received_at,generation) VALUES('source',?,'outlook','immutable-message',1000,1)",
    )
    .bind(current.tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,user_id,source_message_id,part_key,content_hash,mime,byte_length) VALUES('doc',?,'source','body','synthetic-hash','text/plain',10)",
    )
    .bind(current.tenant.userId)
    .run();
  await db
    .prepare(
      "INSERT INTO review_items(id,user_id,document_id,reason,blocking_scope,created_at) VALUES('review',?,'doc','extraction-review','financial',0)",
    )
    .bind(current.tenant.userId)
    .run();
  return { current, configuration, bindings };
}
afterEach(() => vi.restoreAllMocks());
function transport(change?: (url: URL) => Promise<void>) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === "https://login.microsoftonline.com")
        return Response.json({
          access_token: "synthetic-refreshed",
          refresh_token: "synthetic-rotated",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid profile email https://graph.microsoft.com/Mail.Read",
        });
      if (url.pathname === "/oidc/userinfo")
        return Response.json({
          sub: "synthetic-sub",
          email: "outlook@example.invalid",
        });
      expect(url.origin).toBe("https://graph.microsoft.com");
      expect(new Headers(init?.headers).get("Prefer")).toContain(
        'IdType="ImmutableId"',
      );
      expect(init?.redirect).toBe("manual");
      const selected = url.searchParams.get("$select");
      expect(selected).not.toMatch(/body|contentBytes|webLink/i);
      await change?.(url);
      if (url.pathname.endsWith("/attachments")) {
        expect(selected).toBe("id,name,contentType,size");
        return Response.json({
          value: [
            {
              id: "attachment",
              name: "synthetic.pdf",
              contentType: "application/pdf",
              size: 12,
              contentBytes: "private-unrequested-bytes",
            },
          ],
        });
      }
      expect(selected).toBe("id,subject,from");
      return Response.json({
        id: "immutable-message",
        subject: "<script>inert subject</script>",
        from: {
          emailAddress: {
            name: "Synthetic sender",
            address: "sender@example.invalid",
          },
        },
        body: { content: "private-unrequested-body" },
        webLink: "https://untrusted.invalid",
      });
    });
}
it("OUTLOOK-01 source inspection returns transient subject/sender/attachment metadata through the owned encrypted mailbox", async () => {
  const f = await fixture();
  const network = transport();
  const meter = createInvocationDatabase(db, 40);
  const result = await createReviewSourceReader(meter.db, f.configuration).read(
    f.current.tenant,
    "review",
  );
  expect(result).toMatchObject({
    mailboxAddress: "selected-b@example.invalid",
    receivedAt: 1000,
    subject: "<script>inert subject</script>",
    sender: "Synthetic sender <sender@example.invalid>",
    originalUrl: null,
    attachments: [
      { filename: "synthetic.pdf", mimeType: "application/pdf", size: 12 },
    ],
  });
  expect(network).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toMatch(
    /private-unrequested|untrusted\.invalid/,
  );
  expect(
    JSON.stringify(
      (
        await db
          .prepare("SELECT * FROM source_messages WHERE user_id=?")
          .bind(f.current.tenant.userId)
          .all()
      ).results,
    ),
  ).not.toContain("inert subject");
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
it("OUTLOOK-01 metadata inspection refreshes only the independent Outlook credential and retains shared40 headroom", async () => {
  const f = await fixture(true);
  const network = transport();
  const meter = createInvocationDatabase(db, 40);
  expect(
    (
      await createReviewSourceReader(meter.db, f.configuration).read(
        f.current.tenant,
        "review",
      )
    ).originalUrl,
  ).toBeNull();
  expect(network).toHaveBeenCalledTimes(4);
  expect(
    await db
      .prepare(
        "SELECT credential_version FROM connections WHERE user_id=? AND id='outlook'",
      )
      .bind(f.current.tenant.userId)
      .first("credential_version"),
  ).toBe(2);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
});
it.each([
  "foreign",
  "missing",
  "gmail",
  "missing-scope",
  "broad-scope",
] as const)(
  "OUTLOOK-01 source inspection %s cannot reach a provider or fall back",
  async (denial) => {
    const f = await fixture();
    const other = await fixture();
    await db
      .prepare("DELETE FROM review_items WHERE user_id=?")
      .bind(other.current.tenant.userId)
      .run();
    if (denial === "gmail")
      await db
        .prepare("UPDATE connections SET provider='gmail' WHERE user_id=?")
        .bind(f.current.tenant.userId)
        .run();
    if (denial.endsWith("scope"))
      await db
        .prepare("UPDATE connections SET scopes=? WHERE user_id=?")
        .bind(
          JSON.stringify(
            denial === "missing-scope"
              ? []
              : ["https://graph.microsoft.com/Mail.Read", "Mail.ReadWrite"],
          ),
          f.current.tenant.userId,
        )
        .run();
    const network = transport();
    await expect(
      createReviewSourceReader(db, f.configuration).read(
        denial === "foreign" ? other.current.tenant : f.current.tenant,
        denial === "missing" ? "missing" : "review",
      ),
    ).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  },
);
it.each(["consent", "generation", "credentials", "scope", "source"] as const)(
  "OUTLOOK-01 %s change while metadata is in flight blocks the second Graph request",
  async (change) => {
    const f = await fixture();
    const queries = {
      consent: "UPDATE processing_consents SET revoked_at=1 WHERE user_id=?",
      generation:
        "UPDATE connections SET generation=generation+1 WHERE user_id=?",
      credentials:
        "UPDATE connections SET credential_version=credential_version+1 WHERE user_id=?",
      scope: "UPDATE connections SET scopes='[]' WHERE user_id=?",
      source: "UPDATE source_messages SET available=0 WHERE user_id=?",
    };
    const network = transport(async () => {
      await db.prepare(queries[change]).bind(f.current.tenant.userId).run();
    });
    await expect(
      createReviewSourceReader(db, f.configuration).read(
        f.current.tenant,
        "review",
      ),
    ).rejects.toThrow("source_changed");
    expect(network).toHaveBeenCalledTimes(1);
  },
);
it.each([
  "redirect",
  "oversized",
  "pagination",
  "count",
  "wrong-id",
  "missing",
  "revoked",
  "throttled",
] as const)(
  "OUTLOOK-01 %s metadata fails closed without exposing unsolicited data",
  async (failure) => {
    const f = await fixture();
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        if (failure === "redirect")
          return new Response(null, {
            status: 302,
            headers: { Location: "https://untrusted.invalid" },
          });
        if (failure === "oversized") return new Response("x".repeat(65537));
        if (failure === "missing") return new Response(null, { status: 404 });
        if (failure === "revoked") return new Response(null, { status: 403 });
        if (failure === "throttled")
          return new Response(null, {
            status: 429,
            headers: { "Retry-After": "1" },
          });
        if (failure === "wrong-id")
          return Response.json({ id: "other", subject: "private", from: null });
        if (String(input).includes("/attachments?"))
          return Response.json({
            value:
              failure === "count"
                ? Array.from({ length: 9 }, (_, i) => ({
                    id: `a${i}`,
                    name: "a.pdf",
                    contentType: "application/pdf",
                    size: 1,
                  }))
                : [],
            ...(failure === "pagination"
              ? { "@odata.nextLink": "https://untrusted.invalid" }
              : {}),
          });
        return Response.json({
          id: "immutable-message",
          subject: null,
          from: null,
        });
      });
    // Provider answers that a retry cannot change are permanent; transport
    // failures that look like network/size trouble stay retryable.
    const expected = {
      redirect: "source_unavailable",
      oversized: "source_unavailable",
      pagination: "source_unreadable",
      count: "source_unreadable",
      "wrong-id": "source_unreadable",
      missing: "source_unreadable",
      revoked: "source_unreadable",
      throttled: "source_unavailable",
    }[failure];
    await expect(
      createReviewSourceReader(db, f.configuration).read(
        f.current.tenant,
        "review",
      ),
    ).rejects.toMatchObject({ code: expected });
    expect(network.mock.calls.length).toBeLessThanOrEqual(2);
  },
);

it("OUTLOOK-01 actual signed-session Worker source route selects Outlook metadata with no Gmail configuration", async () => {
  const f = await fixture();
  const login = loginConfiguration(f.bindings);
  if (!login) throw new Error("Synthetic login unavailable");
  const context = await createLoginAuth(db, login).$context;
  const session = await context.internalAdapter.createSession(
    f.current.tenant.userId,
    false,
  );
  if (!session) throw new Error("Synthetic signed session missing");
  const cookie = await signedSession(login.secret, session.token);
  const network = transport();
  const meter = createInvocationDatabase(db, 40);
  const response = await worker.fetch(
    new Request(`${login.origin}/api/review/review/source`, {
      headers: { Cookie: cookie, Origin: login.origin },
    }),
    { ...f.bindings, DB: meter.db },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    subject: "<script>inert subject</script>",
    originalUrl: null,
  });
  expect(network).toHaveBeenCalledTimes(2);
  expect(meter.executedStatements()).toBeLessThanOrEqual(40);
  network.mockClear();
  const other = await fixture();
  await db
    .prepare("UPDATE review_items SET id='foreign-review' WHERE user_id=?")
    .bind(other.current.tenant.userId)
    .run();
  const foreign = await worker.fetch(
    new Request(`${login.origin}/api/review/foreign-review/source`, {
      headers: { Cookie: cookie, Origin: login.origin },
    }),
    f.bindings,
  );
  expect(foreign.status).toBe(404);
  const disabled = await worker.fetch(
    new Request(`${login.origin}/api/review/review/source`, {
      headers: { Cookie: cookie, Origin: login.origin },
    }),
    {
      ...f.bindings,
      OUTLOOK_ENABLED: "false",
      GMAIL_ENABLED: "true",
      GMAIL_CLIENT_ID: "synthetic-gmail-client",
      GMAIL_CLIENT_SECRET: "synthetic-gmail-secret",
    },
  );
  expect(disabled.status).toBe(503);
  // A missing provider configuration is permanent: clients must not retry it.
  expect(await disabled.json()).toMatchObject({
    error: { code: "source_not_configured", retryable: false },
  });
  expect(network).not.toHaveBeenCalled();
});
it.each(["consent", "generation", "credentials", "source"] as const)(
  "OUTLOOK-01 %s change in the final attachment response prevents returning transient metadata",
  async (change) => {
    const f = await fixture();
    const queries = {
      consent: "UPDATE processing_consents SET revoked_at=1 WHERE user_id=?",
      generation:
        "UPDATE connections SET generation=generation+1 WHERE user_id=?",
      credentials:
        "UPDATE connections SET credential_version=credential_version+1 WHERE user_id=?",
      source: "UPDATE source_messages SET available=0 WHERE user_id=?",
    };
    const network = transport(async (url) => {
      if (url.pathname.endsWith("/attachments"))
        await db.prepare(queries[change]).bind(f.current.tenant.userId).run();
    });
    await expect(
      createReviewSourceReader(db, f.configuration).read(
        f.current.tenant,
        "review",
      ),
    ).rejects.toThrow("source_changed");
    expect(network).toHaveBeenCalledTimes(2);
  },
);
