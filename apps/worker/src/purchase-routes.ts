import type { GmailBindings, OutlookBindings } from "@invoxim/adapters";
import {
  createPurchaseViewReader,
  createReviewSourceReader,
  gmailConfiguration,
  lookupReviewProvider,
  outlookConfiguration,
  PurchaseViewError,
  ReviewSourceError,
} from "@invoxim/adapters";
import {
  purchaseFiltersSchema,
  purchaseListRequestSchema,
  purchaseReviewRequestSchema,
} from "@invoxim/contracts";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  apiError,
  InvalidQueryError,
  json,
  mapFailure,
  requireTenantContext,
  uniqueQuery,
} from "./http/guard";
export function createPurchaseRoutes() {
  const app = new Hono<{ Bindings: GmailBindings & OutlookBindings }>();
  async function authorized(
    c: Context<{ Bindings: GmailBindings & OutlookBindings }>,
  ) {
    const ready = await requireTenantContext(c, {
      mutation: false,
      recent: false,
    });
    if ("response" in ready) return ready;
    return {
      db: ready.db,
      reader: createPurchaseViewReader(ready.db),
      tenant: ready.tenant,
    };
  }
  app.get("/api/review/:id/source", async (c) => {
    try {
      const current = await authorized(c);
      if ("response" in current) return current.response;
      if (new URL(c.req.url).search) return apiError(400, "invalid_request");
      const provider = await lookupReviewProvider(
        current.db,
        current.tenant.userId,
        c.req.param("id"),
      );
      if (!provider) return apiError(404, "not_found");
      const configuration =
        provider === "gmail"
          ? gmailConfiguration(c.env)
          : provider === "outlook"
            ? outlookConfiguration(c.env)
            : null;
      if (!configuration) return apiError(503, "source_unavailable");
      return json(
        await createReviewSourceReader(current.db, configuration).read(
          current.tenant,
          c.req.param("id"),
        ),
      );
    } catch (cause) {
      if (cause instanceof ReviewSourceError)
        return apiError(cause.code === "not_found" ? 404 : 503, cause.code);
      return apiError(503, "source_unavailable");
    }
  });
  app.get("/api/purchase-reviews", async (c) => {
    try {
      const current = await authorized(c);
      if ("response" in current) return current.response;
      const input = purchaseReviewRequestSchema.safeParse(
        uniqueQuery(c.req.raw),
      );
      if (!input.success) return apiError(400, "invalid_request");
      return json(
        await current.reader.reviews(current.tenant, input.data.limit),
      );
    } catch (cause) {
      return failure(cause);
    }
  });
  app.get("/api/purchases", async (c) => {
    try {
      const current = await authorized(c);
      if ("response" in current) return current.response;
      const input = purchaseListRequestSchema.safeParse(uniqueQuery(c.req.raw));
      if (!input.success) return apiError(400, "invalid_request");
      return json(await current.reader.list(current.tenant, input.data));
    } catch (cause) {
      return failure(cause);
    }
  });
  async function summary(
    c: Context<{ Bindings: GmailBindings & OutlookBindings }>,
  ) {
    try {
      const current = await authorized(c);
      if ("response" in current) return current.response;
      const input = purchaseFiltersSchema.safeParse(uniqueQuery(c.req.raw));
      if (!input.success) return apiError(400, "invalid_request");
      return json(await current.reader.summary(current.tenant, input.data));
    } catch (cause) {
      return failure(cause);
    }
  }
  app.get("/api/purchases/summary", summary);
  app.get("/api/summary", summary);
  app.get("/api/purchases/coverage", async (c) => {
    try {
      const current = await authorized(c);
      if ("response" in current) return current.response;
      if (new URL(c.req.url).search) return apiError(400, "invalid_request");
      return json(await current.reader.coverage(current.tenant));
    } catch (cause) {
      return failure(cause);
    }
  });
  app.get("/api/purchases/:id", async (c) => {
    try {
      const current = await authorized(c);
      if ("response" in current) return current.response;
      const input = purchaseFiltersSchema.safeParse(uniqueQuery(c.req.raw));
      if (!input.success) return apiError(400, "invalid_request");
      const detail = await current.reader.detail(
        current.tenant,
        c.req.param("id"),
        input.data,
      );
      return detail ? json(detail) : apiError(404, "not_found");
    } catch (cause) {
      return failure(cause);
    }
  });
  return app;
}
function failure(cause: unknown) {
  if (cause instanceof InvalidQueryError)
    return apiError(400, "invalid_request");
  return cause instanceof PurchaseViewError && cause.code === "invalid_request"
    ? apiError(400, cause.code)
    : mapFailure(cause);
}
