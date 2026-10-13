import type { AuthBindings } from "@invoxim/adapters";
import {
  AuthRequestError,
  createJobStore,
  createLoginAuth,
  createProfileService,
  loginConfiguration,
  readAuthJson,
} from "@invoxim/adapters";
import {
  syncQueuedResponseSchema,
  syncRequestSchema,
} from "@invoxim/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { createInvocationDatabase } from "./invocation-database";
import type { JobBindings } from "./job-configuration";
import { jobConfiguration } from "./job-configuration";

const connectionId = z.string().min(1).max(120);
function failure(
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 503,
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

export function createJobRoutes() {
  const app = new Hono<{ Bindings: AuthBindings & JobBindings }>();
  app.post("/api/connections/:id/sync", async (context) => {
    const bindings = context.env ?? {};
    const login = loginConfiguration(bindings);
    if (!login || !bindings.DB) return failure(401, "unauthenticated");
    if (
      new URL(context.req.url).origin !== login.origin ||
      context.req.header("origin") !== login.origin
    )
      return failure(403, "origin_denied");
    try {
      const db = createInvocationDatabase(bindings.DB, 40).db;
      const profiles = createProfileService(
        db,
        createLoginAuth(db, login),
        login,
      );
      const current = await profiles.current(context.req.raw.headers);
      if (!current) return failure(401, "unauthenticated");
      const id = connectionId.safeParse(context.req.param("id"));
      if (
        !id.success ||
        !syncRequestSchema.safeParse(await readAuthJson(context.req.raw))
          .success
      )
        return failure(400, "invalid_request");
      const owned = await db
        .prepare(
          "SELECT scheduling_state FROM connections WHERE user_id=? AND id=? AND kind='mailbox'",
        )
        .bind(current.tenant.userId, id.data)
        .first<{ scheduling_state: string }>();
      if (!owned) return failure(404, "not_found");
      if (owned.scheduling_state !== "active")
        return failure(409, "review_required");
      const policy = jobConfiguration(bindings);
      if (!policy) return failure(503, "jobs_not_configured");
      const result = await createJobStore(db, { policy }).manualSync(
        current.tenant,
        id.data,
      );
      if (result.kind === "review-required")
        return failure(409, "review_required");
      if (result.kind === "cooldown") return failure(429, "sync_cooldown");
      return context.json(
        syncQueuedResponseSchema.parse({ jobId: result.jobId }),
        202,
      );
    } catch (cause) {
      if (cause instanceof AuthRequestError)
        return failure(cause.status, cause.code);
      return failure(503, "jobs_unavailable");
    }
  });
  return app;
}
