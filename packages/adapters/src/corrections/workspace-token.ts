import { z } from "zod";
import { signToken, type TokenDomain, verifyToken } from "../security/token";

/**
 * Historical workspace mutation domain: signs the encoded body and carries
 * no prefix (S2). Kept byte-identical so issued tokens stay valid.
 */
const workspaceDomain: TokenDomain = { prefix: "", signs: "body" };
const payloadSchema = z.strictObject({
  version: z.literal(1),
  purpose: z.enum([
    "corrections",
    "ai-settings",
    "lifecycle",
    "storage-settings",
    "fx-reporting",
    "recurring",
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
  return signToken(workspaceDomain, JSON.stringify(payload), secret);
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
    const json = await verifyToken(workspaceDomain, token, secret);
    if (json === null) return false;
    const payload = payloadSchema.parse(JSON.parse(json));
    return (
      payload.purpose === purpose &&
      payload.userId === identity.userId &&
      payload.sessionId === identity.sessionId &&
      payload.expiresAt > clock() &&
      payload.expiresAt <= clock() + 600000
    );
  } catch {
    return false;
  }
}
