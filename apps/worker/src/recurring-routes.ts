import { type AuthBindings, readAuthJson } from "@invoxim/adapters";
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
import type { Context } from "hono";
import { Hono } from "hono";
import type {
  createRecurringService,
  RecurringListInput,
  RecurringWriteResult,
} from "../../../packages/adapters/src/recurring/service";
import {
  apiError,
  InvalidQueryError,
  issueMutationToken,
  json,
  mapFailure,
  requireTenantContext,
  uniqueQuery,
} from "./http/guard";

export interface RecurringRouteOptions {
  service(
    db: D1Database,
    bindings: AuthBindings,
  ): ReturnType<typeof createRecurringService> | null;
}
function failure(cause: unknown) {
  if (cause instanceof InvalidQueryError)
    return apiError(400, "invalid_request");
  if (cause instanceof Error && cause.message === "INVALID_RECURRING_INPUT")
    return apiError(400, "invalid_request");
  return mapFailure(cause, "recurring_unavailable");
}
function listInput(request: Request): RecurringListInput {
  const params = uniqueQuery(request);
  let limit = recurringPageLimit;
  let after: string | undefined;
  for (const [key, value] of Object.entries(params)) {
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
    else throw new Error("INVALID_RECURRING_INPUT");
  }
  return { limit, ...(after === undefined ? {} : { after }) };
}
function stored(result: RecurringWriteResult, status = 200) {
  if (result.status === "conflict") return apiError(409, "recurring_changed");
  if (result.status === "invalid_evidence")
    return apiError(422, "insufficient_recurring_evidence");
  return json(recurringWriteResponseSchema.parse(result), status);
}
/** All forecasts remain estimates; these routes cannot create ledger events or contact providers. */
export function createRecurringRoutes(options: RecurringRouteOptions) {
  const app = new Hono<{ Bindings: AuthBindings }>();
  async function authorized(
    c: Context<{ Bindings: AuthBindings }>,
    mutation: boolean,
  ) {
    const ready = await requireTenantContext(c, {
      mutation,
      recent: mutation,
      purpose: "recurring",
    });
    if ("response" in ready) return ready;
    const service = options.service(ready.db, c.env ?? {});
    if (!service)
      return { response: apiError(503, "recurring_not_configured") } as const;
    return { ...ready, service };
  }
  async function mutationToken(ready: {
    identity: { userId: string; sessionId: string };
    secret: string;
  }) {
    return issueMutationToken(ready, "recurring");
  }
  type RouteContext = Context<{ Bindings: AuthBindings }>;
  async function mutate(
    c: RouteContext,
    operation: "create" | "decide" | "preview",
  ) {
    try {
      const ready = await authorized(c, true);
      if ("response" in ready) return ready.response;
      if (new URL(c.req.url).search) return apiError(400, "invalid_request");
      const body = await readAuthJson(c.req.raw, 16384);
      if (operation === "create") {
        const input = recurringCreateSchema.safeParse(body);
        if (!input.success) return apiError(400, "invalid_request");
        return stored(
          await ready.service.createUserSeries(ready.tenant, input.data),
          201,
        );
      }
      if (operation === "decide") {
        const input = recurringDecisionInputSchema.safeParse(body);
        if (!input.success) return apiError(400, "invalid_request");
        return stored(
          await ready.service.decide(
            ready.tenant,
            c.req.param("id") ?? "",
            input.data,
          ),
        );
      }
      const input = recurringAutomaticPreviewSchema.safeParse(body);
      if (!input.success) return apiError(400, "invalid_request");
      const result = await ready.service.previewAutomatic(
        ready.tenant,
        input.data,
      );
      return result.status === "conflict"
        ? apiError(409, "recurring_changed")
        : json(recurringPreviewResponseSchema.parse({ result }));
    } catch (cause) {
      return failure(cause);
    }
  }
  app.get("/api/recurring", async (c) => {
    try {
      const ready = await authorized(c, false);
      if ("response" in ready) return ready.response;
      const page = await ready.service.list(ready.tenant, listInput(c.req.raw));
      return page.status === "stale"
        ? apiError(409, "recurring_changed")
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
      const ready = await authorized(c, false);
      if ("response" in ready) return ready.response;
      if (new URL(c.req.url).search) return apiError(400, "invalid_request");
      const record = await ready.service.read(ready.tenant, c.req.param("id"));
      return record.status === "missing"
        ? apiError(404, "not_found")
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
