import { z } from "zod";
export const loginConfigurationSchema = z.strictObject({
  origin: z
    .url()
    .max(250)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.origin === value &&
        !url.username &&
        !url.password
      );
    }),
  secret: z.string().min(32).max(1024),
  googleClientId: z.string().min(1).max(300),
  googleClientSecret: z.string().min(1).max(1024),
  allowedEmails: z.array(z.email().max(254)).min(1).max(100),
});
export type LoginConfiguration = z.infer<typeof loginConfigurationSchema>;
export interface AuthBindings {
  DB?: D1Database;
  AUTH_ENABLED?: string;
  AUTH_ORIGIN?: string;
  AUTH_SECRET?: string;
  AUTH_GOOGLE_CLIENT_ID?: string;
  AUTH_GOOGLE_CLIENT_SECRET?: string;
  AUTH_ALLOWED_EMAILS?: string;
}
export function loginConfiguration(
  bindings: AuthBindings,
): LoginConfiguration | null {
  if (bindings.AUTH_ENABLED !== "true" || !bindings.DB) return null;
  try {
    return loginConfigurationSchema.parse({
      origin: bindings.AUTH_ORIGIN,
      secret: bindings.AUTH_SECRET,
      googleClientId: bindings.AUTH_GOOGLE_CLIENT_ID,
      googleClientSecret: bindings.AUTH_GOOGLE_CLIENT_SECRET,
      allowedEmails: JSON.parse(bindings.AUTH_ALLOWED_EMAILS ?? "null"),
    });
  } catch {
    return null;
  }
}
