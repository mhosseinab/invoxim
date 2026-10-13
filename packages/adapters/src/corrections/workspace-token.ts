import { z } from "zod";

const payloadSchema = z.strictObject({
  version: z.literal(1),
  purpose: z.enum([
    "corrections",
    "ai-settings",
    "lifecycle",
    "storage-settings",
    "fx-reporting",
  ]),
  userId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  expiresAt: z.number().int().nonnegative(),
});
type MutationPurpose = z.infer<typeof payloadSchema>["purpose"];
interface WorkspaceIdentity {
  userId: string;
  sessionId: string;
}
function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("INVALID_TOKEN");
  const bytes = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (v) => v.charCodeAt(0),
  );
  if (encode(bytes) !== value) throw new Error("INVALID_TOKEN");
  return bytes;
}
function key(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function issueWorkspaceMutationToken(
  identity: WorkspaceIdentity,
  secret: string,
  clock: () => number = Date.now,
  purpose: MutationPurpose = "corrections",
) {
  const payload = payloadSchema.parse({
    version: 1,
    purpose,
    ...identity,
    expiresAt: clock() + 600000,
  });
  const body = encode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    new TextEncoder().encode(body),
  );
  return `${body}.${encode(new Uint8Array(signature))}`;
}
export async function verifyWorkspaceMutationToken(
  token: string,
  identity: WorkspaceIdentity,
  secret: string,
  clock: () => number = Date.now,
  purpose: MutationPurpose = "corrections",
) {
  try {
    if (token.length > 2048) return false;
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) return false;
    const payload = payloadSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          decode(body),
        ),
      ),
    );
    if (
      payload.purpose !== purpose ||
      payload.userId !== identity.userId ||
      payload.sessionId !== identity.sessionId ||
      payload.expiresAt <= clock() ||
      payload.expiresAt > clock() + 600000
    )
      return false;
    const valid = await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      decode(signature),
      new TextEncoder().encode(body),
    );
    return valid;
  } catch {
    return false;
  }
}
