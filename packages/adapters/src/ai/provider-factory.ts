import { EXTRACTION_PROMPT_VERSION } from "@invoxim/contracts";
import type {
  AiTextPart,
  ApprovedAiConfig,
  InvoiceExtractor,
  TenantContext,
} from "@invoxim/core";
import { validateExtraction } from "@invoxim/core";
import { selectedOnboardingConfigurationDigest } from "../onboarding/configuration";
import { createCredentialVault } from "../security/vault";
import type { AiPriceSnapshot, AiProbeResult } from "./budget";
import { createAiProbeUsageStore } from "./budget";
import type { AiConfiguration } from "./configuration";
import {
  computeAiFingerprint,
  selectedAiConfigurationDigest,
} from "./configuration";
import { chatReservationUnits, createChatCompletionsExtractor } from "./http";
import { AiSettingsError, createAiSettingsService } from "./settings";
import { traceChatExtractor } from "./tracing";

export function createAiProviderFactory(
  db: D1Database,
  configuration: AiConfiguration,
  options: { requireReviewedConfiguration?: boolean } = {},
) {
  const settings = createAiSettingsService(db, configuration);
  const vault = createCredentialVault(db, configuration.cipher);
  async function resolve(
    tenant: TenantContext,
    input: {
      settingsRevision: number;
      parts: readonly AiTextPart[];
      consentId: string;
      maxAttempts?: 1 | 2;
    },
    probe: boolean,
  ) {
    const row = await settings.current(tenant);
    if (
      !row ||
      row.revision !== input.settingsRevision ||
      row.status !== "active" ||
      !row.mode
    )
      throw new AiSettingsError("CONFLICT");
    const destination = configuration.destinations.find(
      (entry) => entry.id === row.provider_id,
    );
    const model = destination?.models.find(
      (entry) => entry.id === row.model_id,
    );
    if (
      !destination ||
      !model ||
      destination.configVersion !== row.config_version ||
      destination.policyVersion !== row.consent_version
    )
      throw new AiSettingsError("CONFLICT");
    const acceptedConfigurationDigest =
      options.requireReviewedConfiguration && !probe
        ? await selectedOnboardingConfigurationDigest({
            mode: row.mode,
            settingsRevision: row.revision,
            destination,
            model,
            classification: configuration.classification,
          })
        : undefined;
    if (
      acceptedConfigurationDigest &&
      !destination.noticeRefs.every((ref) =>
        destination.notices?.some((notice) => notice.id === ref),
      )
    )
      throw new AiSettingsError("CONFLICT");
    let key: string;
    if (row.mode === "hosted") {
      const hosted = configuration.hosted;
      if (
        !hosted ||
        hosted.destinationId !== destination.id ||
        hosted.modelId !== model.id
      )
        throw new AiSettingsError("UNAVAILABLE");
      key = hosted.key;
    } else {
      const credential = await vault.read(
        tenant,
        { kind: "byok", id: "primary", generation: row.generation },
        row.credential_version,
      );
      if (!credential || !("key" in credential.secret))
        throw new AiSettingsError("UNAVAILABLE");
      key = credential.secret.key;
    }
    async function verifyConsentAgainstRow(latest: typeof row) {
      if (
        !latest ||
        latest.revision !== row?.revision ||
        latest.generation !== row.generation ||
        latest.credential_version !== row.credential_version ||
        latest.status !== "active" ||
        latest.mode !== row.mode ||
        latest.provider_id !== row.provider_id ||
        latest.model_id !== row.model_id ||
        latest.config_version !== row.config_version ||
        latest.consent_version !== row.consent_version
      )
        return false;
      if (probe) return true;
      return Boolean(
        await db
          .prepare(
            "SELECT id FROM processing_consents WHERE user_id=? AND id=? AND ai_settings_revision=? AND inference_destination=? AND revoked_at IS NULL AND background_authorized=1 AND accepted_at<=?" +
              (acceptedConfigurationDigest
                ? " AND accepted_configuration_digest=?"
                : ""),
          )
          .bind(
            tenant.userId,
            input.consentId,
            row.revision,
            destination?.id ?? "",
            Date.now(),
            ...(acceptedConfigurationDigest
              ? [acceptedConfigurationDigest]
              : []),
          )
          .first(),
      );
    }
    /** Consent-only check against the initially read row (no intervening await yet). */
    async function verifyInitialSelection() {
      return verifyConsentAgainstRow(row);
    }
    /** Full recheck: reload settings and consent after every intervening await. */
    async function recheckSettingsAndConsent() {
      return verifyConsentAgainstRow(await settings.current(tenant));
    }
    if (!(await verifyInitialSelection())) throw new AiSettingsError("CONFLICT");
    const configurationDigest = await selectedAiConfigurationDigest(
      destination,
      model,
    );
    const fingerprint = await computeAiFingerprint({
      mode: row.mode,
      configurationDigest,
      settingsRevision: row.revision,
      generation: row.generation,
      credentialVersion: row.credential_version,
      policyVersion: row.consent_version,
      consentId: input.consentId,
    });
    const config: ApprovedAiConfig = Object.freeze({
      destinationId: destination.id,
      modelId: model.id,
      mode: row.mode,
      settingsRevision: row.revision,
      consentId: input.consentId,
      fingerprint,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      schemaVersion: 1,
      maxInputBytes: destination.maxInputBytes,
      maxOutputBytes: destination.maxOutputBytes,
      maxOutputTokens: destination.maxOutputTokens,
      maxAttempts: probe ? 1 : (input.maxAttempts ?? 2),
      reservationUnits: chatReservationUnits(
        input.parts,
        model,
        destination.maxOutputTokens,
      ),
    });
    const transport = traceChatExtractor(
      createChatCompletionsExtractor(destination, model, key),
      configuration.tracing,
      { syntheticProbe: probe, providerKey: key },
    );
    const extractor: InvoiceExtractor = {
      async extract(parts, approved, attempt, signal) {
        try {
          if (
            JSON.stringify(approved) !== JSON.stringify(config) ||
            signal?.aborted ||
            !(await recheckSettingsAndConsent())
          )
            return {
              status: "failed",
              reason: signal?.aborted ? "timeout" : "unsupported",
              usage: null,
            };
          if (signal?.aborted)
            return { status: "failed", reason: "timeout", usage: null };
          return transport.extract(parts, approved, attempt, signal);
        } catch {
          return { status: "failed", reason: "outage", usage: null };
        }
      },
    };
    const price: AiPriceSnapshot = {
      ...model.pricing,
      destinationId: destination.id,
      modelId: model.id,
      configVersion: destination.configVersion,
      policyVersion: destination.policyVersion,
      configurationDigest,
      ...(acceptedConfigurationDigest ? { acceptedConfigurationDigest } : {}),
    };
    return { config, extractor, pricing: new Map([[fingerprint, price]]) };
  }
  function safe<Args extends unknown[], Result>(
    operation: (...args: Args) => Promise<Result>,
  ) {
    return async (...args: Args) => {
      try {
        return await operation(...args);
      } catch (cause) {
        if (cause instanceof AiSettingsError) throw cause;
        throw new AiSettingsError("UNAVAILABLE");
      }
    };
  }
  return {
    open: safe(
      (
        tenant: TenantContext,
        input: {
          settingsRevision: number;
          consentId: string;
          parts: readonly AiTextPart[];
          maxAttempts?: 1 | 2;
        },
      ) => resolve(tenant, input, false),
    ),
    probe: safe(
      (
        tenant: TenantContext,
        input: { settingsRevision: number; parts: readonly AiTextPart[] },
      ) => resolve(tenant, { ...input, consentId: "synthetic-test" }, true),
    ),
  };
}

/** Synthetic control-plane probe; never creates a source, document, purchase or job. */
export function createAiProbeService(
  db: D1Database,
  configuration: AiConfiguration,
) {
  const factory = createAiProviderFactory(db, configuration);
  const fixture = Object.freeze([
    {
      id: "synthetic-ai-test-v1",
      text: "Synthetic receipt. Merchant: Example Store. Date: 2026-10-01. Currency: EUR. Total EUR 24.90. Paid EUR 24.90 by card. This is synthetic data, not a user document.",
    },
  ]);
  return {
    async test(
      session: { tenant: TenantContext; sessionId: string },
      version: number,
    ) {
      try {
        const selected = await factory.probe(session.tenant, {
          settingsRevision: version,
          parts: fixture,
        });
        const input = { config: selected.config };
        const store = createAiProbeUsageStore(db, {
          session,
          policy: configuration.budget,
          pricing: selected.pricing,
        });
        const existing = await store.checkpoint(input);
        if (existing.status === "completed") return existing.result;
        if (existing.status === "stale") throw new AiSettingsError("CONFLICT");
        const reserved = await store.reserve(input);
        if (reserved === "budget") throw new AiSettingsError("BUDGET");
        if (reserved === "existing") throw new AiSettingsError("CONFLICT");
        const attemptDigest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify([
              session.tenant.userId,
              selected.config.fingerprint,
              "synthetic-ai-test-v1",
            ]),
          ),
        );
        const attemptId = `probe:${Array.from(new Uint8Array(attemptDigest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
        if (!(await store.authorize(input))) {
          await store.settle(input, { state: "not-sent", usage: null });
          throw new AiSettingsError("CONFLICT");
        }
        const response = await selected.extractor.extract(
          fixture,
          selected.config,
          { id: attemptId, repair: false },
        );
        await store.settle(input, {
          state: response.usage ? "known" : "uncertain",
          usage: response.usage,
          ...(response.status === "failed" &&
          response.reason === "rate-limit" &&
          response.retryAfterMs !== undefined
            ? { retryAfterMs: response.retryAfterMs }
            : {}),
        });
        let result: AiProbeResult;
        if (response.status === "failed")
          result = { status: "failed", reason: response.reason };
        else if (response.finish !== "complete")
          result = { status: "failed", reason: "incomplete" };
        else {
          const validated = validateExtraction(
            response.output,
            fixture,
            selected.config.maxOutputBytes,
          );
          const exact =
            validated.status === "accepted" &&
            validated.records.some(
              (record) =>
                record.currency === "EUR" &&
                record.paymentAmount === "24.90" &&
                record.paymentEvidence === "explicitly-paid",
            );
          result = exact
            ? { status: "passed" }
            : { status: "failed", reason: "schema" };
        }
        if (!(await store.complete(input, result)))
          throw new AiSettingsError("CONFLICT");
        return result;
      } catch (cause) {
        if (cause instanceof AiSettingsError) throw cause;
        throw new AiSettingsError("UNAVAILABLE");
      }
    },
  };
}
