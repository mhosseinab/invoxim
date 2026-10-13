import type { AuthBindings } from "@invoxim/adapters";
import {
  AuthRequestError,
  createCorrectionStore,
  createLoginAuth,
  createProfileService,
  issueWorkspaceMutationToken,
  loginConfiguration,
  readAuthJson,
  verifyWorkspaceMutationToken,
} from "@invoxim/adapters";
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
import { Hono } from "hono";
import { createInvocationDatabase } from "./invocation-database";
export interface CorrectionBindings extends AuthBindings {
  CORRECTIONS_ENABLED?: string;
}
function error(
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 503,
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
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
function failure(cause: unknown) {
  if (cause instanceof AuthRequestError) return error(cause.status, cause.code);
  if (cause instanceof CorrectionError) {
    const statuses = {
      INVALID_REQUEST: 400,
      NOT_FOUND: 404,
      CONFLICT: 409,
      TOO_LARGE: 413,
      UNAVAILABLE: 503,
    } as const;
    return error(statuses[cause.code], cause.code.toLowerCase());
  }
  return error(503, "unavailable");
}
export function createCorrectionRoutes() {
  const app = new Hono<{ Bindings: CorrectionBindings }>();
  for (const path of [
    "/api/purchases/*",
    "/api/ledger-entries/*",
    "/api/review/*",
  ])
    app.use(path, async (c, next) => {
      await next();
      c.res.headers.set("Cache-Control", "no-store");
      c.res.headers.set("X-Content-Type-Options", "nosniff");
    });
  async function authorized(request: Request, bindings: CorrectionBindings) {
    const config = loginConfiguration(bindings);
    if (!config || !bindings.DB)
      return { response: error(401, "unauthorized") } as const;
    const mutation = request.method !== "GET";
    if (
      new URL(request.url).origin !== config.origin ||
      (mutation
        ? request.headers.get("Origin") !== config.origin
        : request.headers.has("Origin") &&
          request.headers.get("Origin") !== config.origin)
    )
      return { response: error(403, "origin_required") } as const;
    if (new URL(request.url).search)
      return { response: error(400, "invalid_request") } as const;
    const db = createInvocationDatabase(bindings.DB, 40).db;
    const current = await createProfileService(
      db,
      createLoginAuth(db, config),
      config,
    ).current(request.headers);
    if (!current) return { response: error(401, "unauthorized") } as const;
    if (bindings.CORRECTIONS_ENABLED !== "true")
      return { response: error(503, "unavailable") } as const;
    const identity = {
      userId: current.tenant.userId,
      sessionId: current.session.id,
    };
    if (
      mutation &&
      !(await verifyWorkspaceMutationToken(
        request.headers.get("X-Workspace-Token") ?? "",
        identity,
        config.secret,
      ))
    )
      return { response: error(403, "workspace_changed_or_expired") } as const;
    return {
      service: createCorrectionService(createCorrectionStore(db)),
      session: { tenant: current.tenant, sessionId: current.session.id },
      identity,
      secret: config.secret,
    };
  }
  app.get("/api/purchases/:id/corrections", async (c) => {
    try {
      const ready = await authorized(c.req.raw, c.env ?? {});
      if ("response" in ready) return ready.response;
      const id = correctionIdSchema.safeParse(c.req.param("id"));
      if (!id.success) return error(400, "invalid_request");
      const state = await ready.service.readPurchase(
        ready.session.tenant,
        id.data,
      );
      if (!state) return error(404, "not_found");
      return c.json(
        correctionStateSchema.parse({
          ...state,
          mutationToken: await issueWorkspaceMutationToken(
            ready.identity,
            ready.secret,
          ),
        }),
      );
    } catch (cause) {
      return failure(cause);
    }
  });
  app.get("/api/review/:id/corrections", async (c) => {
    try {
      const ready = await authorized(c.req.raw, c.env ?? {});
      if ("response" in ready) return ready.response;
      const id = correctionIdSchema.safeParse(c.req.param("id"));
      if (!id.success) return error(400, "invalid_request");
      const state = await ready.service.readReview(
        ready.session.tenant,
        id.data,
      );
      if (!state) return error(404, "not_found");
      return c.json(
        correctionReviewSchema.parse({
          ...state,
          mutationToken: await issueWorkspaceMutationToken(
            ready.identity,
            ready.secret,
          ),
        }),
      );
    } catch (cause) {
      return failure(cause);
    }
  });
  async function mutate(
    request: Request,
    bindings: CorrectionBindings,
    build: (body: unknown) => CorrectionCommand | null,
  ) {
    try {
      const ready = await authorized(request, bindings);
      if ("response" in ready) return ready.response;
      const command = build(await readAuthJson(request));
      if (!command) return error(400, "invalid_request");
      return Response.json(
        correctionResultSchema.parse(
          await ready.service.execute(
            ready.session,
            command,
            request.headers.get("Idempotency-Key") ?? "",
          ),
        ),
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    } catch (cause) {
      return failure(cause);
    }
  }
  app.patch("/api/purchases/:id", (c) =>
    mutate(c.req.raw, c.env ?? {}, (body) => {
      const id = correctionIdSchema.safeParse(c.req.param("id")),
        input = purchaseCorrectionRequestSchema.safeParse(body);
      return id.success && input.success
        ? { kind: "purchase-edit", purchaseId: id.data, request: input.data }
        : null;
    }),
  );
  app.patch("/api/ledger-entries/:id", (c) =>
    mutate(c.req.raw, c.env ?? {}, (body) => {
      const id = correctionIdSchema.safeParse(c.req.param("id")),
        input = eventCorrectionRequestSchema.safeParse(body);
      return id.success && input.success
        ? { kind: "event-edit", entryId: id.data, request: input.data }
        : null;
    }),
  );
  for (const kind of ["payment", "refund"] as const)
    app.post(`/api/purchases/:id/${kind}-confirmation`, (c) =>
      mutate(c.req.raw, c.env ?? {}, (body) => {
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
    mutate(c.req.raw, c.env ?? {}, (body) => {
      const id = correctionIdSchema.safeParse(c.req.param("id")),
        input = exclusionRequestSchema.safeParse(body);
      return id.success && input.success
        ? { kind: "exclude", purchaseId: id.data, request: input.data }
        : null;
    }),
  );
  app.post("/api/purchases/:id/restore", (c) =>
    mutate(c.req.raw, c.env ?? {}, (body) => {
      const id = correctionIdSchema.safeParse(c.req.param("id")),
        input = restorationRequestSchema.safeParse(body);
      return id.success && input.success
        ? { kind: "restore", purchaseId: id.data, request: input.data }
        : null;
    }),
  );
  app.post("/api/purchases/merge", (c) =>
    mutate(c.req.raw, c.env ?? {}, (body) => {
      const input = mergeRequestSchema.safeParse(body);
      return input.success ? { kind: "merge", request: input.data } : null;
    }),
  );
  app.post("/api/purchases/:id/unmerge", (c) =>
    mutate(c.req.raw, c.env ?? {}, (body) => {
      const id = correctionIdSchema.safeParse(c.req.param("id")),
        input = unmergeRequestSchema.safeParse(body);
      return id.success && input.success
        ? { kind: "unmerge", purchaseId: id.data, request: input.data }
        : null;
    }),
  );
  app.post("/api/review/:id/resolve", (c) =>
    mutate(c.req.raw, c.env ?? {}, (body) => {
      const id = correctionIdSchema.safeParse(c.req.param("id")),
        input = reviewResolutionRequestSchema.safeParse(body);
      return id.success && input.success
        ? { kind: "review-resolve", reviewId: id.data, request: input.data }
        : null;
    }),
  );
  return app;
}
