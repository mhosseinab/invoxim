import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { afterEach, expect, it, vi } from "vitest";
import { createGmailDiscovery } from "../../../packages/adapters/src/discovery/gmail";
import { createDiscoveryPages } from "../../../packages/adapters/src/discovery/pages";

afterEach(() => vi.restoreAllMocks());
it("reports a fixed discovery stage without retaining database or mailbox error content", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const database = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return () => {
          throw new Error("PRIVATE DATABASE VALUE");
        };
      return Reflect.get(target, key);
    },
  });
  const pages = createDiscoveryPages(
    database,
    {
      providers: { open: vi.fn() },
      readiness: { allow: async () => true },
      remainingStatements: () => 40,
    },
    {
      charge: () => undefined,
      consent: vi.fn(),
      remainingPageStatements: () => 25,
    },
  );
  await expect(
    pages.runPage(
      {
        context: { userId: "synthetic", authority: "job" } as TenantContext,
        jobId: "job",
        connectionId: "mailbox",
        consentId: "consent",
        generation: 1,
        syncStateId: "state",
        type: "sync",
        leaseId: "lease",
        fence: 1,
        expiresAt: Date.now() + 60000,
        attempt: 1,
      },
      { signal: new AbortController().signal, checkpoint: async () => true },
    ),
  ).resolves.toEqual({ kind: "retry", code: "transient" });
  expect(warn).toHaveBeenCalledWith("gmail_discovery_retry", {
    stage: "state",
    reason: "UNEXPECTED",
  });
  expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
});

it("never logs provider network exception content", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("PRIVATE NETWORK VALUE"),
  );
  await expect(
    createGmailDiscovery("PRIVATE TOKEN").list({
      range: { startMs: 1, cutoffMs: 1000, timezone: "UTC" },
      queryMode: "filtered",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(warn).toHaveBeenCalledWith("gmail_discovery_transport_failure", {
    operation: "list",
    reason: "invalid-response-or-network",
  });
  expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
});

it("identifies elapsed Gmail deadline even before the abort timer callback", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    clock.mockReturnValue(10001);
    return Response.json({});
  });
  await expect(
    createGmailDiscovery("synthetic").list({
      range: { startMs: 1, cutoffMs: 1000, timezone: "UTC" },
      queryMode: "filtered",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(warn).toHaveBeenCalledWith("gmail_discovery_transport_failure", {
    operation: "list",
    reason: "timeout",
  });
});
