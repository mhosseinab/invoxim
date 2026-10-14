import {
  type ApprovedAiConfig,
  EMAIL_CLASSIFICATION_VERSION,
} from "@invoxim/core";
import { hashOnboardingValue } from "../onboarding/configuration";
import type { PipelineClassificationFactory } from "../pipeline/types";
import type { AiPriceSnapshot } from "./budget";
import {
  CLEF_RECEIPT_POLICY_VERSION,
  type ClefBinding,
  createClefEmailClassifier,
  type ReceiptClassificationConfiguration,
} from "./clef";
import { buildFingerprintTuple } from "./configuration";
import { AiSettingsError } from "./settings";

/** Classification fingerprint recipe (A1). Must stay byte-identical to budget.ts verification. */
export async function computeClassificationFingerprint(input: {
  configurationDigest: string;
  settingsRevision: number;
  generation: number;
  credentialVersion: number;
  policyVersion: number;
}): Promise<string> {
  return hashOnboardingValue(
    buildFingerprintTuple({
      mode: "hosted",
      ...input,
      consentId: "",
      promptVersion: EMAIL_CLASSIFICATION_VERSION,
      classificationAuthorization: true,
    }),
  );
}

/** One explicitly disclosed hosted decision processor, independent of financial BYOK routing. */
export function createReceiptClassifierFactory(
  db: D1Database,
  configuration: ReceiptClassificationConfiguration,
  options: { binding: ClefBinding },
): PipelineClassificationFactory {
  return {
    async open(lease, work, _parts, selected) {
      const authorityPrice = selected.pricing.get(selected.config.fingerprint);
      if (
        !configuration.enabled ||
        !authorityPrice?.acceptedConfigurationDigest
      )
        throw new AiSettingsError("CONFLICT");
      const row = await db
        .prepare(
          "SELECT generation,credential_version FROM ai_settings WHERE user_id=? AND revision=? AND status='active'",
        )
        .bind(lease.context.userId, work.settingsRevision)
        .first<{ generation: number; credential_version: number }>();
      if (!row) throw new AiSettingsError("CONFLICT");
      const document = work.documents[work.documentIndex];
      if (!document) throw new AiSettingsError("CONFLICT");
      const configurationDigest = await hashOnboardingValue({
        classification: configuration,
        classifierPolicyVersion: CLEF_RECEIPT_POLICY_VERSION,
        sourceDocuments: [
          {
            partKey: document.partKey,
            contentHash: document.contentHash,
            parserVersion: document.parserVersion,
          },
        ],
      });
      const fingerprint = await computeClassificationFingerprint({
        configurationDigest,
        settingsRevision: work.settingsRevision,
        generation: row.generation,
        credentialVersion: row.credential_version,
        policyVersion: authorityPrice.policyVersion,
      });
      const config: ApprovedAiConfig = {
        destinationId: "cloudflare-clef",
        modelId: configuration.model,
        mode: "hosted",
        settingsRevision: work.settingsRevision,
        consentId: lease.consentId,
        fingerprint,
        promptVersion: EMAIL_CLASSIFICATION_VERSION,
        schemaVersion: 1,
        maxInputBytes: configuration.maxInputBytes,
        maxOutputBytes: 4096,
        maxOutputTokens: 1,
        maxAttempts: 1,
        reservationUnits: configuration.maxInputBytes + 4096,
      };
      const price: AiPriceSnapshot = {
        ...configuration.pricing,
        destinationId: config.destinationId,
        modelId: config.modelId,
        configVersion: configuration.version,
        policyVersion: authorityPrice.policyVersion,
        configurationDigest,
        acceptedConfigurationDigest: authorityPrice.acceptedConfigurationDigest,
      };
      return {
        config,
        uncertainAction: configuration.uncertainAction ?? "review",
        classifier: createClefEmailClassifier(options.binding, configuration),
        pricing: new Map([[fingerprint, price]]),
        authorization: { config: selected.config, price: authorityPrice },
      };
    },
  };
}
