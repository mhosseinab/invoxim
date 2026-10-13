import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
// Prepare the Worker module graph before timed requests; the service binding still runs the actual Worker.
import "../src/index";

describe("T02 scaffold transport", () => {
  it("exposes scaffold health without claiming working providers", async () => {
    const response = await env.API.fetch("https://example.test/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "scaffold" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("does not expose an unimplemented sign-in route", async () => {
    const response = await env.API.fetch(
      "https://example.test/api/auth/sign-in",
    );
    expect(response.status).toBe(404);
  });
});
