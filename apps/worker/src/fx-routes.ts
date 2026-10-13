import {
  type AuthBindings,
  AuthRequestError,
  createLoginAuth,
  createProfileService,
  type FxReferenceBindings,
  issueWorkspaceMutationToken,
  loginConfiguration,
  readAuthJson,
  verifyWorkspaceMutationToken,
} from "@invoxim/adapters";
import {
  fxPeriodRequestSchema,
  fxPeriodResponseSchema,
} from "@invoxim/contracts";
import type { TenantContext } from "@invoxim/core";
import type { Context } from "hono";
import { Hono } from "hono";
import type {
  FxPeriodInput,
  FxPeriodResult,
} from "../../../packages/adapters/src/fx/period";
import type {
  FxReportingPage,
  FxReportingPageInput,
  FxRevaluationPage,
} from "../../../packages/adapters/src/fx/service";
import {
  fxReportingExportSchema,
  fxReportingQuerySchema,
  fxReportingRequestSchema,
  fxReportingResponseSchema,
  fxRevaluationRequestSchema,
  fxRevaluationResponseSchema,
} from "../../../packages/contracts/src/fx-reporting";
import { createInvocationDatabase } from "./invocation-database";

export interface FxRouteBindings extends AuthBindings, FxReferenceBindings {}
export interface FxRouteService {
  readPeriod?(
    context: TenantContext,
    input: FxPeriodInput,
  ): Promise<FxPeriodResult>;
  readPage(
    context: TenantContext,
    input: FxReportingPageInput,
  ): Promise<FxReportingPage>;
  revaluePage(
    context: TenantContext,
    input: FxReportingPageInput,
  ): Promise<FxRevaluationPage>;
}
export interface FxRouteOptions {
  service(
    db: D1Database,
    bindings: FxRouteBindings,
    remainingStatements: () => number,
  ): FxRouteService | null;
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
  if (cause instanceof Error && cause.message === "INVALID_FX_INPUT")
    return error(400, "invalid_request");
  return error(503, "fx_unavailable");
}
function json(value: unknown) {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > 128 * 1024)
    return error(413, "response_too_large");
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
function query(request: Request) {
  const values: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    if (Object.hasOwn(values, key))
      throw new AuthRequestError(400, "invalid_request");
    values[key] = value;
  }
  return values;
}
function normalize(
  value: ReturnType<typeof fxReportingRequestSchema.parse>,
): FxReportingPageInput {
  const { purchaseId, cursor, ...required } = value;
  return {
    ...required,
    ...(purchaseId === undefined ? {} : { purchaseId }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}
/** Read-only pages never trigger valuation or public reference requests. */
export function createFxRoutes(options: FxRouteOptions) {
  const app = new Hono<{ Bindings: FxRouteBindings }>();
  app.use("/api/fx/*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
    c.res.headers.set("X-Content-Type-Options", "nosniff");
  });
  async function authorized(
    request: Request,
    bindings: FxRouteBindings,
    mutation: boolean,
  ) {
    const config = loginConfiguration(bindings);
    if (!config || !bindings.DB)
      return { response: error(401, "unauthorized") } as const;
    if (
      new URL(request.url).origin !== config.origin ||
      (request.method !== "GET"
        ? request.headers.get("origin") !== config.origin
        : request.headers.has("origin") &&
          request.headers.get("origin") !== config.origin)
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
          "fx-reporting",
        ))
      )
        return {
          response: error(403, "workspace_changed_or_expired"),
        } as const;
    }
    const service = options.service(
      database.db,
      bindings,
      database.remainingStatements,
    );
    if (!service) return { response: error(503, "fx_not_configured") } as const;
    return { service, tenant: current.tenant, identity, secret: config.secret };
  }
  async function reporting(
    c: Context<{ Bindings: FxRouteBindings }>,
    exportPage: boolean,
    body: boolean,
  ) {
    try {
      const ready = await authorized(c.req.raw, c.env ?? {}, false);
      if ("response" in ready) return ready.response;
      if (body && new URL(c.req.url).search)
        return error(400, "invalid_request");
      const parsed = body
        ? fxReportingRequestSchema.safeParse(
            await readAuthJson(c.req.raw, 40960),
          )
        : fxReportingQuerySchema.safeParse(query(c.req.raw));
      if (!parsed.success) return error(400, "invalid_request");
      const input = normalize(parsed.data);
      const page = await ready.service.readPage(ready.tenant, input);
      if (page.status === "stale") return error(409, "valuation_stale");
      const { entries, ...summary } = page;
      const common = {
        ...summary,
        summaryScope: "page" as const,
        expectedProfileVersion: input.expectedProfileVersion,
        reportingCurrency: input.reportingCurrency,
      };
      return exportPage
        ? json(
            fxReportingExportSchema.parse({
              ...common,
              schemaVersion: 1,
              rows: entries,
            }),
          )
        : json(
            fxReportingResponseSchema.parse({
              ...common,
              entries,
              mutationToken: await issueWorkspaceMutationToken(
                ready.identity,
                ready.secret,
                Date.now,
                "fx-reporting",
              ),
            }),
          );
    } catch (cause) {
      return failure(cause);
    }
  }
  app.post("/api/fx/reporting/period", async (c) => {
    try {
      const ready = await authorized(c.req.raw, c.env ?? {}, false);
      if ("response" in ready) return ready.response;
      if (new URL(c.req.url).search) return error(400, "invalid_request");
      const parsed = fxPeriodRequestSchema.safeParse(
        await readAuthJson(c.req.raw, 40960),
      );
      if (!parsed.success) return error(400, "invalid_request");
      if (!ready.service.readPeriod) return error(503, "fx_not_configured");
      const result = await ready.service.readPeriod(ready.tenant, {
        filters: parsed.data.filters,
        ...(parsed.data.stamp === undefined
          ? {}
          : { stamp: parsed.data.stamp }),
        ...(parsed.data.continuation === undefined
          ? {}
          : { continuation: parsed.data.continuation }),
        actorKey: ready.identity.sessionId,
      });
      return result.status === "stale"
        ? error(409, "valuation_stale")
        : json(fxPeriodResponseSchema.parse(result));
    } catch (cause) {
      return failure(cause);
    }
  });
  app.get("/api/fx/reporting", (c) => reporting(c, false, false));
  app.get("/api/fx/reporting/export", (c) => reporting(c, true, false));
  // POST supports large opaque cursors without relying on the deployment's URL length limit.
  app.post("/api/fx/reporting/page", (c) => reporting(c, false, true));
  app.post("/api/fx/reporting/export", (c) => reporting(c, true, true));
  app.post("/api/fx/revalue", async (c) => {
    try {
      const ready = await authorized(c.req.raw, c.env ?? {}, true);
      if ("response" in ready) return ready.response;
      if (new URL(c.req.url).search) return error(400, "invalid_request");
      const parsed = fxRevaluationRequestSchema.safeParse(
        await readAuthJson(c.req.raw, 40960),
      );
      if (!parsed.success) return error(400, "invalid_request");
      const page = await ready.service.revaluePage(
        ready.tenant,
        normalize(parsed.data),
      );
      return page.status === "stale"
        ? error(409, "valuation_stale")
        : json(fxRevaluationResponseSchema.parse(page));
    } catch (cause) {
      return failure(cause);
    }
  });
  return app;
}
