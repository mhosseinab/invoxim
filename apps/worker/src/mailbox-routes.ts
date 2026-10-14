import type { GmailBindings, OutlookBindings } from "@invoxim/adapters";
import {
  createGmailAuthorization,
  createMailboxManagement,
  createMailboxService,
  createOutlookAuthorization,
  gmailConfiguration,
  outlookConfiguration,
  readAuthJson,
} from "@invoxim/adapters";
import {
  mailboxDisconnectRequestSchema,
  mailboxStartRequestSchema,
  mailboxStartResponseSchema,
} from "@invoxim/contracts";
import { MailboxError } from "@invoxim/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { apiError, json, mapFailure, requireTenantContext } from "./http/guard";

type MailboxBindings = GmailBindings & OutlookBindings;
export function createMailboxRoutes() {
  const app = new Hono<{ Bindings: MailboxBindings }>();
  function failure(cause: unknown) {
    if (!(cause instanceof MailboxError))
      return mapFailure(cause, "mailbox_unavailable");
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
    return apiError(statuses[cause.code], cause.code.toLowerCase());
  }
  async function enabled(
    c: Context<{ Bindings: MailboxBindings }>,
    provider?: "gmail" | "outlook",
  ) {
    // Disconnect/start keep today's weaker gate: no recent-login or
    // workspace-token requirement (OD-1).
    const ready = await requireTenantContext(c, {
      mutation: false,
      recent: false,
    });
    if ("response" in ready) return ready;
    const session = {
      tenant: ready.tenant,
      sessionId: ready.sessionId,
      createdAtMs: ready.createdAtMs,
    };
    if (!provider)
      return {
        kind: "management" as const,
        service: createMailboxManagement(ready.db),
        session,
        origin: ready.login.origin,
      };
    const gmail =
      provider !== "outlook" ? gmailConfiguration(c.env ?? {}) : null;
    const outlook =
      provider !== "gmail" ? outlookConfiguration(c.env ?? {}) : null;
    if (gmail)
      return {
        kind: "oauth" as const,
        service: createMailboxService(
          ready.db,
          gmail,
          createGmailAuthorization(gmail),
        ),
        session,
        origin: ready.login.origin,
      };
    if (outlook)
      return {
        kind: "oauth" as const,
        service: createMailboxService(
          ready.db,
          outlook,
          createOutlookAuthorization(outlook),
        ),
        session,
        origin: ready.login.origin,
      };
    throw new MailboxError("UNAVAILABLE");
  }
  // GET /api/connections is owned by storage-routes (combined connections view).
  app.delete("/api/connections/:id", async (c) => {
    try {
      const ready = await enabled(c);
      if ("response" in ready) return ready.response;
      const input = mailboxDisconnectRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!input.success || c.req.param("id").length > 120)
        return apiError(400, "invalid_request");
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
        const ready = await enabled(c, provider);
        if ("response" in ready) return ready.response;
        const input = mailboxStartRequestSchema.safeParse(
          await readAuthJson(c.req.raw),
        );
        if (!input.success) return apiError(400, "invalid_request");
        if (ready.kind !== "oauth") throw new MailboxError("UNAVAILABLE");
        return json(
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
        const ready = await enabled(c, provider);
        if ("response" in ready) return ready.response;
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
        if (ready.kind !== "oauth") throw new MailboxError("UNAVAILABLE");
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
