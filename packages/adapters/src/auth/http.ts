import { z } from "zod";
import type { LoginAuth } from "./login";
export class AuthRequestError extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    readonly code: string,
  ) {
    super(code);
  }
}
export async function readAuthJson(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new AuthRequestError(415, "unsupported_media_type");
  if (Number(request.headers.get("content-length") ?? 0) > 4096)
    throw new AuthRequestError(413, "request_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new AuthRequestError(400, "invalid_request");
  const bytes = new Uint8Array(4096);
  let length = 0;
  let dataChunks = 0;
  let emptyChunks = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (item.value.byteLength === 0) {
        if (++emptyChunks > 32)
          throw new AuthRequestError(413, "request_too_large");
        continue;
      }
      if (++dataChunks > 4096 || length + item.value.byteLength > bytes.length)
        throw new AuthRequestError(413, "request_too_large");
      bytes.set(item.value, length);
      length += item.value.byteLength;
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        bytes.subarray(0, length),
      ),
    );
  } catch {
    throw new AuthRequestError(400, "invalid_request");
  }
}
export const signInSchema = z.strictObject({
  provider: z.literal("google"),
  callbackURL: z.literal("/").optional(),
  disableRedirect: z.boolean().optional(),
});
export function isLoginRequest(request: Request): boolean {
  const routes = [
    ["POST", "/api/auth/sign-in/social"],
    ["POST", "/api/auth/sign-out"],
    ["GET", "/api/auth/callback/google"],
    ["GET", "/api/auth/get-session"],
  ];
  const path = new URL(request.url).pathname;
  return routes.some(
    ([method, route]) => request.method === method && path === route,
  );
}
export async function handleLoginRequest(
  auth: LoginAuth,
  request: Request,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/api/auth/sign-in/social" && request.method === "POST") {
    const body = signInSchema.safeParse(await readAuthJson(request));
    if (!body.success) throw new AuthRequestError(400, "invalid_request");
    return auth.handler(
      new Request(request, {
        body: JSON.stringify({
          ...body.data,
          callbackURL: body.data.callbackURL ?? "/home",
          errorCallbackURL: "/",
          newUserCallbackURL: "/onboarding",
        }),
      }),
    );
  }
  if (path === "/api/auth/sign-out" && request.method === "POST") {
    const body = z.strictObject({}).safeParse(await readAuthJson(request));
    if (!body.success) throw new AuthRequestError(400, "invalid_request");
    return auth.handler(new Request(request, { body: "{}" }));
  }
  if (path === "/api/auth/callback/google" && request.method === "GET") {
    const url = new URL(request.url);
    url.searchParams.delete("error_description");
    if (url.searchParams.has("error"))
      url.searchParams.set("error", "access_denied");
    const response = await auth.handleLoginCallback(new Request(url, request));
    const location = response.headers.get("location");
    if (!location) return response;
    const destination = new URL(location, request.url);
    destination.searchParams.delete("error_description");
    if (destination.searchParams.has("error"))
      destination.searchParams.set("error", "sign_in_failed");
    const headers = new Headers(response.headers);
    headers.set("location", destination.toString());
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return new Response(null, { status: 404 });
}
