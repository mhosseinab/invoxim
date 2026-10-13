import { profileViewSchema } from "@invoxim/contracts";
export class PrivateLoadError extends Error {
  constructor(readonly status: number) {
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
  if (!response.ok) throw new PrivateLoadError(response.status);
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
