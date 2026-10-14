import { env } from "cloudflare:workers";
import {
  AuthRequestError,
  createLoginAuth,
  loginConfiguration,
} from "@invoxim/adapters";
import { OnboardingError } from "@invoxim/core";
import { afterEach, expect, it, vi } from "vitest";
import { createOnboardingRoutes } from "../src/onboarding-routes";
import { installOnboardingQaHooks, owner } from "./onboarding-qa-fixture";
import { faultingDatabase } from "./support/faults";

installOnboardingQaHooks();

const origin = "https://qa-start-diagnostics.example.invalid";
afterEach(() => vi.restoreAllMocks());
async function fixture(id: string, cause: unknown) {
  const current = await owner(id);
  const bindings = {
    DB: env.DB,
    AUTH_ENABLED: "true",
    AUTH_ORIGIN: origin,
    AUTH_SECRET: "synthetic-start-diagnostics-secret-never-live-12345",
    AUTH_GOOGLE_CLIENT_ID: "synthetic-login-id",
    AUTH_GOOGLE_CLIENT_SECRET: "synthetic-login-secret",
    AUTH_ALLOWED_EMAILS: JSON.stringify([current.loginEmail]),
  };
  const configuration = loginConfiguration(bindings);
  if (!configuration) throw new Error("Synthetic login config unavailable");
  const context = await createLoginAuth(env.DB, configuration).$context;
  const session = await context.internalAdapter.createSession(id, false);
  if (!session) throw new Error("Synthetic signed session unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(configuration.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(session.token),
  );
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
  const { db: database } = faultingDatabase(env.DB, [
    {
      match:
        "SELECT user_id,timezone,reporting_currency,version,onboarding_completed_at FROM profiles",
      on: "prepare",
      fire: () => {
        throw cause;
      },
    },
  ]);
  return {
    bindings: { ...bindings, DB: database },
    request(method = "POST") {
      return new Request(
        `${origin}/api/${method === "POST" ? "onboarding/start-import" : "onboarding"}`,
        {
          method,
          headers: {
            Cookie: cookie,
            Origin: origin,
            "Content-Type": "application/json",
            "Idempotency-Key": "synthetic-private-idempotency",
            "X-Private": "synthetic-private-header",
          },
          ...(method === "POST"
            ? { body: '{"private":"synthetic-private-body"}' }
            : {}),
        },
      );
    },
  };
}

it.each([
  {
    name: "unexpected",
    cause: Object.assign(new Error("synthetic-private-error-message"), {
      name: "synthetic-private-error-name",
      code: "synthetic-private-code",
    }),
    type: "unexpected",
    code: "UNEXPECTED",
    status: 503,
    apiCode: "processing_unavailable",
  },
  {
    name: "unavailable",
    cause: new OnboardingError("UNAVAILABLE"),
    type: "OnboardingError",
    code: "UNAVAILABLE",
    status: 503,
    apiCode: "processing_unavailable",
  },
  {
    name: "conflict",
    cause: new OnboardingError("CONFLICT"),
    type: "OnboardingError",
    code: "CONFLICT",
    status: 409,
    apiCode: "conflict",
  },
  {
    name: "invalid-json",
    cause: new AuthRequestError(400, "invalid_request"),
    type: "AuthRequestError",
    code: "invalid_request",
    status: 400,
    apiCode: "invalid_request",
  },
  {
    name: "unallowlisted-auth-code",
    cause: new AuthRequestError(400, "synthetic-private-auth-code"),
    type: "unexpected",
    code: "UNEXPECTED",
    status: 400,
    apiCode: "synthetic-private-auth-code",
  },
])(
  "Start failure diagnostic correlates safe $name category with unchanged API response",
  async ({ name, cause, type, code, status, apiCode }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bindings, request } = await fixture(`diagnostic-${name}`, cause);
    const response = await createOnboardingRoutes().fetch(request(), bindings);
    expect(response.status).toBe(status);
    const body = (await response.json()) as {
      error: { code: string; requestId: string };
    };
    expect(body.error.code).toBe(apiCode);
    expect(body.error.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(warn.mock.calls).toEqual([
      [
        {
          event: "onboarding_start_failed",
          requestId: body.error.requestId,
          errorType: type,
          errorCode: code,
        },
      ],
    ]);
    const diagnostic = JSON.stringify(warn.mock.calls);
    expect(diagnostic).not.toContain("synthetic-private");
    expect(diagnostic).not.toContain(`diagnostic-${name}`);
  },
);

it("GET onboarding failures keep existing behavior without Start diagnostics", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { bindings, request } = await fixture(
    "diagnostic-get",
    new Error("synthetic-private-get-error"),
  );
  expect(
    (await createOnboardingRoutes().fetch(request("GET"), bindings)).status,
  ).toBe(503);
  expect(warn).not.toHaveBeenCalled();
});

it("Disabled Gmail API returns a specific nonretryable operator configuration error", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { bindings, request } = await fixture(
    "diagnostic-api-disabled",
    new OnboardingError("API_DISABLED"),
  );
  const response = await createOnboardingRoutes().fetch(request(), bindings);
  expect(response.status).toBe(503);
  const body = (await response.json()) as {
    error: {
      code: string;
      message: string;
      requestId: string;
      retryable: boolean;
    };
  };
  expect(body.error).toMatchObject({
    code: "mailbox_api_disabled",
    message:
      "Gmail API is disabled for this app. Enable it in the Google Cloud project before importing.",
    retryable: false,
  });
  expect(warn.mock.calls).toEqual([
    [
      {
        event: "onboarding_start_failed",
        requestId: body.error.requestId,
        errorType: "OnboardingError",
        errorCode: "API_DISABLED",
      },
    ],
  ]);
});
