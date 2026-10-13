import type { AuthBindings } from "@invoxim/adapters";
import {
  AuthRequestError,
  createLoginAuth,
  createProfileService,
  handleLoginRequest,
  isLoginRequest,
  loginConfiguration,
  preferencesSchema,
  projectProfile,
  readAuthJson,
} from "@invoxim/adapters";
import { Hono } from "hono";
import { z } from "zod";
import { createInvocationDatabase } from "./invocation-database";
export function createAuthRoutes() {
  const app = new Hono<{ Bindings: AuthBindings }>();
  app.use("/api/*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  function error(
    status: 401 | 403 | 503 | 400 | 409 | 413 | 415,
    code: string,
  ) {
    return Response.json(
      {
        error: {
          code,
          message: "Request unavailable",
          requestId: crypto.randomUUID(),
          retryable: status === 503 && code === "auth_unavailable",
        },
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
  async function service(request: Request, bindings: AuthBindings) {
    const configuration = loginConfiguration(bindings);
    if (!configuration || !bindings.DB) return null;
    if (new URL(request.url).origin !== configuration.origin)
      return { denied: true } as const;
    if (
      !["GET", "HEAD"].includes(request.method) &&
      request.headers.get("origin") !== configuration.origin
    )
      return { denied: true } as const;
    try {
      const db = createInvocationDatabase(bindings.DB, 40).db;
      const auth = createLoginAuth(db, configuration);
      return {
        auth,
        profiles: createProfileService(db, auth, configuration),
      };
    } catch {
      return null;
    }
  }
  app.all("/api/auth/*", async (context) => {
    if (!isLoginRequest(context.req.raw))
      return new Response(null, { status: 404 });
    const enabled = await service(context.req.raw, context.env ?? {});
    if (!enabled) return error(503, "auth_not_configured");
    if ("denied" in enabled) return error(403, "origin_denied");
    try {
      if (
        context.req.path === "/api/auth/get-session" &&
        context.req.method === "GET"
      ) {
        const current = await enabled.profiles.current(context.req.raw.headers);
        if (!current) return error(401, "unauthenticated");
        return context.json({ user: current.user, session: current.session });
      }
      const response = await handleLoginRequest(enabled.auth, context.req.raw);
      return response.status >= 500 ? error(503, "auth_unavailable") : response;
    } catch (cause) {
      if (cause instanceof AuthRequestError)
        return error(cause.status, cause.code);
      return error(503, "auth_unavailable");
    }
  });
  app.on(["GET", "PATCH"], "/api/me", async (context) => {
    const enabled = await service(context.req.raw, context.env ?? {});
    if (!enabled) return error(401, "unauthenticated");
    if ("denied" in enabled) return error(403, "origin_denied");
    try {
      const current = await enabled.profiles.current(context.req.raw.headers);
      if (!current) return error(401, "unauthenticated");
      if (context.req.method !== "PATCH")
        return context.json(projectProfile(current));
      const input = preferencesSchema.safeParse(
        await readAuthJson(context.req.raw),
      );
      if (!input.success) return error(400, "invalid_request");
      const profile = await enabled.profiles.update(current.tenant, input.data);
      if (!profile) return error(409, "version_conflict");
      return context.json(projectProfile({ ...current, profile }));
    } catch (cause) {
      if (cause instanceof AuthRequestError)
        return error(cause.status, cause.code);
      if (cause instanceof z.ZodError) return error(400, "invalid_request");
      return error(503, "auth_unavailable");
    }
  });
  app.all("/api/*", async (context) => {
    const enabled = await service(context.req.raw, context.env ?? {});
    if (!enabled) return error(401, "unauthenticated");
    if ("denied" in enabled) return error(403, "origin_denied");
    try {
      const current = await enabled.profiles.current(context.req.raw.headers);
      if (!current) return error(401, "unauthenticated");
      return error(503, "not_implemented");
    } catch {
      return error(503, "auth_unavailable");
    }
  });
  return app;
}
