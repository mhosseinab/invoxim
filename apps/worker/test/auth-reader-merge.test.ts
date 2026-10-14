import { expect, it } from "vitest";
import type { LoginConfiguration } from "../../../packages/adapters/src/auth/configuration";
import {
  loginConfiguration,
  loginConfigurationSchema,
} from "../../../packages/adapters/src/auth/configuration";
import {
  AuthRequestError,
  readAuthJson,
} from "../../../packages/adapters/src/auth/http";
import { createLoginAuth } from "../../../packages/adapters/src/auth/login";
import { BoundedJsonError } from "../../../packages/adapters/src/http";

function jsonRequest(
  body: BodyInit | null,
  headers: Record<string, string> = {},
  maxBytes?: number,
) {
  const request = new Request("https://synthetic.example.test/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
  return maxBytes === undefined
    ? readAuthJson(request)
    : readAuthJson(request, maxBytes);
}

it("readAuthJson maps the shared reader's content-type failure to 415", async () => {
  await expect(
    jsonRequest("{}", { "Content-Type": "text/plain" }),
  ).rejects.toMatchObject({
    status: 415,
    code: "unsupported_media_type",
  });
});

it("readAuthJson maps content-length and stream overflow to 413", async () => {
  await expect(
    jsonRequest("{}", { "content-length": "999999" }),
  ).rejects.toMatchObject({ status: 413, code: "request_too_large" });
  const pad = JSON.stringify({ pad: "x".repeat(5000) });
  await expect(jsonRequest(pad, {}, 256)).rejects.toMatchObject({
    status: 413,
    code: "request_too_large",
  });
});

it("readAuthJson maps missing body and invalid JSON to 400", async () => {
  await expect(jsonRequest(null)).rejects.toMatchObject({
    status: 400,
    code: "invalid_request",
  });
  await expect(jsonRequest("not json")).rejects.toMatchObject({
    status: 400,
    code: "invalid_request",
  });
});

it("readAuthJson keeps the 40960 maxBytes ceiling as 400, not 413", async () => {
  await expect(jsonRequest("{}", {}, 40961)).rejects.toMatchObject({
    status: 400,
    code: "invalid_request",
  });
  await expect(jsonRequest("{}", {}, 0)).rejects.toMatchObject({
    status: 400,
    code: "invalid_request",
  });
});

it("readAuthJson accepts a bounded JSON body", async () => {
  await expect(jsonRequest('{"provider":"google"}')).resolves.toEqual({
    provider: "google",
  });
  await expect(
    jsonRequest(JSON.stringify({ pad: "y".repeat(4000) }), {}, 40960),
  ).resolves.toMatchObject({ pad: expect.any(String) });
});

it("AuthRequestError status/code pairs stay stable for the route mapper", () => {
  const error = new AuthRequestError(415, "unsupported_media_type");
  expect(error.status).toBe(415);
  expect(error.code).toBe("unsupported_media_type");
  expect(error.message).toBe("unsupported_media_type");
});

it("login configuration is parsed once; createLoginAuth trusts LoginConfiguration", () => {
  const bindings = {
    DB: {} as D1Database,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: "https://synthetic.example.test",
    AUTH_SECRET: "s".repeat(32),
    AUTH_GOOGLE_CLIENT_ID: "client",
    AUTH_GOOGLE_CLIENT_SECRET: "secret",
    AUTH_ALLOWED_EMAILS: JSON.stringify(["login@example.invalid"]),
  };
  const configuration = loginConfiguration(bindings);
  expect(configuration).not.toBeNull();
  if (!configuration || !bindings.DB)
    throw new Error("Synthetic login configuration unavailable");
  // S11: the second configured rule was loginConfigurationSchema.parse inside
  // createLoginAuth. A strictObject probe rejects the extra own property that
  // the type boundary already excludes, so the typed value must be trusted.
  const typed = {
    ...configuration,
    extra: "type-boundary-only",
  } as LoginConfiguration;
  expect(() => createLoginAuth(bindings.DB, typed)).not.toThrow();
  // The single schema probe remains loginConfiguration's.
  expect(
    loginConfigurationSchema.safeParse({
      origin: "https://synthetic.example.test",
      secret: "s".repeat(32),
      googleClientId: "client",
      googleClientSecret: "secret",
      allowedEmails: ["login@example.invalid"],
    }).success,
  ).toBe(true);
});

it("shared reader errors are the source of mapped auth failures", () => {
  expect(new BoundedJsonError("content-type").reason).toBe("content-type");
  expect(new BoundedJsonError("too-large").reason).toBe("too-large");
  expect(new BoundedJsonError("invalid-json").reason).toBe("invalid-json");
});
