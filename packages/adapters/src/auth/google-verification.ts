import type { BetterAuthPlugin } from "better-auth";
import { verifyGoogleIdToken } from "better-auth/social-providers";
import { z } from "zod";

const identityClaims = z.object({
  sub: z.string().min(1).max(254),
  email: z.email().max(254),
  email_verified: z.literal(true),
  name: z.string().min(1).max(200),
  exp: z.number().int().positive(),
  nonce: z.string().min(1).max(200),
});
/** A fixed extension of the library Google provider; state and PKCE stay library-owned. */
export function verifiedGoogleIdentity(clientId: string): BetterAuthPlugin {
  return {
    id: "verified-google-identity",
    init(context) {
      return {
        context: {
          socialProviders: context.socialProviders.map((provider) => {
            if (provider.id !== "google") return provider;
            return {
              ...provider,
              requiresIdTokenNonce: true,
              async createAuthorizationURL(input) {
                if (!input.idTokenNonce)
                  throw new Error("Missing identity nonce");
                const url = await provider.createAuthorizationURL(input);
                url.searchParams.set("nonce", input.idTokenNonce);
                return url;
              },
              async getUserInfo(tokens) {
                if (!tokens.idToken || !tokens.expectedIdTokenNonce)
                  return null;
                const claims = await verifyGoogleIdToken({
                  token: tokens.idToken,
                  audience: clientId,
                  nonce: tokens.expectedIdTokenNonce,
                });
                const identity = identityClaims.safeParse(claims);
                if (
                  !identity.success ||
                  identity.data.exp <= Math.floor(Date.now() / 1000) ||
                  identity.data.nonce !== tokens.expectedIdTokenNonce
                )
                  return null;
                return provider.getUserInfo(tokens);
              },
            };
          }),
        },
      };
    },
  };
}
