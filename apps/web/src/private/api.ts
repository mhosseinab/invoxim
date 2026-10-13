import { profileViewSchema } from "@invoxim/contracts";

type ProcessingFailureCode =
  | "processing_not_configured"
  | "processing_unavailable";

export class PrivateLoadError extends Error {
  constructor(
    readonly status: number,
    readonly code?: ProcessingFailureCode,
    readonly retryable?: boolean,
  ) {
    super("Private records unavailable");
  }
}
export async function readPrivate<T>(
  path: string,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    signal,
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    if (response.status === 503) {
      const body: unknown = await response.json().catch(() => null);
      if (body && typeof body === "object" && "error" in body) {
        const error = body.error;
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          "retryable" in error
        ) {
          if (
            error.code === "processing_not_configured" &&
            error.retryable === false
          )
            throw new PrivateLoadError(503, error.code, false);
          if (
            error.code === "processing_unavailable" &&
            error.retryable === true
          )
            throw new PrivateLoadError(503, error.code, true);
        }
      }
    }
    throw new PrivateLoadError(response.status);
  }
  const result = schema.safeParse(await response.json());
  if (!result.success) throw new PrivateLoadError(502);
  return result.data;
}

export async function assertPrivateIdentity(
  expectedUserId: string,
  signal: AbortSignal,
) {
  const profile = await readPrivate("/api/me", profileViewSchema, signal);
  if (profile.user.id !== expectedUserId) throw new PrivateLoadError(401);
}
export async function readPrivateForIdentity<T>(
  path: string,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  expectedUserId: string,
  signal: AbortSignal,
): Promise<T> {
  await assertPrivateIdentity(expectedUserId, signal);
  const data = await readPrivate(path, schema, signal);
  await assertPrivateIdentity(expectedUserId, signal);
  return data;
}
