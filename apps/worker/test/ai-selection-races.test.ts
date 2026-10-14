import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { createAiProviderFactory } from "../../../packages/adapters/src/ai/provider-factory";
import { createAiSettingsService } from "../../../packages/adapters/src/ai/settings";
import { selectedOnboardingConfigurationDigest } from "../../../packages/adapters/src/onboarding/configuration";
import { createInvocationDatabase } from "../src/invocation-database";
import { configuredAi, owner } from "./onboarding-qa-fixture";

it.each([
  "revision",
  "key-deleted",
  "credential-version",
  "profile",
  "consent",
  "digest",
] as const)(
  "AI-04 selection %s change during BYOK decrypt cannot send a stale approved request",
  async (change) => {
    const session = await owner(`ai-selection-race-${change}`);
    const configuration = configuredAi();
    const destination = configuration.destinations[0];
    const model = destination?.models[0];
    if (!destination || !model)
      throw new Error("Synthetic destination missing");
    await createAiSettingsService(env.DB, configuration).save(session.tenant, {
      version: 0,
      mode: "byok",
      providerId: destination.id,
      modelId: model.id,
      acceptedPolicyVersion: 1,
      apiKey: "synthetic-key-only-for-tests",
    });
    const digest = await selectedOnboardingConfigurationDigest({
      mode: "byok",
      settingsRevision: 1,
      destination,
      model,
      classification: configuration.classification,
    });
    await env.DB.prepare(
      "INSERT INTO processing_consents(id,user_id,connection_id,disclosure_version,inference_destination,parser_destination,ai_settings_revision,accepted_at,background_authorized,accepted_configuration_digest) VALUES('selected-consent',?,'mailbox-b',1,?,'local',1,0,1,?)",
    )
      .bind(session.tenant.userId, destination.id, digest)
      .run();
    const updates = {
      revision: "UPDATE ai_settings SET revision=revision+1 WHERE user_id=?",
      "key-deleted":
        "UPDATE ai_settings SET encrypted_key=NULL,credential_version=credential_version+1 WHERE user_id=?",
      "credential-version":
        "UPDATE ai_settings SET credential_version=credential_version+1 WHERE user_id=?",
      profile: "UPDATE profiles SET status='deleting' WHERE user_id=?",
      consent: "UPDATE processing_consents SET revoked_at=1 WHERE user_id=?",
      digest:
        "UPDATE processing_consents SET accepted_configuration_digest='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE user_id=?",
    };
    const original = configuration.cipher.open.bind(configuration.cipher);
    const open = vi
      .spyOn(configuration.cipher, "open")
      .mockImplementation(async (...args) => {
        const result = await original(...args);
        await env.DB.prepare(updates[change]).bind(session.tenant.userId).run();
        return result;
      });
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(
        new Error("Stale selected request must not reach HTTP"),
      );
    try {
      const meter = createInvocationDatabase(env.DB, 40);
      const factory = createAiProviderFactory(meter.db, configuration, {
        requireReviewedConfiguration: true,
      });
      const parts = [{ id: "part-0", text: "Synthetic receipt" }];
      try {
        const selected = await factory.open(session.tenant, {
          settingsRevision: 1,
          parts,
          consentId: "selected-consent",
          maxAttempts: 1,
        });
        const response = await selected.extractor.extract(
          parts,
          selected.config,
          { id: "synthetic-attempt", repair: false },
        );
        expect(response).toMatchObject({
          status: "failed",
          reason: "unsupported",
        });
      } catch (cause) {
        expect(cause).toMatchObject({
          code: ["key-deleted", "credential-version", "profile"].includes(
            change,
          )
            ? "UNAVAILABLE"
            : "CONFLICT",
        });
      }
      expect(open).toHaveBeenCalledTimes(1);
      expect(network).not.toHaveBeenCalled();
      expect(meter.executedStatements()).toBeLessThanOrEqual(40);
    } finally {
      open.mockRestore();
      network.mockRestore();
    }
  },
);
