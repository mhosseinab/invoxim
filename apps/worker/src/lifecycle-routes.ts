import type { LifecycleBindings } from "@invoxim/adapters";
import {
  createLifecycleRepository,
  createPurchaseViewReader,
  lifecycleDependencies,
  PurchaseViewError,
  readAuthJson,
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
import type { Context } from "hono";
import { Hono } from "hono";
import {
  apiError,
  InvalidQueryError,
  issueMutationToken,
  json,
  mapFailure,
  requireTenantContext,
  uniqueQuery,
} from "./http/guard";

function failure(cause: unknown) {
  if (cause instanceof InvalidQueryError)
    return apiError(400, "invalid_request");
  if (cause instanceof PurchaseViewError && cause.code === "read_limit")
    return apiError(413, "narrow_export_range");
  if (cause instanceof LifecycleError) {
    const statuses = {
      INVALID_REQUEST: 400,
      NOT_FOUND: 404,
      CONFLICT: 409,
      TOO_LARGE: 413,
      UNAVAILABLE: 503,
    } as const;
    return apiError(statuses[cause.code], cause.code.toLowerCase());
  }
  return mapFailure(cause);
}
export function createLifecycleRoutes() {
  const app = new Hono<{ Bindings: LifecycleBindings }>();
  async function authorized(c: Context<{ Bindings: LifecycleBindings }>) {
    const request = c.req.raw;
    const bindings = c.env ?? {};
    const mutation = request.method !== "GET" && request.method !== "HEAD";
    if (mutation && new URL(request.url).search)
      return { response: apiError(400, "invalid_request") } as const;
    const ready = await requireTenantContext(c, {
      purpose: "lifecycle",
    });
    if ("response" in ready) return ready;
    if (bindings.LIFECYCLE_ENABLED !== "true")
      throw new LifecycleError("UNAVAILABLE");
    const dependencies = lifecycleDependencies(ready.db, bindings);
    return {
      ...ready,
      dependencies,
      current: ready.current,
      reader: createPurchaseViewReader(ready.db),
      service: createLifecycleService(
        createLifecycleRepository(ready.db),
        dependencies.journal,
        Date.now,
        dependencies.revoker,
      ),
      session: {
        tenant: ready.tenant,
        sessionId: ready.sessionId,
        authenticatedAt: ready.createdAtMs,
      },
    };
  }
  app.get("/api/lifecycle/capabilities", async (c) => {
    try {
      const ready = await authorized(c);
      if ("response" in ready) return ready.response;
      if (new URL(c.req.url).search) return apiError(400, "invalid_request");
      return json(
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
          mutationToken: await issueMutationToken(ready, "lifecycle"),
        }),
      );
    } catch (cause) {
      return failure(cause);
    }
  });
  app.get("/api/export", async (c) => {
    try {
      const ready = await authorized(c);
      if ("response" in ready) return ready.response;
      const input = lifecycleExportRequestSchema.safeParse(
        uniqueQuery(c.req.raw),
      );
      if (!input.success) return apiError(400, "invalid_request");
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
      const ready = await authorized(c);
      if ("response" in ready) return ready.response;
      const input = accountDeleteRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!input.success) return apiError(400, "invalid_request");
      return json(
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
      const ready = await authorized(c);
      if ("response" in ready) return ready.response;
      const id = lifecycleIdSchema.safeParse(c.req.param("id"));
      if (!id.success || new URL(c.req.url).search)
        return apiError(400, "invalid_request");
      const body = await readAuthJson(c.req.raw);
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0
      )
        return apiError(400, "invalid_request");
      return json(await ready.service.preview(ready.current.tenant, id.data));
    } catch (cause) {
      return failure(cause);
    }
  });
  app.post("/api/connections/:id/delete-data", async (c) => {
    try {
      const ready = await authorized(c);
      if ("response" in ready) return ready.response;
      const id = lifecycleIdSchema.safeParse(c.req.param("id"));
      const input = deleteDataRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!id.success || !input.success)
        return apiError(400, "invalid_request");
      return json(
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
      const ready = await authorized(c);
      if ("response" in ready) return ready.response;
      const id = lifecycleIdSchema.safeParse(c.req.param("id"));
      const input = disconnectRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!id.success || !input.success)
        return apiError(400, "invalid_request");
      return json(
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
