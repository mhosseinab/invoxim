import type { OnboardingSession, TenantContext } from "@invoxim/core";

export interface SeedTenantOptions {
  userId: string;
  name?: string;
  authority?: "session" | "job";
  timezone?: string;
  reportingCurrency?: string;
  /** When set, inserts a session row and returns its id/token. */
  sessionId?: string;
  sessionToken?: string;
  /** When set, inserts a mailbox connection owned by the tenant. */
  connectionId?: string;
  provider?: "gmail" | "outlook";
  scopes?: string[];
  schedulingState?: string;
}

export interface SeededTenant {
  tenant: TenantContext;
  userId: string;
  loginEmail: string;
  sessionId: string;
  sessionToken: string;
  connectionId?: string | undefined;
}

/**
 * Seeds the shared tenant rows copied across the worker suites (X3):
 * `user`, `profiles`, and optionally `session` and a mailbox `connections`
 * row. Returns the OnboardingSession shape most fixtures already build.
 */
export async function seedTenant(
  database: D1Database,
  options: SeedTenantOptions,
): Promise<SeededTenant> {
  const {
    userId,
    name = "Synthetic tenant",
    authority = "session",
    timezone = "Europe/Vienna",
    reportingCurrency = "EUR",
    sessionId = `s-${userId}`,
    sessionToken = `synthetic-${userId}`,
    connectionId,
    provider = "gmail",
    scopes = ["https://www.googleapis.com/auth/gmail.readonly"],
    schedulingState = "awaiting_import",
  } = options;
  const loginEmail = `${userId}@example.invalid`;
  await database
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)",
    )
    .bind(userId, name, loginEmail)
    .run();
  await database
    .prepare(
      "INSERT INTO profiles(user_id,timezone,reporting_currency,created_at,updated_at) VALUES(?,?,?,?,?)",
    )
    .bind(userId, timezone, reportingCurrency, 0, 0)
    .run();
  await database
    .prepare(
      "INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,9999999999999,?,0,0,?)",
    )
    .bind(sessionId, sessionToken, userId)
    .run();
  if (connectionId) {
    await database
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes,credential_ciphertext,credential_key_version,credential_version,scheduling_state) VALUES(?,?,'mailbox',?,?,'selected-b@example.invalid',?,'synthetic-encrypted-token',1,1,?)",
      )
      .bind(
        connectionId,
        userId,
        provider,
        connectionId,
        JSON.stringify(scopes),
        schedulingState,
      )
      .run();
  }
  return {
    tenant: { userId, authority } as TenantContext,
    userId,
    loginEmail,
    sessionId,
    sessionToken,
    connectionId,
  };
}

/** OnboardingSession projection of a seeded tenant. */
export function onboardingSession(seeded: SeededTenant): OnboardingSession {
  return {
    tenant: seeded.tenant,
    sessionId: seeded.sessionId,
    loginEmail: seeded.loginEmail,
  };
}

/**
 * Builds the signed `__Secure-better-auth.session_token` cookie (X4).
 * Replaces the HMAC-SHA256 sign + base64url-join copies in 34 suites.
 */
export async function signedSession(
  secret: string,
  token: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  return `__Secure-better-auth.session_token=${encodeURIComponent(
    `${token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`,
  )}`;
}
