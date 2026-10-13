import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../auth-schema";
import type { LoginConfiguration } from "./configuration";
import { loginConfigurationSchema } from "./configuration";
import { verifiedGoogleIdentity } from "./google-verification";
import { protectedLoginState } from "./state-adapter";
export function createLoginAuth(db: D1Database, input: LoginConfiguration) {
  const configuration = loginConfigurationSchema.parse(input);
  const allowed = new Set(
    configuration.allowedEmails.map((email) => email.toLowerCase()),
  );
  const discardedTokens = {
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scope: null,
  };
  const newlyCreatedUsers = new Set<string>();
  let callbackStarted = false;
  let callbackActive = false;
  const auth = betterAuth({
    secret: configuration.secret,
    baseURL: configuration.origin,
    basePath: "/api/auth",
    trustedOrigins: [configuration.origin],
    database: drizzleAdapter(drizzle(db, { schema }), {
      provider: "sqlite",
      schema,
    }),
    logger: { disabled: true },
    onAPIError: { errorURL: `${configuration.origin}/` },
    plugins: [
      verifiedGoogleIdentity(configuration.googleClientId),
      protectedLoginState(configuration.secret, configuration.origin, (id) => {
        if (callbackActive) newlyCreatedUsers.add(id);
      }),
    ],
    verification: { storeIdentifier: "hashed" },
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: configuration.googleClientId,
        clientSecret: configuration.googleClientSecret,
        disableDefaultScope: true,
        scope: ["openid", "email", "profile"],
        includeGrantedScopes: false,
        accessType: "online",
        prompt: "select_account",
        disableIdTokenSignIn: true,
      },
    },
    user: {
      validateUserInfo: ({ user, source }) => {
        if (
          source.oauth?.providerId !== "google" ||
          user.emailVerified !== true ||
          typeof user.email !== "string" ||
          !allowed.has(user.email.toLowerCase())
        )
          return {
            error: "sign_in_denied",
            errorDescription: "Sign-in unavailable",
          };
      },
    },
    account: {
      accountLinking: { enabled: false, disableImplicitLinking: true },
      storeAccountCookie: false,
      updateAccountOnSignIn: false,
      storeStateStrategy: "database",
      skipStateCookieCheck: false,
    },
    session: {
      cookieCache: { enabled: false },
      expiresIn: 60 * 60 * 24 * 7,
      freshAge: 60 * 60,
    },
    advanced: {
      useSecureCookies: true,
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      },
      ipAddress: { disableIpTracking: true },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!user.emailVerified || !allowed.has(user.email.toLowerCase()))
              throw new APIError("FORBIDDEN", {
                message: "Sign-in unavailable",
              });
            return { data: user };
          },
          after: async (user) => {
            try {
              await db
                .prepare(
                  "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
                )
                .bind(user.id, Date.now(), Date.now())
                .run();
            } catch {
              await db
                .prepare(
                  'DELETE FROM "user" WHERE id=? AND NOT EXISTS(SELECT 1 FROM profiles WHERE user_id=?)',
                )
                .bind(user.id, user.id)
                .run();
              throw new APIError("INTERNAL_SERVER_ERROR", {
                message: "Sign-in unavailable",
              });
            }
          },
        },
      },
      account: {
        create: {
          before: async (account) => ({
            data: { ...account, ...discardedTokens },
          }),
        },
        update: {
          before: async (account) => ({
            data: { ...account, ...discardedTokens },
          }),
        },
      },
      session: {
        create: {
          before: async (session) => {
            const owner = await db
              .prepare(
                'SELECT u.email,u.emailVerified,p.status FROM "user" u JOIN profiles p ON p.user_id=u.id WHERE u.id=?',
              )
              .bind(session.userId)
              .first<{
                email: string;
                emailVerified: number;
                status: string;
              }>();
            if (
              owner?.emailVerified !== 1 ||
              !allowed.has(owner.email.toLowerCase()) ||
              owner.status !== "active"
            )
              throw new APIError("FORBIDDEN", {
                message: "Sign-in unavailable",
              });
            return { data: { ...session, ipAddress: null, userAgent: null } };
          },
        },
      },
    },
  });
  // The HTTP composition creates a fresh instance for each request. This one-shot
  // callback method prevents tracking from being shared by concurrent callbacks.
  async function handleLoginCallback(request: Request): Promise<Response> {
    if (callbackStarted)
      throw new APIError("SERVICE_UNAVAILABLE", {
        message: "Sign-in unavailable",
      });
    callbackStarted = true;
    callbackActive = true;
    try {
      return await auth.handler(request);
    } finally {
      callbackActive = false;
      for (const id of newlyCreatedUsers)
        await db
          .prepare(
            'DELETE FROM "user" WHERE id=? AND NOT EXISTS(SELECT 1 FROM "account" WHERE userId=?) AND NOT EXISTS(SELECT 1 FROM "session" WHERE userId=?)',
          )
          .bind(id, id, id)
          .run();
      newlyCreatedUsers.clear();
    }
  }
  return Object.assign(auth, { handleLoginCallback });
}
export type LoginAuth = ReturnType<typeof createLoginAuth>;
