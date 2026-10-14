import { z } from "zod";
import type { AppConfig } from "./designs";
import { configSchema } from "./designs";

export const publicConfigSchema = z.strictObject({
  displayName: z.string().min(1).max(80),
  signupMode: z.enum(["allowlist", "public"]),
  demoEnabled: z.boolean(),
  loginEnabled: z.boolean(),
  mailProviders: z.array(z.enum(["gmail", "outlook"])).max(2),
  features: z.strictObject({
    outlook: z.boolean(),
    driveArchive: z.boolean(),
    recurring: z.boolean(),
    useTags: z.boolean(),
  }),
  policyRoutes: z.strictObject({
    privacy: z.literal("/privacy").nullable(),
    terms: z.literal("/terms").nullable(),
  }),
});
/** Readiness is trusted operator/backend input. Missing/unknown values fail closed. */
export interface CapabilityReadiness {
  demo?: boolean;
  login?: boolean;
  publicSignup?: boolean;
  gmail?: boolean;
  outlook?: boolean;
  driveArchive?: boolean;
  recurring?: boolean;
  useTags?: boolean;
  privacy?: boolean;
  terms?: boolean;
}
export function projectPublicConfig(
  input: AppConfig,
  readiness: CapabilityReadiness,
): PublicConfig {
  const config = configSchema.parse(input);
  const outlook = config.product.features.outlook && readiness.outlook === true;
  return publicConfigSchema.parse({
    displayName: config.product.displayName,
    signupMode:
      config.publicSignupEnabled &&
      config.signupMode === "public" &&
      readiness.publicSignup === true
        ? "public"
        : "allowlist",
    demoEnabled: config.product.demoEnabled && readiness.demo === true,
    loginEnabled: readiness.login === true,
    mailProviders: config.mail.providers.filter((provider) =>
      provider === "gmail" ? readiness.gmail === true : outlook,
    ),
    features: {
      outlook,
      driveArchive:
        config.product.features.driveArchive && readiness.driveArchive === true,
      recurring:
        config.product.features.recurring && readiness.recurring === true,
      useTags: config.product.features.useTags && readiness.useTags === true,
    },
    policyRoutes: {
      privacy: readiness.privacy === true ? "/privacy" : null,
      terms: readiness.terms === true ? "/terms" : null,
    },
  });
}
export type PublicConfig = z.infer<typeof publicConfigSchema>;
