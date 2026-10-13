import type { AiBindings, GmailBindings } from "@invoxim/adapters";
import {
  AuthRequestError,
  aiConfiguration,
  createGmailDiscoveryProviderFactory,
  createLoginAuth,
  createOnboardingImportPreparation,
  createOnboardingRepository,
  createProfileService,
  gmailConfiguration,
  loginConfiguration,
  ProcessingNotConfiguredError,
  readAuthJson,
} from "@invoxim/adapters";
import { createOnboardingUsecases, OnboardingError } from "@invoxim/core";
import { Hono } from "hono";
import { createInvocationDatabase } from "./invocation-database";
import type { JobBindings } from "./job-configuration";
import { jobConfiguration } from "./job-configuration";
export interface OnboardingBindings
  extends AiBindings, GmailBindings, JobBindings {
  GMAIL_DISCOVERY_ENABLED?: string;
  EXTRACTION_ENABLED?: string;
}
function error(
  status: 400 | 401 | 403 | 409 | 413 | 415 | 429 | 503,
  code: string,
  retryable = status === 503,
  requestId: string = crypto.randomUUID(),
  message = "Request unavailable",
) {
  return Response.json(
    {
      error: {
        code,
        message,
        requestId,
        retryable,
      },
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
function json(value: unknown) {
  const body = JSON.stringify(value);
  return new TextEncoder().encode(body).byteLength > 128 * 1024
    ? error(413, "response_too_large")
    : new Response(body, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
}
function query(request: Request) {
  const result: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    if (Object.hasOwn(result, key))
      throw new OnboardingError("INVALID_REQUEST");
    result[key] = value;
  }
  return result;
}
function failure(cause: unknown, requestId?: string) {
  if (cause instanceof AuthRequestError)
    return error(cause.status, cause.code, false, requestId);
  if (!(cause instanceof OnboardingError))
    return error(503, "processing_unavailable", true, requestId);
  switch (cause.code) {
    case "UNAUTHORIZED":
      return error(401, "unauthorized", false, requestId);
    case "INVALID_REQUEST":
      return error(400, "invalid_request", false, requestId);
    case "CONFLICT":
      return error(409, "conflict", false, requestId);
    case "PROCESSING_REVIEW_REQUIRED":
      return error(409, "processing_review_required", false, requestId);
    case "BUDGET":
      return error(429, "allowance_unavailable", false, requestId);
    case "AUTH_REQUIRED":
      return error(409, "mailbox_reconnect_required", false, requestId);
    case "API_DISABLED":
      return error(
        503,
        "mailbox_api_disabled",
        false,
        requestId,
        "Gmail API is disabled for this app. Enable it in the Google Cloud project before importing.",
      );
    case "UNAVAILABLE":
      return error(503, "processing_unavailable", true, requestId);
  }
}
function startDiagnostic(cause: unknown, requestId: string) {
  let errorType = "unexpected";
  let errorCode = "UNEXPECTED";
  if (
    cause instanceof OnboardingError &&
    [
      "UNAUTHORIZED",
      "INVALID_REQUEST",
      "CONFLICT",
      "PROCESSING_REVIEW_REQUIRED",
      "UNAVAILABLE",
      "BUDGET",
      "AUTH_REQUIRED",
      "API_DISABLED",
    ].includes(cause.code)
  ) {
    errorType = "OnboardingError";
    errorCode = cause.code;
  } else if (
    cause instanceof AuthRequestError &&
    ["invalid_request", "unsupported_media_type", "request_too_large"].includes(
      cause.code,
    )
  ) {
    errorType = "AuthRequestError";
    errorCode = cause.code;
  }
  console.warn({
    event: "onboarding_start_failed",
    requestId,
    errorType,
    errorCode,
  });
}
export function createOnboardingRoutes() {
  const app = new Hono<{ Bindings: OnboardingBindings }>();
  async function authorized(request: Request, bindings: OnboardingBindings) {
    const config = loginConfiguration(bindings);
    if (!config || !bindings.DB)
      return { response: error(401, "unauthorized") } as const;
    if (
      (request.method === "POST" &&
        request.headers.get("origin") !== config.origin) ||
      new URL(request.url).origin !== config.origin ||
      (request.headers.has("origin") &&
        request.headers.get("origin") !== config.origin)
    )
      return { response: error(403, "origin_required") } as const;
    const database = createInvocationDatabase(bindings.DB, 40),
      current = await createProfileService(
        database.db,
        createLoginAuth(database.db, config),
        config,
      ).current(request.headers);
    if (!current) return { response: error(401, "unauthorized") } as const;
    const ai = aiConfiguration(bindings),
      gmail = gmailConfiguration(bindings),
      jobs = jobConfiguration(bindings);
    const repository = createOnboardingRepository(database.db, {
      ai,
      ready:
        !!ai &&
        !!gmail &&
        !!jobs &&
        jobs.queryLimit === 40 &&
        bindings.GMAIL_DISCOVERY_ENABLED === "true" &&
        bindings.EXTRACTION_ENABLED === "true",
      signingSecret: config.secret,
      mailboxLimit: gmail?.limit ?? 3,
      mailboxProviders: gmail ? ["gmail"] : [],
      remainingStatements: database.remainingStatements,
    });
    return {
      session: {
        tenant: current.tenant,
        sessionId: current.session.id,
        loginEmail: current.user.email,
      },
      service: createOnboardingUsecases({
        repository,
        preparation: createOnboardingImportPreparation(
          gmail
            ? createGmailDiscoveryProviderFactory(database.db, gmail)
            : null,
          false,
        ),
      }),
    };
  }
  app.get("/api/onboarding", async (c) => {
    try {
      const current = await authorized(c.req.raw, c.env ?? {});
      return "response" in current
        ? current.response
        : json(await current.service.view(current.session, query(c.req.raw)));
    } catch (cause) {
      return failure(cause);
    }
  });
  app.get("/api/processing-disclosure", async (c) => {
    try {
      const current = await authorized(c.req.raw, c.env ?? {});
      return "response" in current
        ? current.response
        : json(
            await current.service.disclosure(current.session, query(c.req.raw)),
          );
    } catch (cause) {
      if (cause instanceof ProcessingNotConfiguredError)
        return error(503, "processing_not_configured", false);
      return failure(cause);
    }
  });
  app.post("/api/onboarding/start-import", async (c) => {
    try {
      const current = await authorized(c.req.raw, c.env ?? {});
      if ("response" in current) return current.response;
      if (new URL(c.req.url).search) return error(400, "invalid_request");
      return json(
        await current.service.start(
          current.session,
          await readAuthJson(c.req.raw),
          c.req.header("Idempotency-Key") ?? "",
        ),
      );
    } catch (cause) {
      const requestId = crypto.randomUUID();
      startDiagnostic(cause, requestId);
      return failure(cause, requestId);
    }
  });
  return app;
}
