import type { AiBindings } from "@invoxim/adapters";
import {
  AiSettingsError,
  aiConfiguration,
  createAiProbeService,
  createAiSettingsService,
  readAuthJson,
} from "@invoxim/adapters";
import {
  aiKeyDeleteRequestSchema,
  aiSettingsRequestSchema,
  aiTestRequestSchema,
  aiTestResponseSchema,
} from "@invoxim/contracts";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  apiError,
  issueMutationToken,
  mapFailure,
  requireTenantContext,
} from "./http/guard";
export function createAiRoutes() {
  const app = new Hono<{ Bindings: AiBindings }>();
  app.use("/api/ai/*", async (context, next) => {
    await next();
    context.res.headers.set("Cache-Control", "no-store");
  });
  function failed(cause: unknown) {
    if (cause instanceof AiSettingsError) {
      const status = {
        UNAUTHORIZED: 401,
        INVALID_REQUEST: 400,
        CONFLICT: 409,
        UNAVAILABLE: 503,
        BUDGET: 429,
      } as const;
      return apiError(status[cause.code], cause.code.toLowerCase());
    }
    return mapFailure(cause);
  }
  async function enabled(c: Context<{ Bindings: AiBindings }>) {
    const ready = await requireTenantContext(c, {
      purpose: "ai-settings",
    });
    if ("response" in ready) return ready;
    const configuration = aiConfiguration(c.env ?? {});
    if (!configuration) throw new AiSettingsError("UNAVAILABLE");
    return {
      ready,
      settings: createAiSettingsService(ready.db, configuration),
      probe: createAiProbeService(ready.db, configuration),
    };
  }
  app.get("/api/ai/settings", async (c) => {
    try {
      const guard = await enabled(c);
      if ("response" in guard) return guard.response;
      return c.json({
        ...(await guard.settings.get(guard.ready.tenant)),
        mutationToken: await issueMutationToken(guard.ready, "ai-settings"),
      });
    } catch (cause) {
      return failed(cause);
    }
  });
  app.put("/api/ai/settings", async (c) => {
    try {
      const guard = await enabled(c);
      if ("response" in guard) return guard.response;
      const input = aiSettingsRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!input.success) return apiError(400, "invalid_request");
      return c.json(await guard.settings.save(guard.ready.tenant, input.data));
    } catch (cause) {
      return failed(cause);
    }
  });
  app.delete("/api/ai/key", async (c) => {
    try {
      const guard = await enabled(c);
      if ("response" in guard) return guard.response;
      const input = aiKeyDeleteRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!input.success) return apiError(400, "invalid_request");
      return c.json(
        await guard.settings.deleteKey(guard.ready.tenant, input.data),
      );
    } catch (cause) {
      return failed(cause);
    }
  });
  app.post("/api/ai/test", async (c) => {
    try {
      const guard = await enabled(c);
      if ("response" in guard) return guard.response;
      const input = aiTestRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!input.success) return apiError(400, "invalid_request");
      return c.json(
        aiTestResponseSchema.parse(
          await guard.probe.test(
            {
              tenant: guard.ready.tenant,
              sessionId: guard.ready.sessionId,
            },
            input.data.version,
          ),
        ),
      );
    } catch (cause) {
      return failed(cause);
    }
  });
  return app;
}
