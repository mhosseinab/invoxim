import { afterEach, expect, it, vi } from "vitest";
import { createGmailDiscovery } from "../../../packages/adapters/src/discovery/gmail";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
for (const [reason, code] of [
  ["SERVICE_DISABLED", "API_DISABLED"],
  ["accessNotConfigured", "API_DISABLED"],
  ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", "AUTH_REQUIRED"],
  ["insufficientPermissions", "AUTH_REQUIRED"],
  ["rateLimitExceeded", "RATE_LIMITED"],
  ["untrusted-private-provider-text", "UNAVAILABLE"],
]) {
  it(`classifies Gmail 403 ${reason} without exposing the provider response`, async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: "private-provider-message",
              errors: [{ reason }],
              details: [{ reason }],
            },
          },
          { status: 403 },
        ),
      ),
    );
    await expect(
      createGmailDiscovery("private-token").anchor(
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private");
    expect(warning).toHaveBeenCalledExactlyOnceWith("gmail_request_failed", {
      operation: "profile",
      status: 403,
      reason: reason === "untrusted-private-provider-text" ? "UNKNOWN" : reason,
    });
  });
}

it("honors the provider Retry-After floor for Gmail 403 rate limits", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          error: { errors: [{ reason: "rateLimitExceeded" }] },
        },
        { status: 403, headers: { "Retry-After": "120" } },
      ),
    ),
  );
  await expect(
    createGmailDiscovery("synthetic-token").anchor(
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 120000 });
});
