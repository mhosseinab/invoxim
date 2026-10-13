import { createPagesEventContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { onRequest } from "../../web/functions/api/[[path]]";

it("PRESENT-03 unauthenticated public configuration exposes only available display capabilities", async () => {
  const event = createPagesEventContext({
    request: new Request("https://example.test/api/public-config"),
    params: { path: "public-config" },
    data: {},
  });
  const response = await onRequest({
    ...event,
    env: { API: env.API, ASSETS: env.ASSETS },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    displayName: "Invoxim",
    signupMode: "allowlist",
    demoEnabled: true,
    loginEnabled: false,
    mailProviders: [],
    features: {
      outlook: false,
      driveArchive: false,
      recurring: false,
      useTags: false,
    },
    policyRoutes: { privacy: null, terms: null },
  });
});

it("T29 public login capability follows validated server configuration without exposing secrets", async () => {
  const { default: worker } = await import("../src/index");
  const bindings = {
    DB: env.DB,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://synthetic.example",
    AUTH_SECRET: "synthetic-auth-secret-configuration-32",
    AUTH_GOOGLE_CLIENT_ID: "synthetic-google-client",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic-private-client-secret",
    AUTH_ALLOWED_EMAILS: '["synthetic@example.invalid"]',
  };
  const request = new Request("https://synthetic.example/api/public-config");
  const response = await worker.request(request, undefined, bindings);
  const data = await response.json();
  expect(data).toMatchObject({ loginEnabled: true, mailProviders: [] });
  expect(JSON.stringify(data)).not.toContain(bindings.AUTH_SECRET);
  expect(JSON.stringify(data)).not.toContain(
    bindings.AUTH_GOOGLE_CLIENT_SECRET,
  );
  const disabled = await worker.request(request, undefined, {
    ...bindings,
    AUTH_ALLOWED_EMAILS: "invalid",
  });
  expect(await disabled.json()).toMatchObject({ loginEnabled: false });
});
