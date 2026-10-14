import type { AuthBindings } from "@invoxim/adapters";
import {
  classifyManualSync,
  createJobStore,
  readAuthJson,
} from "@invoxim/adapters";
import {
  syncQueuedResponseSchema,
  syncRequestSchema,
} from "@invoxim/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { apiError, json, mapFailure, requireTenantContext } from "./http/guard";
import type { JobBindings } from "./job-configuration";
import { jobConfiguration } from "./job-configuration";

const connectionId = z.string().min(1).max(120);

export function createJobRoutes() {
  const app = new Hono<{ Bindings: AuthBindings & JobBindings }>();
  app.post("/api/connections/:id/sync", async (context) => {
    try {
      // Manual sync is a queued read of provider state: no workspace token,
      // no recent-login requirement. W14: ownership lives in the store.
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
      // Ownership/review classification precedes the jobs-config gate so a
      // missing connection is 404 and a non-live one is 409 even when jobs
      // are unconfigured.
      const classified = await classifyManualSync(
        ready.db,
        ready.tenant.userId,
        id.data,
      );
      if (classified === "not-found") return apiError(404, "not_found");
      if (classified === "review-required")
        return apiError(409, "review_required");
      const policy = jobConfiguration(context.env ?? {});
      if (!policy) return apiError(503, "jobs_not_configured");
      const result = await createJobStore(ready.db, { policy }).manualSync(
        ready.tenant,
        id.data,
      );
      if (result.kind === "not-found") return apiError(404, "not_found");
      if (result.kind === "review-required")
        return apiError(409, "review_required");
      if (result.kind === "cooldown") return apiError(429, "sync_cooldown");
      return json(syncQueuedResponseSchema.parse({ jobId: result.jobId }), 202);
    } catch (cause) {
      return mapFailure(cause, "jobs_unavailable");
    }
  });
  return app;
}
