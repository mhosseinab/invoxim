import type { GmailBindings, OutlookBindings } from "@invoxim/adapters";
import {
  AuthRequestError,
  createGmailAuthorization,
  createLoginAuth,
  createMailboxService,
  createOutlookAuthorization,
  createProfileService,
  gmailConfiguration,
  loginConfiguration,
  outlookConfiguration,
  readAuthJson,
} from "@invoxim/adapters";
import {
  mailboxConnectionsResponseSchema,
  mailboxDisconnectRequestSchema,
  mailboxStartRequestSchema,
  mailboxStartResponseSchema,
} from "@invoxim/contracts";
import { MailboxError } from "@invoxim/core";
import { Hono } from "hono";
import { createInvocationDatabase } from "./invocation-database";

type MailboxBindings = GmailBindings & OutlookBindings;
export function createMailboxRoutes() {
  const app = new Hono<{ Bindings: MailboxBindings }>();
  app.use("/api/*", async (context, next) => {
    await next();
    context.res.headers.set("Cache-Control", "no-store");
  });
  function error(
    status: 401 | 403 | 404 | 409 | 503 | 400 | 413 | 415,
    code: string,
  ) {
    return Response.json(
      {
        error: {
          code,
          message: "Request unavailable",
          requestId: crypto.randomUUID(),
          retryable: status === 503,
        },
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
  async function enabled(
    request: Request,
    bindings: MailboxBindings,
    provider?: "gmail" | "outlook",
  ) {
    const login = loginConfiguration(bindings);
    if (!login || !bindings.DB) throw new MailboxError("UNAUTHENTICATED");
    if (
      new URL(request.url).origin !== login.origin ||
      (!["GET", "HEAD"].includes(request.method) &&
        request.headers.get("origin") !== login.origin)
    )
      return { denied: true } as const;
    const db = createInvocationDatabase(bindings.DB, 40).db;
    const current = await createProfileService(
      db,
      createLoginAuth(db, login),
      login,
    ).current(request.headers);
    if (!current) throw new MailboxError("UNAUTHENTICATED");
    const gmail = provider !== "outlook" ? gmailConfiguration(bindings) : null;
    const outlook =
      provider !== "gmail" ? outlookConfiguration(bindings) : null;
    const configuration = gmail ?? outlook;
    if (!configuration) throw new MailboxError("UNAVAILABLE");
    const authorization = gmail
      ? createGmailAuthorization(gmail)
      : outlook
        ? createOutlookAuthorization(outlook)
        : null;
    if (!authorization) throw new MailboxError("UNAVAILABLE");
    return {
      service: createMailboxService(db, configuration, authorization),
      session: {
        tenant: current.tenant,
        sessionId: current.session.id,
        createdAtMs: current.session.createdAt.getTime(),
      },
      origin: login.origin,
    };
  }
  function failure(cause: unknown) {
    if (cause instanceof AuthRequestError)
      return error(cause.status, cause.code);
    if (!(cause instanceof MailboxError))
      return error(503, "mailbox_unavailable");
    const statuses = {
      UNAUTHENTICATED: 401,
      RECENT_AUTH_REQUIRED: 403,
      INVALID_STATE: 400,
      DENIED: 403,
      MISSING_PERMISSION: 403,
      ACCOUNT_MISMATCH: 409,
      MISSING_REFRESH_TOKEN: 409,
      NOT_FOUND: 404,
      CONFLICT: 409,
      LIMIT_REACHED: 409,
      RECONNECT_REQUIRED: 409,
      UNAVAILABLE: 503,
    } as const;
    return error(statuses[cause.code], cause.code.toLowerCase());
  }
  app.get("/api/connections", async (c) => {
    try {
      const ready = await enabled(c.req.raw, c.env ?? {});
      if ("denied" in ready) return error(403, "origin_denied");
      return c.json(
        mailboxConnectionsResponseSchema.parse(
          await ready.service.list(ready.session.tenant),
        ),
      );
    } catch (cause) {
      return failure(cause);
    }
  });
  app.delete("/api/connections/:id", async (c) => {
    try {
      const ready = await enabled(c.req.raw, c.env ?? {});
      if ("denied" in ready) return error(403, "origin_denied");
      const input = mailboxDisconnectRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!input.success || c.req.param("id").length > 120)
        return error(400, "invalid_request");
      await ready.service.disconnect(
        ready.session,
        c.req.param("id"),
        input.data,
      );
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (cause) {
      return failure(cause);
    }
  });
  for (const provider of ["gmail", "outlook"] as const) {
    app.post(`/api/connections/mailbox/${provider}/start`, async (c) => {
      try {
        const ready = await enabled(c.req.raw, c.env ?? {}, provider);
        if ("denied" in ready) return error(403, "origin_denied");
        const input = mailboxStartRequestSchema.safeParse(
          await readAuthJson(c.req.raw),
        );
        if (!input.success) return error(400, "invalid_request");
        return c.json(
          mailboxStartResponseSchema.parse(
            await ready.service.start(ready.session, input.data.connectionId),
          ),
        );
      } catch (cause) {
        return failure(cause);
      }
    });
    app.get(`/api/oauth/mailbox/${provider}/callback`, async (c) => {
      let origin: string | undefined;
      try {
        const ready = await enabled(c.req.raw, c.env ?? {}, provider);
        if ("denied" in ready) return error(403, "origin_denied");
        origin = ready.origin;
        const url = new URL(c.req.url);
        const keys = [...url.searchParams.keys()];
        if (
          keys.filter((key) => key === "state").length !== 1 ||
          keys.filter((key) => key === "code").length > 1 ||
          keys.filter((key) => key === "error").length > 1 ||
          (!url.searchParams.has("error") &&
            keys.filter((key) => key === "code").length !== 1)
        )
          throw new MailboxError("INVALID_STATE");
        const connection = await ready.service.complete(ready.session, {
          state: url.searchParams.get("state") ?? "",
          ...(url.searchParams.has("code")
            ? { code: url.searchParams.get("code") ?? "" }
            : {}),
          denied: url.searchParams.has("error"),
        });
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${origin}/onboarding/review?mailbox=connected&connectionId=${encodeURIComponent(connection.id)}`,
            "Cache-Control": "no-store",
          },
        });
      } catch (cause) {
        if (!origin) return failure(cause);
        const status =
          cause instanceof MailboxError
            ? ((
                {
                  DENIED: "denied",
                  MISSING_PERMISSION: "missing_permission",
                  ACCOUNT_MISMATCH: "account_mismatch",
                } as Record<string, string>
              )[cause.code] ?? "unavailable")
            : "unavailable";
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${origin}/onboarding/review?mailbox=${status}`,
            "Cache-Control": "no-store",
          },
        });
      }
    });
  }
  return app;
}
