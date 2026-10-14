import type { GmailBindings, OutlookBindings } from "@invoxim/adapters";
import {
  createPurchaseViewReader,
  createReviewSourceReader,
  gmailConfiguration,
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
import { apiError, mapFailure, requireTenantContext } from "./http/guard";

function json(value: unknown) {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > 128 * 1024)
    return apiError(413, "response_too_large");
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
function query(request: Request) {
  const values: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    if (Object.hasOwn(values, key))
      throw new PurchaseViewError("invalid_request");
    values[key] = value;
  }
  return values;
}
export function createPurchaseRoutes() {
  const app = new Hono<{ Bindings: GmailBindings & OutlookBindings }>();
  app.use("/api/purchases/*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
  });
  app.use("/api/purchases", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
  });
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
      const provider = await current.db
        .prepare(
          "SELECT c.provider FROM review_items r JOIN documents d ON d.user_id=r.user_id AND d.id=r.document_id JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id JOIN connections c ON c.user_id=s.user_id AND c.id=s.connection_id WHERE r.user_id=? AND r.id=? AND r.status='open' AND c.kind='mailbox'",
        )
        .bind(current.tenant.userId, c.req.param("id"))
        .first<string>("provider");
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
      const input = purchaseReviewRequestSchema.safeParse(query(c.req.raw));
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
      const input = purchaseListRequestSchema.safeParse(query(c.req.raw));
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
      const input = purchaseFiltersSchema.safeParse(query(c.req.raw));
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
      const input = purchaseFiltersSchema.safeParse(query(c.req.raw));
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
  return cause instanceof PurchaseViewError && cause.code === "invalid_request"
    ? apiError(400, cause.code)
    : mapFailure(cause);
}
