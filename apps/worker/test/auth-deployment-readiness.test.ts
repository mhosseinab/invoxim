import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { createAuthRoutes } from "../src/auth-routes";

const origin = "https://synthetic-login.example";
const bindings = {
  DB: env.DB,
  AUTH_ENABLED: "true",
  AUTH_ORIGIN: origin,
  AUTH_SECRET: "synthetic-login-deployment-secret-32-characters",
  AUTH_GOOGLE_CLIENT_ID: "synthetic-google-client",
  AUTH_GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
  AUTH_ALLOWED_EMAILS: '["synthetic@example.invalid"]',
};
function start() {
  return createAuthRoutes().request(
    `${origin}/api/auth/sign-in/social`,
    {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "google" }),
    },
    bindings,
  );
}
it("live-initiation diagnostic: configured login with no D1 schema returns auth_unavailable before Google", async () => {
  const response = await start();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { code: "auth_unavailable" },
  });
});
it("live-initiation diagnostic: the exact browser request starts Google after fresh baseline installation", async () => {
  for (const sql of baseline.split(";").filter((value) => value.trim()))
    await env.DB.prepare(sql).run();
  const response = await start();
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ url: expect.any(String) });
  if (
    !body ||
    typeof body !== "object" ||
    !("url" in body) ||
    typeof body.url !== "string"
  )
    throw new Error("Missing synthetic authorization URL");
  const authorization = new URL(body.url);
  expect(authorization.origin).toBe("https://accounts.google.com");
  expect(authorization.searchParams.get("redirect_uri")).toBe(
    `${origin}/api/auth/callback/google`,
  );
  expect(authorization.searchParams.get("scope")?.split(" ").sort()).toEqual([
    "email",
    "openid",
    "profile",
  ]);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM verification").first(
      "count",
    ),
  ).toBe(1);
});
