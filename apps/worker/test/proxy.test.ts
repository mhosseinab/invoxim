import { createPagesEventContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

function pagesContext(options: Parameters<typeof createPagesEventContext>[0]) {
  return {
    ...createPagesEventContext(options),
    env: { API: env.ECHO, ASSETS: env.ASSETS },
  };
}

import { onRequest } from "../../web/functions/api/[[path]]";

it("T02 Pages proxy preserves body, cookies, URL, redirects and strips asserted identity", async () => {
  const response = await onRequest(
    pagesContext({
      request: new Request("https://example.test/api/probe?q=1", {
        method: "POST",
        body: "synthetic-body",
        headers: {
          "X-User-Id": "forged",
          "X-Tenant-Id": "forged",
          "X-Internal-Identity": "forged",
          "X-Forwarded-Host": "evil.invalid",
          "X-Forwarded-Proto": "http",
          Cookie: "synthetic=1",
          Origin: "https://example.test",
        },
      }),
      params: { path: "probe" },
      data: {},
    }),
  );
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe(
    "https://example.test/callback",
  );
  expect(response.headers.getSetCookie()).toEqual([
    "one=1; Path=/; HttpOnly",
    "two=2; Path=/; HttpOnly",
  ]);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-probe-url")).toBe(
    "https://example.test/api/probe?q=1",
  );
  expect(response.headers.get("x-probe-method")).toBe("POST");
  expect(await response.json()).toEqual({
    body: "synthetic-body",
    headers: {
      cookie: "synthetic=1",
      origin: "https://example.test",
      "content-length": "14",
      "content-type": "text/plain;charset=UTF-8",
    },
  });
});
it("T02 Pages proxy preserves downstream error status", async () => {
  const response = await onRequest(
    pagesContext({
      request: new Request("https://example.test/api/probe"),
      params: { path: "probe" },
      data: {},
    }),
  );
  expect(response.status).toBe(503);
});
