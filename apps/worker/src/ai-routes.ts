import type { AiBindings } from "@invoxim/adapters";
import {
  AiSettingsError,
  AuthRequestError,
  aiConfiguration,
  createAiProbeService,
  createAiSettingsService,
  createLoginAuth,
  createProfileService,
  issueWorkspaceMutationToken,
  loginConfiguration,
  readAuthJson,
  verifyWorkspaceMutationToken,
} from "@invoxim/adapters";
import {
  aiKeyDeleteRequestSchema,
  aiSettingsRequestSchema,
  aiTestRequestSchema,
  aiTestResponseSchema,
} from "@invoxim/contracts";
import { Hono } from "hono";
import { createInvocationDatabase } from "./invocation-database";
export function createAiRoutes() {
  const app = new Hono<{ Bindings: AiBindings }>();
  app.use("/api/ai/*", async (context, next) => {
    await next();
    context.res.headers.set("Cache-Control", "no-store");
  });
  function error(
    status: 400 | 401 | 403 | 409 | 413 | 415 | 429 | 503,
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
  function failed(cause: unknown) {
    if (cause instanceof AuthRequestError)
      return error(cause.status, cause.code);
    if (cause instanceof AiSettingsError) {
      const status = {
        UNAUTHORIZED: 401,
        INVALID_REQUEST: 400,
        CONFLICT: 409,
        UNAVAILABLE: 503,
        BUDGET: 429,
      } as const;
      return error(status[cause.code], cause.code.toLowerCase());
    }
    return error(503, "unavailable");
  }
  async function enabled(request: Request, bindings: AiBindings) {
    const login = loginConfiguration(bindings);
    if (!login || !bindings.DB) throw new AiSettingsError("UNAUTHORIZED");
    const database = createInvocationDatabase(bindings.DB, 40);
    const db = database.db;
    if (
      new URL(request.url).origin !== login.origin ||
      (!["GET", "HEAD"].includes(request.method) &&
        request.headers.get("origin") !== login.origin)
    )
      return { denied: true } as const;
    const current = await createProfileService(
      db,
      createLoginAuth(db, login),
      login,
    ).current(request.headers);
    if (!current) throw new AiSettingsError("UNAUTHORIZED");
    const mutation = request.method !== "GET" && request.method !== "HEAD";
    const createdAtMs = current.session.createdAt.getTime();
    if (
      mutation &&
      (!Number.isSafeInteger(createdAtMs) ||
        createdAtMs > Date.now() ||
        Date.now() - createdAtMs > 3600000)
    )
      return { denied: true } as const;
    if (
      mutation &&
      !(await verifyWorkspaceMutationToken(
        request.headers.get("X-Workspace-Token") ?? "",
        { userId: current.tenant.userId, sessionId: current.session.id },
        login.secret,
        Date.now,
        "ai-settings",
      ))
    )
      return { denied: "workspace_changed" } as const;
    const configuration = aiConfiguration(bindings);
    if (!configuration) throw new AiSettingsError("UNAVAILABLE");
    return {
      settings: createAiSettingsService(db, configuration),
      probe: createAiProbeService(db, configuration),
      session: { tenant: current.tenant, sessionId: current.session.id },
      workspaceIdentity: {
        userId: current.tenant.userId,
        sessionId: current.session.id,
      },
      signingSecret: login.secret,
    };
  }
  app.get("/api/ai/settings", async (c) => {
    try {
      const ready = await enabled(c.req.raw, c.env ?? {});
      if ("denied" in ready)
        return error(
          403,
          ready.denied === true
            ? "origin_or_recent_auth_required"
            : "workspace_changed",
        );
      return c.json({
        ...(await ready.settings.get(ready.session.tenant)),
        mutationToken: await issueWorkspaceMutationToken(
          ready.workspaceIdentity,
          ready.signingSecret,
          Date.now,
          "ai-settings",
        ),
      });
    } catch (cause) {
      return failed(cause);
    }
  });
  app.put("/api/ai/settings", async (c) => {
    try {
      const ready = await enabled(c.req.raw, c.env ?? {});
      if ("denied" in ready)
        return error(
          403,
          ready.denied === true
            ? "origin_or_recent_auth_required"
            : "workspace_changed",
        );
      const input = aiSettingsRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!input.success) return error(400, "invalid_request");
      return c.json(
        await ready.settings.save(ready.session.tenant, input.data),
      );
    } catch (cause) {
      return failed(cause);
    }
  });
  app.delete("/api/ai/key", async (c) => {
    try {
      const ready = await enabled(c.req.raw, c.env ?? {});
      if ("denied" in ready)
        return error(
          403,
          ready.denied === true
            ? "origin_or_recent_auth_required"
            : "workspace_changed",
        );
      const input = aiKeyDeleteRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!input.success) return error(400, "invalid_request");
      return c.json(
        await ready.settings.deleteKey(ready.session.tenant, input.data),
      );
    } catch (cause) {
      return failed(cause);
    }
  });
  app.post("/api/ai/test", async (c) => {
    try {
      const ready = await enabled(c.req.raw, c.env ?? {});
      if ("denied" in ready)
        return error(
          403,
          ready.denied === true
            ? "origin_or_recent_auth_required"
            : "workspace_changed",
        );
      const input = aiTestRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!input.success) return error(400, "invalid_request");
      return c.json(
        aiTestResponseSchema.parse(
          await ready.probe.test(ready.session, input.data.version),
        ),
      );
    } catch (cause) {
      return failed(cause);
    }
  });
  return app;
}
