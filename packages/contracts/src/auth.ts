import { z } from "zod";
import { supportedCurrency, validTimezone } from "./primitives";

const timezone = z.string().min(1).max(80).refine(validTimezone);
const reportingCurrency = supportedCurrency;
export const MAX_PROFILE_VERSION = 2_147_483_646;
const version = z.number().int().min(1).max(MAX_PROFILE_VERSION);

export const preferencesRequestSchema = z.strictObject({
  version,
  timezone,
  reportingCurrency,
});

/** Public authenticated projection: credentials/session authority stay internal. */
export const profileViewSchema = z.strictObject({
  user: z.strictObject({
    id: z.string().min(1).max(256),
    name: z.string().max(200),
    email: z.email().max(254),
  }),
  settings: z.strictObject({ timezone, reportingCurrency, version }),
  onboarding: z.strictObject({
    completedAt: z.number().int().min(0).nullable(),
  }),
  capabilities: z.strictObject({
    mailProviders: z.array(z.enum(["gmail", "outlook"])).max(2),
    driveArchive: z.boolean(),
  }),
  valuation: z.strictObject({ status: z.literal("not_configured") }),
});

export type PreferencesRequest = z.infer<typeof preferencesRequestSchema>;
export type ProfileView = z.infer<typeof profileViewSchema>;
