/**
 * Shared synthetic fetch plumbing for tests. Pure functions only — callers
 * install the returned handler with their own `vi.spyOn(globalThis, "fetch")`.
 */
export type FetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

export function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

export function requestMethod(
  input: RequestInfo | URL,
  init?: RequestInit,
): string {
  return (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
}

export interface FetchRoute {
  readonly match: (url: string, method: string) => boolean;
  readonly respond: (
    url: string,
    init?: RequestInit,
  ) => Response | Promise<Response>;
}

export function urlRoute(
  url: string,
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
  method?: string,
): FetchRoute {
  return {
    match: (actualUrl, actualMethod) =>
      actualUrl === url &&
      (method === undefined || actualMethod === method.toUpperCase()),
    respond,
  };
}

/**
 * Routes synthetic fetch traffic by exact URL (and optional method).
 * Unmatched requests throw so tests fail loudly on unexpected destinations.
 * Optionally records every URL into `calls`.
 */
export function createRoutedFetch(
  routes: readonly FetchRoute[],
  options: { calls?: string[]; onUnexpected?: (url: string) => never } = {},
): FetchHandler {
  return async (input, init) => {
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    options.calls?.push(url);
    for (const route of routes) {
      if (route.match(url, method)) return route.respond(url, init);
    }
    if (options.onUnexpected) return options.onUnexpected(url);
    throw new Error(`Unexpected synthetic fetch destination: ${url}`);
  };
}

/** Decode a Vite `?inline` asset data URL into exact bytes. */
export function bytesFromInlineAsset(asset: string): Uint8Array {
  if (!/^data:[^,]*;base64,/.test(asset)) {
    throw new Error("Fixture asset must be imported as its exact base64 bytes");
  }
  return Uint8Array.from(atob(asset.slice(asset.indexOf(",") + 1)), (value) =>
    value.charCodeAt(0),
  );
}
