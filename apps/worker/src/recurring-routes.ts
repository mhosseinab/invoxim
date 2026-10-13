import {
  type AuthBindings,
  AuthRequestError,
  createLoginAuth,
  createProfileService,
  issueWorkspaceMutationToken,
  loginConfiguration,
  readAuthJson,
  verifyWorkspaceMutationToken,
} from "@invoxim/adapters";
import {
  recurringAutomaticPreviewSchema,
  recurringCreateSchema,
  recurringDecisionInputSchema,
  recurringDetailResponseSchema,
  recurringListResponseSchema,
  recurringPageLimit,
  recurringPreviewResponseSchema,
  recurringWriteResponseSchema,
} from "@invoxim/contracts";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type {
  createRecurringService,
  RecurringListInput,
  RecurringWriteResult,
} from "../../../packages/adapters/src/recurring/service";
import { createInvocationDatabase } from "./invocation-database";

export interface RecurringRouteOptions {
  service(
    db: D1Database,
    bindings: AuthBindings,
  ): ReturnType<typeof createRecurringService> | null;
}
function error(status: number, code: string) {
  return Response.json(
    {
      error: {
        code,
        message: "Request unavailable",
        requestId: crypto.randomUUID(),
        retryable: status === 503,
      },
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
function failure(cause: unknown) {
  if (cause instanceof AuthRequestError) return error(cause.status, cause.code);
  if (cause instanceof Error && cause.message === "INVALID_RECURRING_INPUT")
    return error(400, "invalid_request");
  return error(503, "recurring_unavailable");
}
function json(value: unknown, status = 200) {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > 128 * 1024)
    return error(413, "response_too_large");
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
function listInput(request: Request): RecurringListInput {
  let limit = recurringPageLimit;
  let after: string | undefined;
  const seen = new Set<string>();
  for (const [key, value] of new URL(request.url).searchParams) {
    if (seen.has(key)) throw new AuthRequestError(400, "invalid_request");
    seen.add(key);
    if (
      key === "limit" &&
      /^[1-9][0-9]?$/.test(value) &&
      Number(value) <= recurringPageLimit
    )
      limit = Number(value);
    else if (
      key === "after" &&
      recurringCreateSchema.shape.id.safeParse(value).success
    )
      after = value;
    else throw new AuthRequestError(400, "invalid_request");
  }
  return { limit, ...(after === undefined ? {} : { after }) };
}
function stored(result: RecurringWriteResult, status = 200) {
  if (result.status === "conflict") return error(409, "recurring_changed");
  if (result.status === "invalid_evidence")
    return error(422, "insufficient_recurring_evidence");
  return json(recurringWriteResponseSchema.parse(result), status);
}
/** All forecasts remain estimates; these routes cannot create ledger events or contact providers. */
export function createRecurringRoutes(options: RecurringRouteOptions) {
  const app = new Hono<{ Bindings: AuthBindings }>();
  const headers: MiddlewareHandler<{ Bindings: AuthBindings }> = async (
    c,
    next,
  ) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
    c.res.headers.set("X-Content-Type-Options", "nosniff");
  };
  app.use("/api/recurring", headers);
  app.use("/api/recurring/*", headers);
  async function authorized(
    request: Request,
    bindings: AuthBindings,
    mutation: boolean,
  ) {
    const config = loginConfiguration(bindings);
    if (!config || !bindings.DB)
      return { response: error(401, "unauthorized") } as const;
    if (
      new URL(request.url).origin !== config.origin ||
      (request.method !== "GET"
        ? request.headers.get("Origin") !== config.origin
        : request.headers.has("Origin") &&
          request.headers.get("Origin") !== config.origin)
    )
      return { response: error(403, "origin_required") } as const;
    const database = createInvocationDatabase(bindings.DB, 40);
    const current = await createProfileService(
      database.db,
      createLoginAuth(database.db, config),
      config,
    ).current(request.headers);
    if (!current) return { response: error(401, "unauthorized") } as const;
    const identity = {
      userId: current.tenant.userId,
      sessionId: current.session.id,
    };
    if (mutation) {
      const time = Date.now(),
        createdAt = current.session.createdAt.getTime();
      if (
        !Number.isSafeInteger(createdAt) ||
        createdAt > time ||
        time - createdAt > 3600000
      )
        return { response: error(403, "recent_auth_required") } as const;
      if (
        !(await verifyWorkspaceMutationToken(
          request.headers.get("X-Workspace-Token") ?? "",
          identity,
          config.secret,
          Date.now,
          "recurring",
        ))
      )
        return {
          response: error(403, "workspace_changed_or_expired"),
        } as const;
    }
    const service = options.service(database.db, bindings);
    if (!service)
      return { response: error(503, "recurring_not_configured") } as const;
    return { service, tenant: current.tenant, identity, secret: config.secret };
  }
  async function mutationToken(ready: {
    identity: { userId: string; sessionId: string };
    secret: string;
  }) {
    return issueWorkspaceMutationToken(
      ready.identity,
      ready.secret,
      Date.now,
      "recurring",
    );
  }
  type RouteContext = Context<{ Bindings: AuthBindings }>;
  async function mutate(
    c: RouteContext,
    operation: "create" | "decide" | "preview",
  ) {
    try {
      const ready = await authorized(c.req.raw, c.env ?? {}, true);
      if ("response" in ready) return ready.response;
      if (new URL(c.req.url).search) return error(400, "invalid_request");
      const body = await readAuthJson(c.req.raw, 16384);
      if (operation === "create") {
        const input = recurringCreateSchema.safeParse(body);
        if (!input.success) return error(400, "invalid_request");
        return stored(
          await ready.service.createUserSeries(ready.tenant, input.data),
          201,
        );
      }
      if (operation === "decide") {
        const input = recurringDecisionInputSchema.safeParse(body);
        if (!input.success) return error(400, "invalid_request");
        return stored(
          await ready.service.decide(
            ready.tenant,
            c.req.param("id") ?? "",
            input.data,
          ),
        );
      }
      const input = recurringAutomaticPreviewSchema.safeParse(body);
      if (!input.success) return error(400, "invalid_request");
      const result = await ready.service.previewAutomatic(
        ready.tenant,
        input.data,
      );
      return result.status === "conflict"
        ? error(409, "recurring_changed")
        : json(recurringPreviewResponseSchema.parse({ result }));
    } catch (cause) {
      return failure(cause);
    }
  }
  app.get("/api/recurring", async (c) => {
    try {
      const ready = await authorized(c.req.raw, c.env ?? {}, false);
      if ("response" in ready) return ready.response;
      const page = await ready.service.list(ready.tenant, listInput(c.req.raw));
      return page.status === "stale"
        ? error(409, "recurring_changed")
        : json(
            recurringListResponseSchema.parse({
              ...page,
              pageScope: "page",
              pageSnapshot: false,
              automaticSuggestionsAvailable: false,
              userSelectionRequired: true,
              mutationToken: await mutationToken(ready),
            }),
          );
    } catch (cause) {
      return failure(cause);
    }
  });
  app.get("/api/recurring/:id", async (c) => {
    try {
      const ready = await authorized(c.req.raw, c.env ?? {}, false);
      if ("response" in ready) return ready.response;
      if (new URL(c.req.url).search) return error(400, "invalid_request");
      const record = await ready.service.read(ready.tenant, c.req.param("id"));
      return record.status === "missing"
        ? error(404, "not_found")
        : json(
            recurringDetailResponseSchema.parse({
              record,
              mutationToken: await mutationToken(ready),
            }),
          );
    } catch (cause) {
      return failure(cause);
    }
  });
  app.post("/api/recurring", (c) => mutate(c, "create"));
  app.patch("/api/recurring/:id", (c) => mutate(c, "decide"));
  app.post("/api/recurring/preview", (c) => mutate(c, "preview"));
  return app;
}
