import type { AuthBindings } from "@invoxim/adapters";
import {
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
import {
  apiError,
  json,
  mapFailure,
  requireOrigin,
  requireTenantContext,
} from "./http/guard";
import { createInvocationDatabase } from "./invocation-database";
import { QUERY_LIMIT } from "./job-configuration";
export function createAuthRoutes() {
  const app = new Hono<{ Bindings: AuthBindings }>();
  async function service(bindings: AuthBindings) {
    const configuration = loginConfiguration(bindings);
    if (!configuration || !bindings.DB) return null;
    try {
      const db = createInvocationDatabase(bindings.DB, QUERY_LIMIT).db;
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
    const enabled = await service(context.env ?? {});
    if (!enabled) return apiError(503, "auth_not_configured");
    const origin = requireOrigin(context.req.raw, context.env ?? {});
    if ("response" in origin) return origin.response;
    try {
      if (
        context.req.path === "/api/auth/get-session" &&
        context.req.method === "GET"
      ) {
        const current = await enabled.profiles.current(context.req.raw.headers);
        if (!current) return apiError(401, "unauthorized");
        return json({ user: current.user, session: current.session });
      }
      const response = await handleLoginRequest(enabled.auth, context.req.raw);
      return response.status >= 500
        ? apiError(503, "auth_unavailable")
        : response;
    } catch (cause) {
      return mapFailure(cause, "auth_unavailable");
    }
  });
  app.on(["GET", "PATCH"], "/api/me", async (context) => {
    const ready = await requireTenantContext(context, {
      mutation: false,
      recent: false,
    });
    if ("response" in ready) return ready.response;
    try {
      if (context.req.method !== "PATCH")
        return json(projectProfile(ready.current));
      const input = preferencesSchema.safeParse(
        await readAuthJson(context.req.raw),
      );
      if (!input.success) return apiError(400, "invalid_request");
      // G-40: the update shares the guard's statement meter (one per request).
      const profile = await createProfileService(
        ready.db,
        createLoginAuth(ready.db, ready.login),
        ready.login,
      ).update(ready.tenant, input.data);
      if (!profile) return apiError(409, "version_conflict");
      return json(projectProfile({ ...ready.current, profile }));
    } catch (cause) {
      if (cause instanceof z.ZodError) return apiError(400, "invalid_request");
      return mapFailure(cause, "auth_unavailable");
    }
  });
  app.all("/api/*", async (context) => {
    const ready = await requireTenantContext(context, {
      mutation: false,
      recent: false,
    });
    if ("response" in ready) return ready.response;
    return apiError(503, "not_implemented");
  });
  return app;
}
