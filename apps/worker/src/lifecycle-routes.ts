import type { LifecycleBindings } from "@invoxim/adapters";
import {
  AuthRequestError,
  createLifecycleRepository,
  createLoginAuth,
  createProfileService,
  createPurchaseViewReader,
  issueWorkspaceMutationToken,
  lifecycleDependencies,
  loginConfiguration,
  PurchaseViewError,
  readAuthJson,
  verifyWorkspaceMutationToken,
} from "@invoxim/adapters";
import {
  accountDeleteRequestSchema,
  deleteDataRequestSchema,
  disconnectRequestSchema,
  lifecycleCapabilitiesSchema,
  lifecycleExportRequestSchema,
  lifecycleExportSchema,
  lifecycleIdSchema,
} from "@invoxim/contracts";
import {
  createLifecycleService,
  encodeLifecycleExport,
  LifecycleError,
} from "@invoxim/core";
import { Hono } from "hono";
import { createInvocationDatabase } from "./invocation-database";

function error(
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 503,
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
  if (cause instanceof PurchaseViewError && cause.code === "read_limit")
    return error(413, "narrow_export_range");
  if (cause instanceof AuthRequestError) return error(cause.status, cause.code);
  if (cause instanceof LifecycleError) {
    const statuses = {
      INVALID_REQUEST: 400,
      NOT_FOUND: 404,
      CONFLICT: 409,
      TOO_LARGE: 413,
      UNAVAILABLE: 503,
    } as const;
    return error(statuses[cause.code], cause.code.toLowerCase());
  }
  return error(503, "unavailable");
}
function query(request: Request) {
  const values: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    if (Object.hasOwn(values, key)) throw new LifecycleError("INVALID_REQUEST");
    values[key] = value;
  }
  return values;
}
export function createLifecycleRoutes() {
  const app = new Hono<{ Bindings: LifecycleBindings }>();
  for (const path of [
    "/api/lifecycle/capabilities",
    "/api/export",
    "/api/account/delete",
    "/api/connections/*",
  ])
    app.use(path, async (c, next) => {
      await next();
      c.res.headers.set("Cache-Control", "no-store");
      c.res.headers.set("X-Content-Type-Options", "nosniff");
    });
  async function authorized(request: Request, bindings: LifecycleBindings) {
    const configuration = loginConfiguration(bindings);
    if (!configuration || !bindings.DB)
      return { response: error(401, "unauthorized") } as const;
    const mutation = request.method !== "GET";
    if (mutation && new URL(request.url).search)
      return { response: error(400, "invalid_request") } as const;
    if (
      new URL(request.url).origin !== configuration.origin ||
      (mutation
        ? request.headers.get("origin") !== configuration.origin
        : request.headers.has("origin") &&
          request.headers.get("origin") !== configuration.origin)
    )
      return { response: error(403, "origin_required") } as const;
    const db = createInvocationDatabase(bindings.DB, 40).db;
    const current = await createProfileService(
      db,
      createLoginAuth(db, configuration),
      configuration,
    ).current(request.headers);
    if (!current) return { response: error(401, "unauthorized") } as const;
    if (bindings.LIFECYCLE_ENABLED !== "true")
      throw new LifecycleError("UNAVAILABLE");
    const createdAtMs = current.session.createdAt.getTime();
    if (
      mutation &&
      (!Number.isSafeInteger(createdAtMs) ||
        createdAtMs > Date.now() ||
        Date.now() - createdAtMs > 3600000)
    )
      return { response: error(403, "recent_auth_required") } as const;
    const identity = {
      userId: current.tenant.userId,
      sessionId: current.session.id,
    };
    if (
      mutation &&
      !(await verifyWorkspaceMutationToken(
        request.headers.get("X-Workspace-Token") ?? "",
        identity,
        configuration.secret,
        Date.now,
        "lifecycle",
      ))
    )
      return { response: error(403, "workspace_changed_or_expired") } as const;
    const dependencies = lifecycleDependencies(db, bindings);
    return {
      db,
      identity,
      secret: configuration.secret,
      dependencies,
      current,
      reader: createPurchaseViewReader(db),
      service: createLifecycleService(
        createLifecycleRepository(db),
        dependencies.journal,
        Date.now,
        dependencies.revoker,
      ),
      session: {
        tenant: current.tenant,
        sessionId: current.session.id,
        authenticatedAt: current.session.createdAt.getTime(),
      },
    };
  }
  app.get("/api/lifecycle/capabilities", async (c) => {
    try {
      const ready = await authorized(c.req.raw, c.env ?? {});
      if ("response" in ready) return ready.response;
      if (new URL(c.req.url).search) return error(400, "invalid_request");
      return c.json(
        lifecycleCapabilitiesSchema.parse({
          accountDeletionAvailable: ready.dependencies.journal !== null,
          providerRevocation: {
            available: ready.dependencies.revoker !== null,
            requiresExplicitOptIn: true,
            scope: "google-project-wide",
            mayAffect: ["mailboxes", "storage", "login"],
          },
          exports: { maxPurchases: 500, maxEvents: 2000, maxBytes: 2097152 },
          driveFilesDeleted: false,
          mutationToken: await issueWorkspaceMutationToken(
            ready.identity,
            ready.secret,
            Date.now,
            "lifecycle",
          ),
        }),
      );
    } catch (cause) {
      return failure(cause);
    }
  });
  app.get("/api/export", async (c) => {
    try {
      const ready = await authorized(c.req.raw, c.env ?? {});
      if ("response" in ready) return ready.response;
      const input = lifecycleExportRequestSchema.safeParse(query(c.req.raw));
      if (!input.success) return error(400, "invalid_request");
      const { format, ...filters } = input.data;
      const snapshot = await ready.reader.exportSnapshot(
        ready.current.tenant,
        filters,
      );
      const document = lifecycleExportSchema.parse({
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        filters,
        preferences: {
          timezone: ready.current.profile.timezone,
          reportingCurrency: ready.current.profile.reporting_currency,
        },
        ...snapshot,
        summary: snapshot.summary,
      });
      return new Response(encodeLifecycleExport(document, format), {
        headers: {
          "Content-Type":
            format === "json"
              ? "application/json; charset=utf-8"
              : "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="purchase-records.${format}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (cause) {
      return failure(cause);
    }
  });
  app.post("/api/account/delete", async (c) => {
    try {
      const ready = await authorized(c.req.raw, c.env ?? {});
      if ("response" in ready) return ready.response;
      const input = accountDeleteRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!input.success) return error(400, "invalid_request");
      return c.json(
        await ready.service.deleteAccount(
          ready.session,
          input.data,
          c.req.header("Idempotency-Key") ?? "",
        ),
        202,
      );
    } catch (cause) {
      return failure(cause);
    }
  });
  app.post("/api/connections/:id/delete-data-preview", async (c) => {
    try {
      const ready = await authorized(c.req.raw, c.env ?? {});
      if ("response" in ready) return ready.response;
      const id = lifecycleIdSchema.safeParse(c.req.param("id"));
      if (!id.success || new URL(c.req.url).search)
        return error(400, "invalid_request");
      const body = await readAuthJson(c.req.raw);
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0
      )
        return error(400, "invalid_request");
      return c.json(await ready.service.preview(ready.current.tenant, id.data));
    } catch (cause) {
      return failure(cause);
    }
  });
  app.post("/api/connections/:id/delete-data", async (c) => {
    try {
      const ready = await authorized(c.req.raw, c.env ?? {});
      if ("response" in ready) return ready.response;
      const id = lifecycleIdSchema.safeParse(c.req.param("id"));
      const input = deleteDataRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!id.success || !input.success) return error(400, "invalid_request");
      return c.json(
        await ready.service.deleteData(
          ready.session,
          id.data,
          input.data,
          c.req.header("Idempotency-Key") ?? "",
        ),
        202,
      );
    } catch (cause) {
      return failure(cause);
    }
  });
  // OD-1: mailbox owns plain disconnect (24488b8). Lifecycle keeps the
  // confirmed/revocation disconnect only while its flag is on; otherwise this
  // route yields to the mailbox handler instead of failing the request.
  app.delete("/api/connections/:id", async (c, next) => {
    if (c.env?.LIFECYCLE_ENABLED !== "true") return next();
    try {
      const ready = await authorized(c.req.raw, c.env ?? {});
      if ("response" in ready) return ready.response;
      const id = lifecycleIdSchema.safeParse(c.req.param("id"));
      const input = disconnectRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!id.success || !input.success) return error(400, "invalid_request");
      return c.json(
        await ready.service.disconnect(
          ready.session,
          id.data,
          input.data,
          c.req.header("Idempotency-Key") ?? "",
        ),
      );
    } catch (cause) {
      return failure(cause);
    }
  });
  return app;
}
