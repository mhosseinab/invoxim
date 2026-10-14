import {
  type AuthBindings,
  AuthRequestError,
  createLoginAuth,
  createProfileService,
  issueWorkspaceMutationToken,
  type LoginConfiguration,
  loginConfiguration,
  type ProfileRow,
  verifyWorkspaceMutationToken,
} from "@invoxim/adapters";
import type { TenantContext } from "@invoxim/core";
import type { Context } from "hono";
import { createInvocationDatabase } from "../invocation-database";

// TODO(SEC-1): route workspace-token issue/verify through signToken/verifyToken
// once the shared HMAC domain helper lands. The wire format must stay identical.

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const RECENT_SESSION_MS = 3600000;
/** 503 codes that describe operator configuration, not transient unavailability. */
const PERMANENT_503 = new Set([
  "auth_not_configured",
  "not_implemented",
  "mailbox_api_disabled",
  "processing_not_configured",
  "fx_not_configured",
  "recurring_not_configured",
  "jobs_not_configured",
  "source_unavailable",
]);

export interface ApiErrorOptions {
  retryable?: boolean;
  message?: string;
  requestId?: string;
}

/** One error envelope: code, safe message, requestId, and the single retryable rule. */
export function apiError(
  status: number,
  code: string,
  options: ApiErrorOptions = {},
): Response {
  const retryable =
    options.retryable ?? (status === 503 && !PERMANENT_503.has(code));
  return Response.json(
    {
      error: {
        code,
        message: options.message ?? "Request unavailable",
        requestId: options.requestId ?? crypto.randomUUID(),
        retryable,
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

/** One AuthRequestError → failure mapping, with a shared 503 fallback. */
export function mapFailure(
  cause: unknown,
  fallbackCode = "unavailable",
  options: ApiErrorOptions = {},
): Response {
  if (cause instanceof AuthRequestError)
    return apiError(cause.status, cause.code, options);
  return apiError(503, fallbackCode, options);
}

export interface RequireTenantContextOptions {
  /**
   * State-changing request. Defaults to methods other than GET/HEAD.
   * When true, a valid workspace token is required.
   */
  mutation?: boolean;
  /**
   * Require the one-hour recent-session rule (NaN-safe).
   * Defaults to the resolved `mutation` value.
   */
  recent?: boolean;
  /** Workspace-token purpose checked when `mutation` is true. */
  purpose?:
    | "corrections"
    | "ai-settings"
    | "lifecycle"
    | "storage-settings"
    | "fx-reporting"
    | "recurring";
}

export type RequireOriginResult =
  | { response: Response }
  | { login: LoginConfiguration };

/**
 * One Origin rule (W2, ext#8). The request URL origin must equal the
 * configured origin. Unsafe methods must present a matching `Origin` header.
 * GET/HEAD may omit it, but a mismatched value is rejected.
 */
export function requireOrigin(
  request: Request,
  bindings: AuthBindings,
): RequireOriginResult {
  const login = loginConfiguration(bindings);
  if (!login || !bindings.DB)
    return { response: apiError(401, "unauthorized") };
  const safe = SAFE_METHODS.has(request.method.toUpperCase());
  const urlOrigin = new URL(request.url).origin;
  const headerOrigin = request.headers.get("origin");
  if (
    urlOrigin !== login.origin ||
    (safe
      ? headerOrigin !== null && headerOrigin !== login.origin
      : headerOrigin !== login.origin)
  )
    return { response: apiError(403, "origin_required") };
  return { login };
}

export interface TenantRequestContext {
  db: D1Database;
  login: LoginConfiguration;
  remainingStatements: () => number;
  current: {
    tenant: TenantContext;
    profile: ProfileRow;
    session: { id: string; createdAt: Date; expiresAt: Date };
    user: { id: string; name: string; email: string };
  };
  tenant: TenantContext;
  sessionId: string;
  createdAtMs: number;
  identity: { userId: string; sessionId: string };
  secret: string;
  session: {
    tenant: TenantContext;
    sessionId: string;
    createdAtMs: number;
  };
}

export type RequireTenantContextResult =
  | { response: Response }
  | TenantRequestContext;

/**
 * One Origin rule, one session lookup, one recent-session check, one
 * workspace-token check (W2, W3, D6, ext#8).
 *
 * Origin: the request URL origin must equal the configured origin. Unsafe
 * methods must present a matching `Origin` header. GET/HEAD may omit it, but a
 * mismatched value is rejected (fixes the GET Origin gap on ai/mailbox/storage/auth).
 */
export async function requireTenantContext<B extends AuthBindings>(
  c: Context<{ Bindings: B }>,
  options: RequireTenantContextOptions = {},
): Promise<RequireTenantContextResult> {
  const request = c.req.raw;
  const bindings = (c.env ?? {}) as AuthBindings;
  const origin = requireOrigin(request, bindings);
  if ("response" in origin) return origin;
  const login = origin.login;
  const method = request.method.toUpperCase();
  const safe = SAFE_METHODS.has(method);
  const mutation = options.mutation ?? !safe;
  const recent = options.recent ?? mutation;
  const database = createInvocationDatabase(bindings.DB as D1Database, 40);
  const current = await createProfileService(
    database.db,
    createLoginAuth(database.db, login),
    login,
  ).current(request.headers);
  if (!current) return { response: apiError(401, "unauthorized") };
  const createdAtMs = current.session.createdAt.getTime();
  if (
    recent &&
    (!Number.isSafeInteger(createdAtMs) ||
      createdAtMs > Date.now() ||
      Date.now() - createdAtMs > RECENT_SESSION_MS)
  )
    return { response: apiError(403, "recent_auth_required") };
  const identity = {
    userId: current.tenant.userId,
    sessionId: current.session.id,
  };
  if (
    mutation &&
    !(await verifyWorkspaceMutationToken(
      request.headers.get("X-Workspace-Token") ?? "",
      identity,
      login.secret,
      Date.now,
      options.purpose ?? "corrections",
    ))
  )
    return { response: apiError(403, "workspace_changed_or_expired") };
  return {
    db: database.db,
    login,
    remainingStatements: database.remainingStatements,
    current,
    tenant: current.tenant,
    sessionId: current.session.id,
    createdAtMs,
    identity,
    secret: login.secret,
    session: {
      tenant: current.tenant,
      sessionId: current.session.id,
      createdAtMs,
    },
  };
}

/** Issue a workspace mutation token for a validated tenant context. */
export async function issueMutationToken(
  context: Pick<TenantRequestContext, "identity" | "secret">,
  purpose: NonNullable<RequireTenantContextOptions["purpose"]> = "corrections",
) {
  return issueWorkspaceMutationToken(
    context.identity,
    context.secret,
    Date.now,
    purpose,
  );
}
