import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";

it("AUTH-05 public API responses prohibit sniffing, framing and referrer disclosure", async () => {
  for (const path of ["/api/health", "/api/public-config"]) {
    const response = await worker.request(
      `https://synthetic.example${path}`,
      {},
      env,
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
});

it("AUTH-05 denied private responses retain the same transport protections", async () => {
  const response = await worker.request(
    "https://synthetic.example/api/me",
    {},
    env,
  );
  expect(response.status).toBe(401);
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("Content-Security-Policy")).toContain(
    "default-src 'none'",
  );
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
