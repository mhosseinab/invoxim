import type { Page } from "@playwright/test";

/** A request that reached the Playwright API mock. */
export interface MockedRequest {
  path: string;
  query: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A JSON response the mock should fulfill. */
export interface MockedJson {
  status?: number;
  json: unknown;
}

export type ApiHandler = (
  request: MockedRequest,
) => MockedJson | Promise<MockedJson>;

export interface MockApiOptions {
  /** Exact-pathname handlers. First match wins; add later with `handle`. */
  handlers?: Record<string, ApiHandler>;
  /** Used when no handler matches. Defaults to 404 `not_found`. */
  fallback?: ApiHandler;
}

export interface MockApiState {
  requests: MockedRequest[];
  /** Non-GET requests, for POST/PUT/PATCH/DELETE assertions. */
  posts: MockedRequest[];
  handle(path: string, handler: ApiHandler): void;
}

function fulfillJson(
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  result: MockedJson,
) {
  return route.fulfill({
    status: result.status ?? 200,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(result.json),
  });
}

/**
 * Install a typed fake `/api/**` backend on the page.
 *
 * Path handlers are exact pathname matches so contracts-typed fixtures
 * stay the single source of each response body. More specific
 * `page.route` calls registered later still take precedence (Playwright LIFO).
 */
export async function mockApi(
  page: Page,
  options: MockApiOptions = {},
): Promise<MockApiState> {
  const requests: MockedRequest[] = [];
  const posts: MockedRequest[] = [];
  const handlers = new Map(Object.entries(options.handlers ?? {}));
  const fallback: ApiHandler =
    options.fallback ??
    (() => ({ status: 404, json: { error: { code: "not_found" } } }));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const mocked: MockedRequest = {
      path: url.pathname,
      query: url.search,
      method: request.method(),
      body: request.method() === "GET" ? null : request.postDataJSON(),
      headers: request.headers(),
    };
    requests.push(mocked);
    if (mocked.method !== "GET") posts.push(mocked);
    const handler = handlers.get(mocked.path) ?? fallback;
    await fulfillJson(route, await handler(mocked));
  });
  return {
    requests,
    posts,
    handle(path, handler) {
      handlers.set(path, handler);
    },
  };
}

/** Serve a static HTML page for an external origin (e.g. a provider login). */
export async function mockExternalHtml(
  page: Page,
  pattern: string | RegExp,
  html: string,
): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
}
