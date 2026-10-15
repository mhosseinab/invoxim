import {
  type ApprovedAiConfig,
  EMAIL_CLASSIFICATION_VERSION,
} from "@invoxim/core";
import { hashJsonValue } from "../hash";
import type { PipelineClassificationFactory } from "../pipeline/types";
import type { AiPriceSnapshot } from "./budget";
import type { ReceiptClassificationConfiguration } from "./classification-config";
import {
  type ClassificationTransportSources,
  createClassificationTransport,
} from "./classification-transport";
import { buildFingerprintTuple } from "./configuration";
import { createDecisionEmailClassifier } from "./decision-classifier";
import { RECEIPT_DECISION_POLICY_VERSION } from "./decision-protocol";
import { AiSettingsError } from "./settings";

/** Classification fingerprint recipe (A1). Must stay byte-identical to budget.ts verification. */
export async function computeClassificationFingerprint(input: {
  configurationDigest: string;
  settingsRevision: number;
  generation: number;
  credentialVersion: number;
  policyVersion: number;
}): Promise<string> {
  return hashJsonValue(
    buildFingerprintTuple({
      mode: "hosted",
      ...input,
      consentId: "",
      promptVersion: EMAIL_CLASSIFICATION_VERSION,
      classificationAuthorization: true,
    }),
  );
}

/**
 * One explicitly disclosed hosted decision processor, independent of financial
 * BYOK routing. The configured provider selects its own transport; a missing
 * credential fails closed instead of using another provider.
 */
export function createReceiptClassifierFactory(
  db: D1Database,
  configuration: ReceiptClassificationConfiguration,
  options: ClassificationTransportSources,
): PipelineClassificationFactory {
  return {
    async open(lease, work, _parts, selected) {
      const authorityPrice = selected.pricing.get(selected.config.fingerprint);
      const transport = createClassificationTransport(configuration, options);
      if (
        !configuration.enabled ||
        !transport ||
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
      const configurationDigest = await hashJsonValue({
        classification: configuration,
        classifierPolicyVersion: RECEIPT_DECISION_POLICY_VERSION,
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
        destinationId: transport.destinationId,
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
        // One retry for a deferred provider rejection (rate limit) after its
        // Retry-After; outages and timeouts are still final for the document.
        maxAttempts: 2,
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
        classifier: createDecisionEmailClassifier(transport, configuration),
        pricing: new Map([[fingerprint, price]]),
        authorization: { config: selected.config, price: authorityPrice },
      };
    },
  };
}
