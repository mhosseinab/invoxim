import type { DriveBindings } from "@invoxim/adapters";
import {
  createArchiveConsentRepository,
  createConnectionsViewRepository,
  createDriveAuthorization,
  createDriveConnectionsRepository,
  createDriveService,
  driveConfiguration,
  readAuthJson,
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
import type { Context } from "hono";
import { Hono } from "hono";
import {
  apiError,
  issueMutationToken,
  json,
  mapFailure,
  requireTenantContext,
} from "./http/guard";

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
function failed(cause: unknown) {
  if (cause instanceof ArchiveServiceError)
    return apiError(statuses[cause.code], cause.code.toLowerCase());
  return mapFailure(cause, "storage_unavailable");
}
export function createStorageRoutes() {
  const app = new Hono<{ Bindings: DriveBindings }>();
  async function ready(c: Context<{ Bindings: DriveBindings }>) {
    const guard = await requireTenantContext(c, {
      purpose: "storage-settings",
    });
    if ("response" in guard) return guard;
    return {
      ...guard,
      connections: createDriveConnectionsRepository(guard.db),
      consent: createArchiveConsentRepository(guard.db),
      configuration: driveConfiguration(c.env ?? {}),
    };
  }
  app.get("/api/connections", async (c) => {
    try {
      const context = await ready(c);
      if ("response" in context) return context.response;
      return json(
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
      const context = await ready(c);
      if ("response" in context) return context.response;
      const connections = await context.connections.list(
        context.session.tenant,
      );
      const settings = await context.consent.read(context.session.tenant);
      return json(
        storageSettingsResponseSchema.parse({
          authorizationAvailable: context.configuration !== null,
          archivingAvailable: false,
          ...connections,
          settings,
          mutationToken: await issueMutationToken(context, "storage-settings"),
        }),
      );
    } catch (cause) {
      return failed(cause);
    }
  });
  app.post("/api/connections/storage/google-drive/start", async (c) => {
    try {
      const context = await ready(c);
      if ("response" in context) return context.response;
      const input = storageStartRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!input.success) return apiError(400, "invalid_request");
      if (!context.configuration) throw new ArchiveServiceError("UNAVAILABLE");
      const service = createDriveService(
        context.db,
        context.configuration,
        createDriveAuthorization(context.configuration),
      );
      return json(
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
      const context = await ready(c);
      if ("response" in context) return context.response;
      const input = storageDisconnectRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!input.success) return apiError(400, "invalid_request");
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
      const context = await ready(c);
      if ("response" in context) return context.response;
      const input = archiveDisableRequestSchema.safeParse(
        await readAuthJson(c.req.raw),
      );
      if (!input.success) return apiError(400, "invalid_request");
      return json(
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
      const context = await ready(c);
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
