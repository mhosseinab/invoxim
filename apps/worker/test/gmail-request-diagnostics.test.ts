import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { afterEach, expect, it, vi } from "vitest";
import { createGmailDiscovery } from "../../../packages/adapters/src/discovery/gmail";
import { createGmailDiscoveryProviderFactory } from "../../../packages/adapters/src/discovery/provider-factory";
import { gmailConfiguration } from "../../../packages/adapters/src/mailbox/configuration";
import { faultingDatabase } from "./support/faults";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("records only the failed Gmail operation and HTTP status without exposing provider error content", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  let reads = 0;
  const body = new ReadableStream({
    pull(controller) {
      reads++;
      controller.enqueue(new TextEncoder().encode("private provider content"));
      controller.close();
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 403 })),
  );
  await expect(
    createGmailDiscovery("private-token").anchor(new AbortController().signal),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(warning).toHaveBeenCalledExactlyOnceWith("gmail_request_failed", {
    operation: "profile",
    status: 403,
    reason: "UNKNOWN",
  });
  // Only an allowlisted reason may leave the transient provider response.
  expect(reads).toBeLessThanOrEqual(1);
  expect(JSON.stringify(warning.mock.calls)).not.toContain("private");
});

it("redacts unexpected credential-read errors while identifying the preparation stage", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { db: database } = faultingDatabase(env.DB, [
    {
      on: "prepare",
      fire: () => {
        throw new Error("private-database-content");
      },
    },
  ]);
  const configuration = gmailConfiguration({
    DB: database,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://synthetic.example",
    AUTH_SECRET: "synthetic-auth-secret-not-used-in-production-123",
    AUTH_GOOGLE_CLIENT_ID: "login-client",
    AUTH_GOOGLE_CLIENT_SECRET: "login-secret",
    AUTH_ALLOWED_EMAILS: '["synthetic@example.invalid"]',
    GMAIL_ENABLED: "true",
    GMAIL_CLIENT_ID: "mail-client",
    GMAIL_CLIENT_SECRET: "mail-secret",
    CREDENTIAL_KEYRING: JSON.stringify({
      activeVersion: 1,
      keys: { 1: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM" },
    }),
  });
  if (!configuration) throw new Error("Synthetic configuration unavailable");
  await expect(
    createGmailDiscoveryProviderFactory(database, configuration).open(
      { userId: "synthetic-owner", authority: "session" } as TenantContext,
      { connectionId: "synthetic-mailbox", generation: 1 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(warning).toHaveBeenCalledExactlyOnceWith("gmail_preparation_failed", {
    stage: "credential_read",
    code: "SECRET_UNAVAILABLE",
  });
  expect(JSON.stringify(warning.mock.calls)).not.toContain("private");
});
