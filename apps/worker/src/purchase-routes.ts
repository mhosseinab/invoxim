import type { GmailBindings, OutlookBindings } from "@invoxim/adapters";
import {
  createLoginAuth,
  createProfileService,
  createPurchaseViewReader,
  createReviewSourceReader,
  gmailConfiguration,
  loginConfiguration,
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
import { createInvocationDatabase } from "./invocation-database";

function error(status: 400 | 401 | 403 | 404 | 413 | 503, code: string) {
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
function json(value: unknown) {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > 128 * 1024)
    return error(413, "response_too_large");
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
    request: Request,
    bindings: GmailBindings & OutlookBindings,
  ) {
    const configuration = loginConfiguration(bindings);
    if (!configuration || !bindings.DB)
      return { response: error(401, "unauthorized") } as const;
    if (
      new URL(request.url).origin !== configuration.origin ||
      (request.headers.has("origin") &&
        request.headers.get("origin") !== configuration.origin)
    )
      return { response: error(403, "origin_required") } as const;
    const database = createInvocationDatabase(bindings.DB, 40);
    const current = await createProfileService(
      database.db,
      createLoginAuth(database.db, configuration),
      configuration,
    ).current(request.headers);
    if (!current) return { response: error(401, "unauthorized") } as const;
    return {
      db: database.db,
      reader: createPurchaseViewReader(database.db),
      tenant: current.tenant,
    };
  }
  app.get("/api/review/:id/source", async (c) => {
    try {
      const current = await authorized(c.req.raw, c.env ?? {});
      if ("response" in current) return current.response;
      if (new URL(c.req.url).search) return error(400, "invalid_request");
      const provider = await current.db
        .prepare(
          "SELECT c.provider FROM review_items r JOIN documents d ON d.user_id=r.user_id AND d.id=r.document_id JOIN source_messages s ON s.user_id=d.user_id AND s.id=d.source_message_id JOIN connections c ON c.user_id=s.user_id AND c.id=s.connection_id WHERE r.user_id=? AND r.id=? AND r.status='open' AND c.kind='mailbox'",
        )
        .bind(current.tenant.userId, c.req.param("id"))
        .first<string>("provider");
      if (!provider) return error(404, "not_found");
      const configuration =
        provider === "gmail"
          ? gmailConfiguration(c.env)
          : provider === "outlook"
            ? outlookConfiguration(c.env)
            : null;
      if (!configuration) return error(503, "source_unavailable");
      return json(
        await createReviewSourceReader(current.db, configuration).read(
          current.tenant,
          c.req.param("id"),
        ),
      );
    } catch (cause) {
      if (cause instanceof ReviewSourceError)
        return error(cause.code === "not_found" ? 404 : 503, cause.code);
      return error(503, "source_unavailable");
    }
  });
  app.get("/api/purchase-reviews", async (c) => {
    try {
      const current = await authorized(c.req.raw, c.env ?? {});
      if ("response" in current) return current.response;
      const input = purchaseReviewRequestSchema.safeParse(query(c.req.raw));
      if (!input.success) return error(400, "invalid_request");
      return json(
        await current.reader.reviews(current.tenant, input.data.limit),
      );
    } catch (cause) {
      return failure(cause);
    }
  });
  app.get("/api/purchases", async (c) => {
    try {
      const current = await authorized(c.req.raw, c.env ?? {});
      if ("response" in current) return current.response;
      const input = purchaseListRequestSchema.safeParse(query(c.req.raw));
      if (!input.success) return error(400, "invalid_request");
      return json(await current.reader.list(current.tenant, input.data));
    } catch (cause) {
      return failure(cause);
    }
  });
  async function summary(
    c: Context<{ Bindings: GmailBindings & OutlookBindings }>,
  ) {
    try {
      const current = await authorized(c.req.raw, c.env ?? {});
      if ("response" in current) return current.response;
      const input = purchaseFiltersSchema.safeParse(query(c.req.raw));
      if (!input.success) return error(400, "invalid_request");
      return json(await current.reader.summary(current.tenant, input.data));
    } catch (cause) {
      return failure(cause);
    }
  }
  app.get("/api/purchases/summary", summary);
  app.get("/api/summary", summary);
  app.get("/api/purchases/coverage", async (c) => {
    try {
      const current = await authorized(c.req.raw, c.env ?? {});
      if ("response" in current) return current.response;
      if (new URL(c.req.url).search) return error(400, "invalid_request");
      return json(await current.reader.coverage(current.tenant));
    } catch (cause) {
      return failure(cause);
    }
  });
  app.get("/api/purchases/:id", async (c) => {
    try {
      const current = await authorized(c.req.raw, c.env ?? {});
      if ("response" in current) return current.response;
      const input = purchaseFiltersSchema.safeParse(query(c.req.raw));
      if (!input.success) return error(400, "invalid_request");
      const detail = await current.reader.detail(
        current.tenant,
        c.req.param("id"),
        input.data,
      );
      return detail ? json(detail) : error(404, "not_found");
    } catch (cause) {
      return failure(cause);
    }
  });
  return app;
}
function failure(cause: unknown) {
  return cause instanceof PurchaseViewError && cause.code === "invalid_request"
    ? error(400, cause.code)
    : error(503, "unavailable");
}
