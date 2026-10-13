import { env } from "cloudflare:workers";
import type { OnboardingDisclosure } from "@invoxim/contracts";
import type {
  DiscoveryProviderFactory,
  OnboardingSession,
  TenantContext,
} from "@invoxim/core";
import { createOnboardingUsecases } from "@invoxim/core";
import { afterEach, beforeAll } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { aiConfiguration } from "../../../packages/adapters/src/ai/configuration";
import { createOnboardingRepository } from "../../../packages/adapters/src/onboarding/repository";
import { createInvocationDatabase } from "../src/invocation-database";

const fixtureDatabase = env.DB;
const db = fixtureDatabase;

export const now = Date.parse("2026-03-30T12:00:00Z");
beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
});
afterEach(async () => {
  await db.prepare("DROP TRIGGER IF EXISTS qa_abort_onboard").run();
});
export async function owner(
  userId: string,
  connectionId = "mailbox-b",
  scopes = ["https://www.googleapis.com/auth/gmail.readonly"],
): Promise<OnboardingSession> {
  const loginEmail = `${userId}@example.invalid`,
    sessionId = `s-${userId}`;
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)",
    )
    .bind(userId, "QA onboarding", loginEmail)
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,timezone,reporting_currency,created_at,updated_at) VALUES(?,'Europe/Vienna','EUR',0,0)",
    )
    .bind(userId)
    .run();
  await db
    .prepare(
      "INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,9999999999999,?,0,0,?)",
    )
    .bind(sessionId, `synthetic-${userId}`, userId)
    .run();
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scopes,credential_ciphertext,credential_key_version,credential_version,scheduling_state) VALUES(?,?,'mailbox','gmail',?,'selected-b@example.invalid',?,'synthetic-encrypted-token',1,1,'awaiting_import')",
    )
    .bind(connectionId, userId, connectionId, JSON.stringify(scopes))
    .run();
  return {
    tenant: { userId, authority: "session" } as TenantContext,
    sessionId,
    loginEmail,
  };
}
export function configuredAi(
  endpoint = "https://qa-onboard-model.example.invalid/v1/chat/completions",
  notice = "qa-retention-a",
  policySummary = "Synthetic retention policy A",
  privacyUrl = "https://policies.example.invalid/synthetic-a",
) {
  const result = aiConfiguration({
    AI_ENABLED: "true",
    AI_REGISTRY_JSON: JSON.stringify([
      {
        id: "qa-onboard-provider",
        endpoint,
        configVersion: "qa-v1",
        policyVersion: 1,
        noticeRefs: [notice],
        notices: [
          {
            id: notice,
            displayName: "Synthetic processor",
            dataUseSummary:
              "Synthetic operator-approved policy fixture; no live claim.",
            retentionSummary: policySummary,
            privacyUrl,
          },
        ],
        timeoutMs: 100,
        maxInputBytes: 8192,
        maxOutputBytes: 8192,
        maxOutputTokens: 256,
        models: [
          {
            id: "qa-small",
            capabilities: {
              jsonSchema: false,
              jsonObject: false,
              outputLimit: "max_completion_tokens",
              usage: true,
              idempotency: true,
            },
            pricing: {
              version: "qa-price-v1",
              approved: true,
              currency: "USD",
              source: "https://prices.example.invalid/synthetic",
              checkedAt: "2026-03-30T00:00:00Z",
              inputUsdMicrosPerMillion: "100",
              outputUsdMicrosPerMillion: "200",
              otherUsdMicrosPerMillion: "200",
            },
          },
        ],
      },
    ]),
    AI_HOSTED_DESTINATION: "qa-onboard-provider",
    AI_HOSTED_MODEL: "qa-small",
    AI_HOSTED_KEY: "synthetic-hosted-key-never-live",
    CREDENTIAL_KEYRING: JSON.stringify({
      activeVersion: 1,
      keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    }),
    AI_BUDGET_JSON: JSON.stringify({
      dailyDocuments: 10,
      monthlyDocuments: 100,
      dailyUnits: 1000000,
      monthlyUnits: 10000000,
      globalDailyUsdMicros: "100000",
      globalMonthlyUsdMicros: "1000000",
    }),
  });
  if (!result) throw new Error("Synthetic approved AI config invalid");
  return result;
}
export function runtime(
  db?: D1Database,
  ai = configuredAi(),
  clock: () => number = () => now,
  anchor: () => Promise<string> = async () => "12345",
) {
  let opens = 0;
  const providers: DiscoveryProviderFactory = {
    open: async () => {
      opens++;
      return {
        anchor,
        list: async () => {
          throw new Error("Onboarding must not enumerate mail");
        },
        metadata: async () => {
          throw new Error("Onboarding must not fetch content");
        },
        history: async () => {
          throw new Error("Onboarding must not sync history");
        },
      };
    },
  };
  const meter = createInvocationDatabase(db ?? env.DB, 40);
  const repository = createOnboardingRepository(meter.db, {
    ai,
    ready: true,
    signingSecret: "synthetic-onboarding-review-secret-12345",
    mailboxLimit: 3,
    remainingStatements: meter.remainingStatements,
    clock,
  });
  return {
    usecases: createOnboardingUsecases({ repository, providers }),
    opens: () => opens,
    meter,
  };
}
export function startBody(disclosure: OnboardingDisclosure) {
  return {
    connectionId: disclosure.connectionId,
    expectedConnectionGeneration: disclosure.connectionGeneration,
    expectedAiSettingsRevision: disclosure.aiSettingsRevision,
    expectedProfileVersion: disclosure.profileVersion,
    acceptedDisclosureVersion: disclosure.disclosureVersion,
    reviewToken: disclosure.reviewToken,
    startDate: disclosure.startDate,
    endDate: disclosure.endDate,
    timezone: disclosure.timezone,
    reportingCurrency: disclosure.reportingCurrency,
    authorizeHourlySync: true,
  };
}
export const query = {
  connectionId: "mailbox-b",
  startDate: "2025-03-30",
  endDate: "2026-03-29",
  timezone: "Europe/Vienna",
  reportingCurrency: "EUR",
};
