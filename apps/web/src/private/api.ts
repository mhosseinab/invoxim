import { profileViewSchema, publicConfigSchema } from "@invoxim/contracts";

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string = "request_unavailable",
    readonly retryable?: boolean,
  ) {
    super("Request unavailable");
  }
}

export class PrivateLoadError extends RequestError {}

const safeCodes = new Set([
  "processing_review_required",
  "processing_not_configured",
  "processing_unavailable",
  "allowance_unavailable",
  "mailbox_reconnect_required",
  "mailbox_api_disabled",
  "conflict",
  "unauthorized",
  "origin_required",
  "recent_auth_required",
  "account_not_allowed",
  "missing_permission",
  "denied",
  "account_mismatch",
  "limit_reached",
]);

type JsonSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

export type RequestJsonInit = {
  signal: AbortSignal;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | undefined;
  body?: unknown;
  idempotencyKey?: string | undefined;
  workspaceToken?: string | undefined;
};

export async function requestJson<T>(
  path: string,
  schema: JsonSchema<T>,
  init: RequestJsonInit,
): Promise<T> {
  const write = init.method !== undefined && init.method !== "GET";
  const response = await fetch(path, {
    method: init.method ?? "GET",
    signal: init.signal,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(write ? { "Content-Type": "application/json" } : {}),
      ...(init.idempotencyKey
        ? { "Idempotency-Key": init.idempotencyKey }
        : {}),
      ...(init.workspaceToken
        ? { "X-Workspace-Token": init.workspaceToken }
        : {}),
    },
    ...(write ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!response.ok) {
    let code = "request_unavailable";
    let retryable: boolean | undefined;
    try {
      const value: unknown = await response.json();
      if (value && typeof value === "object" && "error" in value) {
        const error = (value as { error: unknown }).error;
        if (error && typeof error === "object") {
          const record = error as { code?: unknown; retryable?: unknown };
          if (typeof record.code === "string" && safeCodes.has(record.code))
            code = record.code;
          if (typeof record.retryable === "boolean")
            retryable = record.retryable;
        }
      }
    } catch {
      /* The response body is not product copy. */
    }
    throw new RequestError(response.status, code, retryable);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new RequestError(502);
  }
  const result = schema.safeParse(json);
  if (!result.success) throw new RequestError(502);
  return result.data;
}

export async function readPrivate<T>(
  path: string,
  schema: JsonSchema<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await requestJson(path, schema, { signal });
  } catch (error) {
    if (error instanceof RequestError)
      throw new PrivateLoadError(error.status, error.code, error.retryable);
    throw error;
  }
}

export async function assertPrivateIdentity(
  expectedUserId: string,
  signal: AbortSignal,
) {
  const profile = await readPrivate("/api/me", profileViewSchema, signal);
  if (profile.user.id !== expectedUserId) throw new PrivateLoadError(401);
}
export function identityFailure(value: unknown): boolean {
  const status =
    typeof value === "number"
      ? value
      : value instanceof Error && "status" in value
        ? (value as Error & { status: unknown }).status
        : undefined;
  return status === 401 || status === 403;
}
export async function readPrivateForIdentity<T>(
  path: string,
  schema: JsonSchema<T>,
  expectedUserId: string,
  signal: AbortSignal,
): Promise<T> {
  await assertPrivateIdentity(expectedUserId, signal);
  const data = await readPrivate(path, schema, signal);
  await assertPrivateIdentity(expectedUserId, signal);
  return data;
}

export async function readLoginEnabled(signal: AbortSignal): Promise<boolean> {
  try {
    const config = await readPrivate(
      "/api/public-config",
      publicConfigSchema,
      signal,
    );
    return config.loginEnabled;
  } catch {
    return false;
  }
}
