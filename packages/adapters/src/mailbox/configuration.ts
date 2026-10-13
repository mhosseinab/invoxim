import { z } from "zod";
import type { AuthBindings } from "../auth/configuration";
import { loginConfiguration } from "../auth/configuration";
import { createCredentialCipher } from "../security/cipher";
export interface GmailBindings extends AuthBindings {
  GMAIL_ENABLED?: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  CREDENTIAL_KEYRING?: string;
  MAILBOX_LIMIT?: string;
}
const keyringSchema = z.strictObject({
  activeVersion: z.number().int().positive().max(2147483647),
  keys: z.record(z.string().regex(/^[1-9][0-9]*$/), z.string().min(1).max(100)),
});
export const GMAIL_AUTHORIZATION_SCOPES = Object.freeze([
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
]);
export function gmailConfiguration(bindings: GmailBindings) {
  const login = loginConfiguration(bindings);
  if (!login || bindings.GMAIL_ENABLED !== "true" || !bindings.DB) return null;
  try {
    const client = z
      .strictObject({
        clientId: z.string().min(1).max(300),
        clientSecret: z.string().min(1).max(1024),
        limit: z.number().int().min(1).max(10),
      })
      .parse({
        clientId: bindings.GMAIL_CLIENT_ID,
        clientSecret: bindings.GMAIL_CLIENT_SECRET,
        limit: Number(bindings.MAILBOX_LIMIT ?? "3"),
      });
    const keyring = keyringSchema.parse(
      JSON.parse(bindings.CREDENTIAL_KEYRING ?? "null"),
    );
    return {
      login,
      ...client,
      cipher: createCredentialCipher(keyring),
      callback: `${login.origin}/api/oauth/mailbox/gmail/callback`,
      provider: "gmail" as const,
      oauthProvider: "google" as const,
      scopes: GMAIL_AUTHORIZATION_SCOPES,
    };
  } catch {
    return null;
  }
}
export type GmailConfiguration = NonNullable<
  ReturnType<typeof gmailConfiguration>
>;
