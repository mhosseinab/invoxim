import type { AuthBindings } from "@invoxim/adapters";
import { createJobStore, readAuthJson } from "@invoxim/adapters";
import {
  syncQueuedResponseSchema,
  syncRequestSchema,
} from "@invoxim/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { apiError, mapFailure, requireTenantContext } from "./http/guard";
import type { JobBindings } from "./job-configuration";
import { jobConfiguration } from "./job-configuration";

const connectionId = z.string().min(1).max(120);

export function createJobRoutes() {
  const app = new Hono<{ Bindings: AuthBindings & JobBindings }>();
  app.post("/api/connections/:id/sync", async (context) => {
    try {
      // Manual sync is a queued read of provider state: no workspace token,
      // no recent-login requirement. W14 ownership SQL stays until WRK-6.
      const ready = await requireTenantContext(context, {
        mutation: false,
        recent: false,
      });
      if ("response" in ready) return ready.response;
      const id = connectionId.safeParse(context.req.param("id"));
      if (
        !id.success ||
        !syncRequestSchema.safeParse(await readAuthJson(context.req.raw))
          .success
      )
        return apiError(400, "invalid_request");
      const owned = await ready.db
        .prepare(
          "SELECT scheduling_state FROM connections WHERE user_id=? AND id=? AND kind='mailbox'",
        )
        .bind(ready.tenant.userId, id.data)
        .first<{ scheduling_state: string }>();
      if (!owned) return apiError(404, "not_found");
      if (owned.scheduling_state !== "active")
        return apiError(409, "review_required");
      const policy = jobConfiguration(context.env ?? {});
      if (!policy) return apiError(503, "jobs_not_configured");
      const result = await createJobStore(ready.db, { policy }).manualSync(
        ready.tenant,
        id.data,
      );
      if (result.kind === "review-required")
        return apiError(409, "review_required");
      if (result.kind === "cooldown") return apiError(429, "sync_cooldown");
      return context.json(
        syncQueuedResponseSchema.parse({ jobId: result.jobId }),
        202,
      );
    } catch (cause) {
      return mapFailure(cause, "jobs_unavailable");
    }
  });
  return app;
}
