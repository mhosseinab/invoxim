import { env } from "cloudflare:workers";
import { onboardingDisclosureSchema } from "@invoxim/contracts";
import { createOnboardingUsecases } from "@invoxim/core";
import { afterEach, expect, it, vi } from "vitest";
import { createGmailDiscoveryProviderFactory } from "../../../packages/adapters/src/discovery/provider-factory";
import {
  GMAIL_AUTHORIZATION_SCOPES,
  gmailConfiguration,
} from "../../../packages/adapters/src/mailbox/configuration";
import { createOnboardingImportPreparation } from "../../../packages/adapters/src/onboarding/import-preparation";
import { createOnboardingRepository } from "../../../packages/adapters/src/onboarding/repository";
import { createInvocationDatabase } from "../src/invocation-database";
import { createOnboardingRoutes } from "../src/onboarding-routes";
import { syntheticClassificationBindings } from "./classification-fixture";
import {
  configuredAi,
  now,
  owner,
  query,
  startBody,
} from "./onboarding-qa-fixture";
import { faultingDatabase } from "./support/faults";

afterEach(() => vi.restoreAllMocks());
it.each(["none", "credential", "profile", "route"] as const)(
  "ONBOARD-06 Start pins its own verified Gmail refresh; concurrent replacement=%s",
  async (race) => {
    const replaceCredentials = race === "credential";
    const selection = {
      ...query,
      connectionId: `mailbox-refresh-${race}`,
    };
    const session = await owner(
      `qa-refresh-start-${race}`,
      `mailbox-refresh-${race}`,
      [...GMAIL_AUTHORIZATION_SCOPES],
    );
    const gmailBindings = {
      DB: env.DB,
      AUTH_ENABLED: "true",
      AUTH_ORIGIN: "https://synthetic.example",
      AUTH_SECRET: "synthetic-login-secret-never-live-12345",
      AUTH_GOOGLE_CLIENT_ID: "synthetic-login-client",
      AUTH_GOOGLE_CLIENT_SECRET: "synthetic-login-client-secret",
      AUTH_ALLOWED_EMAILS: JSON.stringify([session.loginEmail]),
      GMAIL_ENABLED: "true",
      GMAIL_CLIENT_ID: "synthetic-mail-client",
      GMAIL_CLIENT_SECRET: "synthetic-mail-client-secret",
      CREDENTIAL_KEYRING: JSON.stringify({
        activeVersion: 1,
        keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      }),
    };
    const parsedConfiguration = gmailConfiguration(gmailBindings);
    if (!parsedConfiguration)
      throw new Error("Synthetic Gmail configuration unavailable");
    const configuration = parsedConfiguration;
    const ciphertext = await configuration.cipher.seal(
      session.tenant,
      { entityId: selection.connectionId, purpose: "mailbox-credentials" },
      {
        accessToken: "synthetic-expired-access",
        refreshToken: "synthetic-refresh-token",
        expiresAt: Date.now() - 60000,
      },
    );
    await env.DB.prepare(
      "UPDATE connections SET credential_ciphertext=? WHERE user_id=? AND id=?",
    )
      .bind(ciphertext, session.tenant.userId, selection.connectionId)
      .run();
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === "https://oauth2.googleapis.com/token")
          return Response.json({
            access_token: "synthetic-fresh-access",
            expires_in: 3600,
            token_type: "Bearer",
            scope: GMAIL_AUTHORIZATION_SCOPES.join(" "),
          });
        if (url === "https://openidconnect.googleapis.com/v1/userinfo")
          return Response.json({
            sub: selection.connectionId,
            email: "selected-b@example.invalid",
            email_verified: true,
          });
        if (
          url ===
          "https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=historyId"
        ) {
          if (replaceCredentials)
            await env.DB.prepare(
              "UPDATE connections SET credential_version=credential_version+1 WHERE user_id=? AND id=?",
            )
              .bind(session.tenant.userId, selection.connectionId)
              .run();
          return Response.json({ historyId: "98765" });
        }
        throw new Error("Unexpected synthetic provider endpoint");
      });
    function invocation(installRace = false) {
      const base =
        race === "profile" && installRace
          ? faultingDatabase(env.DB, [
              {
                match: "SELECT credential_version FROM connections",
                on: "first",
                skip: 1,
                fire: async ({ proceed, native }) => {
                  await native
                    .prepare(
                      "UPDATE profiles SET status='deleting' WHERE user_id=?",
                    )
                    .bind(session.tenant.userId)
                    .run();
                  return proceed();
                },
              },
            ]).db
          : env.DB;
      const meter = createInvocationDatabase(base, 40);
      const repository = createOnboardingRepository(meter.db, {
        ai: configuredAi(),
        ready: true,
        mailboxProviders: ["gmail"],
        signingSecret: "synthetic-onboarding-review-secret-12345",
        mailboxLimit: 3,
        remainingStatements: meter.remainingStatements,
        clock: () => now,
      });
      return {
        meter,
        usecases: createOnboardingUsecases({
          repository,
          preparation: createOnboardingImportPreparation(
            createGmailDiscoveryProviderFactory(meter.db, configuration),
            false,
          ),
        }),
      };
    }
    if (race === "route") {
      const ai = configuredAi();
      const queue: Queue<{ schemaVersion: 1; jobId: string }> = {
        async send() {
          throw new Error("Start must not publish directly");
        },
        async sendBatch() {
          throw new Error("Start must not publish directly");
        },
        async metrics() {
          throw new Error("Start must not query queue metrics");
        },
      };
      const bindings = {
        ...gmailBindings,
        ...syntheticClassificationBindings,
        AI_ENABLED: "true",
        AI_REGISTRY_JSON: JSON.stringify(ai.destinations),
        AI_HOSTED_DESTINATION: "qa-onboard-provider",
        AI_HOSTED_MODEL: "qa-small",
        AI_HOSTED_KEY: "synthetic-hosted-key-never-live",
        AI_BUDGET_JSON: JSON.stringify(ai.budget),
        JOBS: queue,
        JOBS_ENABLED: "true",
        GMAIL_DISCOVERY_ENABLED: "true",
        EXTRACTION_ENABLED: "true",
      };
      const token = `synthetic-${session.tenant.userId}`;
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(configuration.login.secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(token),
      );
      const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
      const app = createOnboardingRoutes();
      const reviewed = await app.fetch(
        new Request(
          `${configuration.login.origin}/api/processing-disclosure?${new URLSearchParams(selection)}`,
          { headers: { Cookie: cookie } },
        ),
        bindings,
      );
      expect(reviewed.status).toBe(200);
      const disclosure = onboardingDisclosureSchema.parse(
        await reviewed.json(),
      );
      expect(disclosure.canStartImport).toBe(true);
      const meter = createInvocationDatabase(env.DB, 40);
      const response = await app.fetch(
        new Request(
          `${configuration.login.origin}/api/onboarding/start-import`,
          {
            method: "POST",
            headers: {
              Cookie: cookie,
              Origin: configuration.login.origin,
              "Content-Type": "application/json",
              "Idempotency-Key": "synthetic-route-refresh-start",
            },
            body: JSON.stringify(startBody(disclosure)),
          },
        ),
        { ...bindings, DB: meter.db },
      );
      expect(response.status).toBe(200);
      expect(meter.executedStatements()).toBeLessThanOrEqual(40);
      expect(transport).toHaveBeenCalledTimes(3);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) n FROM import_runs WHERE user_id=?",
        )
          .bind(session.tenant.userId)
          .first("n"),
      ).toBe(1);
      return;
    }
    const disclosure = await invocation(false).usecases.disclosure(
      session,
      selection,
    );
    expect(disclosure.canStartImport).toBe(true);
    const started = invocation(true);
    if (race === "profile") {
      await expect(
        started.usecases.start(
          session,
          startBody(disclosure),
          "synthetic-refreshed-start",
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(transport).toHaveBeenCalledTimes(2);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) n FROM import_runs WHERE user_id=?",
        )
          .bind(session.tenant.userId)
          .first("n"),
      ).toBe(0);
      return;
    }
    if (replaceCredentials) {
      await expect(
        started.usecases.start(
          session,
          startBody(disclosure),
          "synthetic-refreshed-start",
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(transport).toHaveBeenCalledTimes(3);
      expect(started.meter.executedStatements()).toBeLessThanOrEqual(40);
      expect(
        await env.DB.prepare(
          "SELECT credential_version FROM connections WHERE user_id=? AND id=?",
        )
          .bind(session.tenant.userId, selection.connectionId)
          .first("credential_version"),
      ).toBe(3);
      for (const table of ["processing_consents", "import_runs", "jobs"]) {
        expect(
          await env.DB.prepare(
            `SELECT COUNT(*) n FROM ${table} WHERE user_id=?`,
          )
            .bind(session.tenant.userId)
            .first("n"),
        ).toBe(0);
      }
      return;
    }
    const result = await started.usecases.start(
      session,
      startBody(disclosure),
      "synthetic-refreshed-start",
    );
    expect(result.reused).toBe(false);
    expect(started.meter.executedStatements()).toBeLessThanOrEqual(40);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(
      await env.DB.prepare(
        "SELECT credential_version FROM connections WHERE user_id=? AND id=?",
      )
        .bind(session.tenant.userId, selection.connectionId)
        .first("credential_version"),
    ).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT history_cursor FROM sync_states WHERE user_id=? AND slice_key='live'",
      )
        .bind(session.tenant.userId)
        .first("history_cursor"),
    ).toBe("98765");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM processing_consents WHERE user_id=?",
      )
        .bind(session.tenant.userId)
        .first("n"),
    ).toBe(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM import_runs WHERE user_id=?")
        .bind(session.tenant.userId)
        .first("n"),
    ).toBe(1);
    const replay = invocation(false);
    expect(
      await replay.usecases.start(
        session,
        startBody(disclosure),
        "synthetic-refreshed-start",
      ),
    ).toMatchObject({ importRunId: result.importRunId, reused: true });
    expect(transport).toHaveBeenCalledTimes(3);
  },
);
