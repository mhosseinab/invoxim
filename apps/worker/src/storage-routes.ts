import type { DriveBindings } from "@invoxim/adapters";
import {
  AuthRequestError,
  createArchiveConsentRepository,
  createConnectionsViewRepository,
  createDriveAuthorization,
  createDriveConnectionsRepository,
  createDriveService,
  createLoginAuth,
  createProfileService,
  driveConfiguration,
  issueWorkspaceMutationToken,
  loginConfiguration,
  readAuthJson,
  verifyWorkspaceMutationToken,
} from "@invoxim/adapters";
import {
  archiveDisableRequestSchema,
  archiveSettingsViewSchema,
  storageDisconnectRequestSchema,
  storageSettingsResponseSchema,
  storageStartRequestSchema,
  storageStartResponseSchema,
} from "@invoxim/contracts";
import { ArchiveServiceError } from "@invoxim/core";
import { Hono } from "hono";
import { createInvocationDatabase } from "./invocation-database";

const statuses = {
  UNAUTHENTICATED: 401,
  RECENT_AUTH_REQUIRED: 403,
  INVALID_INPUT: 400,
  INVALID_STATE: 400,
  DENIED: 403,
  MISSING_PERMISSION: 403,
  ACCOUNT_MISMATCH: 409,
  MISSING_REFRESH_TOKEN: 409,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RECONNECT_REQUIRED: 409,
  UNAVAILABLE: 503,
} as const;
function error(status: number, code: string) {
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
  if (cause instanceof AuthRequestError) return error(cause.status, cause.code);
  if (cause instanceof ArchiveServiceError)
    return error(statuses[cause.code], cause.code.toLowerCase());
  return error(503, "storage_unavailable");
}
export function createStorageRoutes() {
  const app = new Hono<{ Bindings: DriveBindings }>();
  app.use("/api/*", async (context, next) => {
    await next();
    context.res.headers.set("Cache-Control", "no-store");
  });
  async function ready(request: Request, bindings: DriveBindings) {
    const login = loginConfiguration(bindings);
    if (!login || !bindings.DB)
      throw new ArchiveServiceError("UNAUTHENTICATED");
    const mutation = request.method !== "GET" && request.method !== "HEAD";
    if (
      new URL(request.url).origin !== login.origin ||
      (mutation && request.headers.get("origin") !== login.origin)
    )
      return { response: error(403, "origin_denied") } as const;
    const db = createInvocationDatabase(bindings.DB, 40).db;
    const current = await createProfileService(
      db,
      createLoginAuth(db, login),
      login,
    ).current(request.headers);
    if (!current) throw new ArchiveServiceError("UNAUTHENTICATED");
    const identity = {
      userId: current.tenant.userId,
      sessionId: current.session.id,
    };
    const createdAtMs = current.session.createdAt.getTime();
    if (
      mutation &&
      (!Number.isSafeInteger(createdAtMs) ||
        createdAtMs > Date.now() ||
        Date.now() - createdAtMs > 3600000)
    )
      throw new ArchiveServiceError("RECENT_AUTH_REQUIRED");
    if (
      mutation &&
      !(await verifyWorkspaceMutationToken(
        request.headers.get("X-Workspace-Token") ?? "",
        identity,
        login.secret,
        Date.now,
        "storage-settings",
      ))
    )
      return { response: error(403, "workspace_changed_or_expired") } as const;
    return {
      db,
      login,
      identity,
      session: {
        tenant: current.tenant,
        sessionId: current.session.id,
        createdAtMs,
      },
      connections: createDriveConnectionsRepository(db),
      consent: createArchiveConsentRepository(db),
      configuration: driveConfiguration(bindings),
    };
  }
  app.get("/api/connections", async (c) => {
    try {
      const context = await ready(c.req.raw, c.env ?? {});
      if ("response" in context) return context.response;
      return c.json(
        await createConnectionsViewRepository(context.db).list(
          context.session.tenant,
        ),
      );
    } catch (cause) {
      return failed(cause);
    }
  });
  app.get("/api/storage/settings", async (c) => {
    try {
      const context = await ready(c.req.raw, c.env ?? {});
      if ("response" in context) return context.response;
      const connections = await context.connections.list(
        context.session.tenant,
      );
      const settings = await context.consent.read(context.session.tenant);
      return c.json(
        storageSettingsResponseSchema.parse({
          authorizationAvailable: context.configuration !== null,
          archivingAvailable: false,
          ...connections,
          settings,
          mutationToken: await issueWorkspaceMutationToken(
            context.identity,
            context.login.secret,
            Date.now,
            "storage-settings",
          ),
        }),
      );
    } catch (cause) {
      return failed(cause);
    }
  });
  app.post("/api/connections/storage/google-drive/start", async (c) => {
    try {
      const context = await ready(c.req.raw, c.env ?? {});
      if ("response" in context) return context.response;
      const input = storageStartRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!input.success) return error(400, "invalid_request");
      if (!context.configuration) throw new ArchiveServiceError("UNAVAILABLE");
      const service = createDriveService(
        context.db,
        context.configuration,
        createDriveAuthorization(context.configuration),
      );
      return c.json(
        storageStartResponseSchema.parse(
          await service.start(context.session, input.data.connectionId),
        ),
      );
    } catch (cause) {
      return failed(cause);
    }
  });
  app.delete("/api/connections/storage/:id", async (c) => {
    try {
      const context = await ready(c.req.raw, c.env ?? {});
      if ("response" in context) return context.response;
      const input = storageDisconnectRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!input.success) return error(400, "invalid_request");
      await context.connections.disconnect(
        context.session,
        c.req.param("id"),
        input.data,
      );
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (cause) {
      return failed(cause);
    }
  });
  app.post("/api/storage/settings/disable", async (c) => {
    try {
      const context = await ready(c.req.raw, c.env ?? {});
      if ("response" in context) return context.response;
      const input = archiveDisableRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!input.success) return error(400, "invalid_request");
      return c.json(
        archiveSettingsViewSchema.parse(
          await context.consent.disable(context.session, input.data),
        ),
      );
    } catch (cause) {
      return failed(cause);
    }
  });
  app.get("/api/oauth/storage/google-drive/callback", async (c) => {
    let origin: string | undefined;
    try {
      const context = await ready(c.req.raw, c.env ?? {});
      if ("response" in context) return context.response;
      origin = context.login.origin;
      if (!context.configuration) throw new ArchiveServiceError("UNAVAILABLE");
      const url = new URL(c.req.url),
        keys = [...url.searchParams.keys()];
      const count = (key: string) =>
        keys.filter((value) => value === key).length;
      if (
        url.search.length > 8192 ||
        count("state") !== 1 ||
        count("code") > 1 ||
        count("error") > 1 ||
        (count("error") === 0 && count("code") !== 1) ||
        (count("error") > 0 && count("code") > 0)
      )
        throw new ArchiveServiceError("INVALID_STATE");
      const service = createDriveService(
        context.db,
        context.configuration,
        createDriveAuthorization(context.configuration),
      );
      const connection = await service.complete(context.session, {
        state: url.searchParams.get("state") ?? "",
        ...(url.searchParams.has("code")
          ? { code: url.searchParams.get("code") ?? "" }
          : {}),
        denied: url.searchParams.has("error"),
      });
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${origin}/settings?storage=connected&connectionId=${encodeURIComponent(connection.id)}`,
          "Cache-Control": "no-store",
        },
      });
    } catch (cause) {
      if (!origin) return failed(cause);
      const code =
        cause instanceof ArchiveServiceError &&
        [
          "DENIED",
          "INVALID_STATE",
          "ACCOUNT_MISMATCH",
          "MISSING_PERMISSION",
          "CONFLICT",
        ].includes(cause.code)
          ? cause.code.toLowerCase()
          : "unavailable";
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${origin}/settings?storage=${code}`,
          "Cache-Control": "no-store",
        },
      });
    }
  });
  return app;
}
