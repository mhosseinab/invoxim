import type { AuthBindings } from "@invoxim/adapters";
import { createCorrectionStore, readAuthJson } from "@invoxim/adapters";
import type { CorrectionCommand } from "@invoxim/contracts";
import {
  cashConfirmationRequestSchema,
  correctionIdSchema,
  correctionResultSchema,
  correctionReviewSchema,
  correctionStateSchema,
  eventCorrectionRequestSchema,
  exclusionRequestSchema,
  mergeRequestSchema,
  purchaseCorrectionRequestSchema,
  restorationRequestSchema,
  reviewResolutionRequestSchema,
  unmergeRequestSchema,
} from "@invoxim/contracts";
import { CorrectionError, createCorrectionService } from "@invoxim/core";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  apiError,
  issueMutationToken,
  json,
  mapFailure,
  requireTenantContext,
} from "./http/guard";
export interface CorrectionBindings extends AuthBindings {
  CORRECTIONS_ENABLED?: string;
}
function failure(cause: unknown) {
  if (cause instanceof CorrectionError) {
    const statuses = {
      INVALID_REQUEST: 400,
      NOT_FOUND: 404,
      CONFLICT: 409,
      TOO_LARGE: 413,
      UNAVAILABLE: 503,
    } as const;
    return apiError(statuses[cause.code], cause.code.toLowerCase());
  }
  return mapFailure(cause);
}
export function createCorrectionRoutes() {
  const app = new Hono<{ Bindings: CorrectionBindings }>();
  async function authorized(c: Context<{ Bindings: CorrectionBindings }>) {
    const request = c.req.raw;
    const bindings = c.env ?? {};
    const ready = await requireTenantContext(c, {
      purpose: "corrections",
      // Corrections require a workspace token but not a fresh login.
      recent: false,
    });
    if ("response" in ready) return ready;
    if (new URL(request.url).search)
      return { response: apiError(400, "invalid_request") } as const;
    if (bindings.CORRECTIONS_ENABLED !== "true")
      return { response: apiError(503, "unavailable") } as const;
    return {
      ready,
      service: createCorrectionService(createCorrectionStore(ready.db)),
    };
  }
  app.get("/api/purchases/:id/corrections", async (c) => {
    try {
      const guard = await authorized(c);
      if ("response" in guard) return guard.response;
      const id = correctionIdSchema.safeParse(c.req.param("id"));
      if (!id.success) return apiError(400, "invalid_request");
      const state = await guard.service.readPurchase(
        guard.ready.tenant,
        id.data,
      );
      if (!state) return apiError(404, "not_found");
      return json(
        correctionStateSchema.parse({
          ...state,
          mutationToken: await issueMutationToken(guard.ready, "corrections"),
        }),
      );
    } catch (cause) {
      return failure(cause);
    }
  });
  app.get("/api/review/:id/corrections", async (c) => {
    try {
      const guard = await authorized(c);
      if ("response" in guard) return guard.response;
      const id = correctionIdSchema.safeParse(c.req.param("id"));
      if (!id.success) return apiError(400, "invalid_request");
      const state = await guard.service.readReview(guard.ready.tenant, id.data);
      if (!state) return apiError(404, "not_found");
      return json(
        correctionReviewSchema.parse({
          ...state,
          mutationToken: await issueMutationToken(guard.ready, "corrections"),
        }),
      );
    } catch (cause) {
      return failure(cause);
    }
  });
  async function mutate(
    c: Context<{ Bindings: CorrectionBindings }>,
    build: (body: unknown) => CorrectionCommand | null,
  ) {
    try {
      const guard = await authorized(c);
      if ("response" in guard) return guard.response;
      const command = build(await readAuthJson(c.req.raw));
      if (!command) return apiError(400, "invalid_request");
      return json(
        correctionResultSchema.parse(
          await guard.service.execute(
            guard.ready.session,
            command,
            c.req.raw.headers.get("Idempotency-Key") ?? "",
          ),
        ),
      );
    } catch (cause) {
      return failure(cause);
    }
  }
  app.patch("/api/purchases/:id", (c) =>
    mutate(c, (body) => {
      const id = correctionIdSchema.safeParse(c.req.param("id")),
        input = purchaseCorrectionRequestSchema.safeParse(body);
      return id.success && input.success
        ? { kind: "purchase-edit", purchaseId: id.data, request: input.data }
        : null;
    }),
  );
  app.patch("/api/ledger-entries/:id", (c) =>
    mutate(c, (body) => {
      const id = correctionIdSchema.safeParse(c.req.param("id")),
        input = eventCorrectionRequestSchema.safeParse(body);
      return id.success && input.success
        ? { kind: "event-edit", entryId: id.data, request: input.data }
        : null;
    }),
  );
  for (const kind of ["payment", "refund"] as const)
    app.post(`/api/purchases/:id/${kind}-confirmation`, (c) =>
      mutate(c, (body) => {
        const id = correctionIdSchema.safeParse(c.req.param("id")),
          input = cashConfirmationRequestSchema.safeParse(body);
        return id.success && input.success
          ? {
              kind: "cash-confirm",
              entryKind: kind,
              purchaseId: id.data,
              request: input.data,
            }
          : null;
      }),
    );
  app.post("/api/purchases/:id/exclude", (c) =>
    mutate(c, (body) => {
      const id = correctionIdSchema.safeParse(c.req.param("id")),
        input = exclusionRequestSchema.safeParse(body);
      return id.success && input.success
        ? { kind: "exclude", purchaseId: id.data, request: input.data }
        : null;
    }),
  );
  app.post("/api/purchases/:id/restore", (c) =>
    mutate(c, (body) => {
      const id = correctionIdSchema.safeParse(c.req.param("id")),
        input = restorationRequestSchema.safeParse(body);
      return id.success && input.success
        ? { kind: "restore", purchaseId: id.data, request: input.data }
        : null;
    }),
  );
  app.post("/api/purchases/merge", (c) =>
    mutate(c, (body) => {
      const input = mergeRequestSchema.safeParse(body);
      return input.success ? { kind: "merge", request: input.data } : null;
    }),
  );
  app.post("/api/purchases/:id/unmerge", (c) =>
    mutate(c, (body) => {
      const id = correctionIdSchema.safeParse(c.req.param("id")),
        input = unmergeRequestSchema.safeParse(body);
      return id.success && input.success
        ? { kind: "unmerge", purchaseId: id.data, request: input.data }
        : null;
    }),
  );
  app.post("/api/review/:id/resolve", (c) =>
    mutate(c, (body) => {
      const id = correctionIdSchema.safeParse(c.req.param("id")),
        input = reviewResolutionRequestSchema.safeParse(body);
      return id.success && input.success
        ? { kind: "review-resolve", reviewId: id.data, request: input.data }
        : null;
    }),
  );
  return app;
}
