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
      // W14: store.manualSync owns the single ownership/eligibility
      // statement. Without jobs configured the same classification still maps
      // a missing mailbox to 404 and a non-live one to 409 before the 503.
      // Manual sync only schedules, never leases digest-gated work (P7).
      const policy = jobConfiguration(context.env ?? {});
      const result = policy
        ? await createJobStore(ready.db, {
            policy,
            processingReview: null,
          }).manualSync(ready.tenant, id.data)
        : await classifyManualSync(ready.db, ready.tenant.userId, id.data);
      if (result.kind === "not-found") return apiError(404, "not_found");
      if (result.kind === "review-required")
        return apiError(409, "review_required");
      if (result.kind === "eligible")
        return apiError(503, "jobs_not_configured");
      if (result.kind === "cooldown") return apiError(429, "sync_cooldown");
      return json(syncQueuedResponseSchema.parse({ jobId: result.jobId }), 202);
    } catch (cause) {
      return mapFailure(cause, "jobs_unavailable");
    }
  });
  return app;
}
