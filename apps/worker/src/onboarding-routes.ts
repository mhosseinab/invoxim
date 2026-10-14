import {
  AuthRequestError,
  createGmailDiscoveryProviderFactory,
  createOnboardingImportPreparation,
  createOnboardingRepository,
  ProcessingNotConfiguredError,
  readAuthJson,
} from "@invoxim/adapters";
import { createOnboardingUsecases, OnboardingError } from "@invoxim/core";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  apiError,
  InvalidQueryError,
  json,
  requireTenantContext,
  uniqueQuery,
} from "./http/guard";
import {
  type MailboxRuntimeBindings,
  mailboxProcessingConfiguration,
} from "./mailbox-runtime";
export type OnboardingBindings = MailboxRuntimeBindings;
function error(
  status: number,
  code: string,
  retryable?: boolean,
  requestId?: string,
  message?: string,
) {
  return apiError(status, code, {
    ...(retryable === undefined ? {} : { retryable }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(message === undefined ? {} : { message }),
  });
}
function failure(cause: unknown, requestId?: string) {
  if (cause instanceof InvalidQueryError)
    return error(400, "invalid_request", false, requestId);
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
  async function authorized(c: Context<{ Bindings: OnboardingBindings }>) {
    const bindings = c.env ?? {};
    const ready = await requireTenantContext(c, {
      mutation: false,
      recent: false,
    });
    if ("response" in ready) return ready;
    const { ai, gmail, outlook, providers } =
      mailboxProcessingConfiguration(bindings);
    const repository = createOnboardingRepository(ready.db, {
      ai,
      ready: providers.length > 0,
      signingSecret: ready.secret,
      // Provider configs own the MAILBOX_LIMIT default ("3"). The fallback is
      // only a UI cap for the response when neither provider is configured, so
      // it must stay equal to that default (see mailbox/configuration.ts and
      // mailbox/outlook-configuration.ts).
      mailboxLimit: gmail?.limit ?? outlook?.limit ?? 3,
      mailboxProviders: providers,
      remainingStatements: ready.remainingStatements,
    });
    return {
      session: {
        tenant: ready.tenant,
        sessionId: ready.sessionId,
        loginEmail: ready.current.user.email,
      },
      service: createOnboardingUsecases({
        repository,
        preparation: createOnboardingImportPreparation(
          gmail ? createGmailDiscoveryProviderFactory(ready.db, gmail) : null,
          !!outlook,
        ),
      }),
    };
  }
  app.get("/api/onboarding", async (c) => {
    try {
      const current = await authorized(c);
      return "response" in current
        ? current.response
        : json(
            await current.service.view(current.session, uniqueQuery(c.req.raw)),
          );
    } catch (cause) {
      return failure(cause);
    }
  });
  app.get("/api/processing-disclosure", async (c) => {
    try {
      const current = await authorized(c);
      return "response" in current
        ? current.response
        : json(
            await current.service.disclosure(
              current.session,
              uniqueQuery(c.req.raw),
            ),
          );
    } catch (cause) {
      if (cause instanceof ProcessingNotConfiguredError)
        return error(503, "processing_not_configured", false);
      return failure(cause);
    }
  });
  app.post("/api/onboarding/start-import", async (c) => {
    try {
      const current = await authorized(c);
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
