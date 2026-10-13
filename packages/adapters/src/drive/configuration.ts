import { z } from "zod";
import type { AuthBindings } from "../auth/configuration";
import { loginConfiguration } from "../auth/configuration";
import { createCredentialCipher } from "../security/cipher";
export interface DriveBindings extends AuthBindings {
  DRIVE_ENABLED?: string;
  DRIVE_CLIENT_ID?: string;
  DRIVE_CLIENT_SECRET?: string;
  CREDENTIAL_KEYRING?: string;
}
export const DRIVE_AUTHORIZATION_SCOPES = Object.freeze([
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.file",
]);
export const driveClientSchema = z.object({
  clientId: z
    .string()
    .max(300)
    .regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/),
  clientSecret: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[\x21-\x7e]+$/),
  callback: z
    .url()
    .max(500)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/api/oauth/storage/google-drive/callback"
      );
    }),
});
const keyringSchema = z.strictObject({
  activeVersion: z.number().int().positive().max(2147483647),
  keys: z.record(z.string().regex(/^[1-9][0-9]*$/), z.string().min(1).max(100)),
});
export function driveConfiguration(bindings: DriveBindings) {
  const login = loginConfiguration(bindings);
  if (!login || !bindings.DB || bindings.DRIVE_ENABLED !== "true") return null;
  try {
    const client = driveClientSchema.parse({
      clientId: bindings.DRIVE_CLIENT_ID,
      clientSecret: bindings.DRIVE_CLIENT_SECRET,
      callback: `${login.origin}/api/oauth/storage/google-drive/callback`,
    });
    const keyring = keyringSchema.parse(
      JSON.parse(bindings.CREDENTIAL_KEYRING ?? "null"),
    );
    return {
      login,
      ...client,
      cipher: createCredentialCipher(keyring),
      provider: "google-drive" as const,
      oauthProvider: "google" as const,
      scopes: DRIVE_AUTHORIZATION_SCOPES,
    };
  } catch {
    return null;
  }
}
export type DriveConfiguration = NonNullable<
  ReturnType<typeof driveConfiguration>
>;
