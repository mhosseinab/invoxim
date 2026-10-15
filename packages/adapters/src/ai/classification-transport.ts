import type { ReceiptClassificationConfiguration } from "./classification-config";
import { classificationProvider } from "./classification-config";
import { type ClefBinding, createClefTransport } from "./clef";
import type { DecisionTransport } from "./decision-classifier";
import {
  createPerplexityTransport,
  PERPLEXITY_DESTINATION_ID,
  usablePerplexityApiKey,
} from "./perplexity-decider";

/** Platform credentials a classification transport may use; never configuration. */
export interface ClassificationTransportSources {
  readonly binding?: ClefBinding | undefined;
  readonly perplexityApiKey?: string | undefined;
}
/**
 * One readiness rule (AI-CLASSIFIER-PROVIDER): the configured provider's own
 * credential selects its transport, or classification is unavailable. There is
 * no fallback between providers.
 */
export function createClassificationTransport(
  configuration: ReceiptClassificationConfiguration,
  sources: ClassificationTransportSources,
): DecisionTransport | null {
  if (configuration.provider === PERPLEXITY_DESTINATION_ID)
    return usablePerplexityApiKey(sources.perplexityApiKey)
      ? createPerplexityTransport(sources.perplexityApiKey, configuration.model)
      : null;
  return classificationProvider(configuration) === "cloudflare-clef" &&
    sources.binding &&
    typeof sources.binding.run === "function"
    ? createClefTransport(sources.binding)
    : null;
}
