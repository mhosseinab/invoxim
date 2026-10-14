import {
  MAX_PROFILE_VERSION,
  preferencesRequestSchema,
  profileViewSchema,
} from "@invoxim/contracts";
import type { TenantContext } from "@invoxim/core";
import type { LoginConfiguration } from "./configuration";
import { allowedEmailSet, isAllowedEmail } from "./configuration";
import type { LoginAuth } from "./login";
export const preferencesSchema = preferencesRequestSchema;
export interface ProfileRow {
  user_id: string;
  timezone: string;
  reporting_currency: string;
  version: number;
  onboarding_completed_at: number | null;
}
export function createProfileService(
  db: D1Database,
  auth: LoginAuth,
  configuration: LoginConfiguration,
) {
  const allowed = allowedEmailSet(configuration.allowedEmails);
  async function current(headers: Headers) {
    const session = await auth.api.getSession({ headers });
    if (
      !session?.user.emailVerified ||
      !isAllowedEmail(session.user.email, allowed)
    )
      return null;
    const profile = await db
      .prepare(
        "SELECT user_id,timezone,reporting_currency,version,onboarding_completed_at FROM profiles WHERE user_id=? AND status='active'",
      )
      .bind(session.user.id)
      .first<ProfileRow>();
    if (!profile) return null;
    // Sole authority construction: only after the library verifies the signed live session and active owner.
    const tenant = {
      userId: session.user.id,
      authority: "session",
    } as TenantContext;
    return {
      tenant,
      profile,
      session: {
        id: session.session.id,
        createdAt: session.session.createdAt,
        expiresAt: session.session.expiresAt,
      },
      user: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      },
    };
  }
  async function update(tenant: TenantContext, input: unknown) {
    const preferences = preferencesSchema.parse(input);
    const changed = await db
      .prepare(
        "UPDATE profiles SET timezone=?,reporting_currency=?,version=version+1,updated_at=? WHERE user_id=? AND status='active' AND version=? AND version<? RETURNING user_id,timezone,reporting_currency,version,onboarding_completed_at",
      )
      .bind(
        preferences.timezone,
        preferences.reportingCurrency,
        Date.now(),
        tenant.userId,
        preferences.version,
        MAX_PROFILE_VERSION,
      )
      .first<ProfileRow>();
    return changed;
  }
  return { current, update };
}
export function projectProfile(current: {
  profile: ProfileRow;
  user: { id: string; name: string; email: string };
}) {
  return profileViewSchema.parse({
    user: current.user,
    settings: {
      timezone: current.profile.timezone,
      reportingCurrency: current.profile.reporting_currency,
      version: current.profile.version,
    },
    onboarding: { completedAt: current.profile.onboarding_completed_at },
    capabilities: { mailProviders: [], driveArchive: false },
    valuation: { status: "not_configured" },
  });
}
