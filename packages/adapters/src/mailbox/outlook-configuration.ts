import { z } from "zod";
import type { AuthBindings } from "../auth/configuration";
import { loginConfiguration } from "../auth/configuration";
import { createCredentialCipher } from "../security/cipher";

export interface OutlookBindings extends AuthBindings {
  OUTLOOK_ENABLED?: string;
  OUTLOOK_CLIENT_ID?: string;
  OUTLOOK_CLIENT_SECRET?: string;
  OUTLOOK_AUTHORITY?: string;
  CREDENTIAL_KEYRING?: string;
  MAILBOX_LIMIT?: string;
}
export const outlookAuthoritySchema = z.union([
  z.enum(["common", "consumers", "organizations"]),
  z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .transform((value) => value.toLowerCase()),
]);
export const OUTLOOK_AUTHORIZATION_SCOPES = Object.freeze([
  "openid",
  "profile",
  "email",
  "offline_access",
  "https://graph.microsoft.com/Mail.Read",
]);
const keyringSchema = z.strictObject({
  activeVersion: z.number().int().positive().max(2147483647),
  keys: z.record(z.string().regex(/^[1-9][0-9]*$/), z.string().min(1).max(100)),
});
export function outlookConfiguration(bindings: OutlookBindings) {
  const login = loginConfiguration(bindings);
  if (!login || bindings.OUTLOOK_ENABLED !== "true" || !bindings.DB)
    return null;
  try {
    const client = z
      .strictObject({
        clientId: z
          .string()
          .regex(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          ),
        clientSecret: z
          .string()
          .min(1)
          .max(1024)
          .regex(/^[\x21-\x7e]+$/),
        authority: outlookAuthoritySchema,
        limit: z.number().int().min(1).max(10),
      })
      .parse({
        clientId: bindings.OUTLOOK_CLIENT_ID,
        clientSecret: bindings.OUTLOOK_CLIENT_SECRET,
        authority: bindings.OUTLOOK_AUTHORITY ?? "common",
        limit: Number(bindings.MAILBOX_LIMIT ?? "3"),
      });
    const keyring = keyringSchema.parse(
      JSON.parse(bindings.CREDENTIAL_KEYRING ?? "null"),
    );
    return {
      login,
      ...client,
      provider: "outlook" as const,
      oauthProvider: "microsoft" as const,
      callback: `${login.origin}/api/oauth/mailbox/outlook/callback`,
      cipher: createCredentialCipher(keyring),
      scopes: OUTLOOK_AUTHORIZATION_SCOPES,
    };
  } catch {
    return null;
  }
}
export type OutlookConfiguration = NonNullable<
  ReturnType<typeof outlookConfiguration>
>;
