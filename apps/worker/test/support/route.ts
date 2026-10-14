import { createInvocationDatabase } from "../../src/invocation-database";

export interface RouteRequestOptions {
  /** Fetch handler: the composed worker or a sub-app router. */
  fetch: (request: Request, env: never) => Response | Promise<Response>;
  /** Bindings passed to the handler; DB is replaced by the statement meter. */
  bindings: Record<string, unknown>;
  /** Origin used for the request URL and the Origin header. */
  origin: string;
  /** Signed session cookie value from `signedSession()`. */
  cookie: string;
  path: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Statement budget asserted after the call (default 40, G-40). */
  limit?: number;
}

export interface RouteRequestResult {
  response: Response;
  statements: number;
}

/**
 * Fetches a worker route with the shared cookie/origin headers and a D1
 * statement meter (X5). Replaces the per-suite `request()` helpers and the
 * inline `createInvocationDatabase` meter wiring.
 */
export async function routeRequest(
  options: RouteRequestOptions,
): Promise<RouteRequestResult> {
  const {
    fetch: handler,
    bindings,
    origin,
    cookie,
    path,
    method = "GET",
    body,
    headers = {},
    limit = 40,
  } = options;
  const meter = createInvocationDatabase(bindings.DB as D1Database, limit);
  const response = await handler(
    new Request(origin + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined || body === null
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
    { ...bindings, DB: meter.db } as never,
  );
  const statements = meter.executedStatements();
  return { response, statements };
}
