import type {
  DiscoveryProcessingSelection,
  DiscoveryReadinessPort,
} from "@invoxim/core";
import type { AiConfiguration } from "../ai/configuration";
import { selectedOnboardingConfigurationDigest } from "./configuration";
import { noticesReady } from "./read";
export type ProcessingReviewMetadata = DiscoveryProcessingSelection;
/** Pure configuration comparison; callers obtain metadata through their existing tenant/fence query. */
export function createProcessingReviewResolver(configuration: AiConfiguration) {
  return async (input: ProcessingReviewMetadata): Promise<string | null> => {
    if (
      !input.mode ||
      !Number.isSafeInteger(input.settingsRevision) ||
      input.settingsRevision < 1
    )
      return null;
    const destination = configuration.destinations.find(
        (entry) => entry.id === input.providerId,
      ),
      model = destination?.models.find((entry) => entry.id === input.modelId);
    if (
      !destination ||
      !model ||
      destination.configVersion !== input.configVersion ||
      destination.policyVersion !== input.policyVersion ||
      !noticesReady(destination)
    )
      return null;
    if (
      input.mode === "hosted" &&
      (!configuration.hosted ||
        configuration.hosted.destinationId !== destination.id ||
        configuration.hosted.modelId !== model.id)
    )
      return null;
    const expected = await selectedOnboardingConfigurationDigest({
      mode: input.mode,
      settingsRevision: input.settingsRevision,
      destination,
      model,
      classification: configuration.classification,
    });
    return expected === input.acceptedDigest ? expected : null;
  };
}

/** The discovery consent query supplies this owned metadata; no additional query or provider call. */
export function createProcessingDiscoveryReadiness(
  configuration: AiConfiguration,
): DiscoveryReadinessPort {
  const resolve = createProcessingReviewResolver(configuration);
  return {
    requiresProcessingSelection: true,
    async allow(_context, input) {
      return (
        !!input.processingSelection &&
        input.processingSelection.settingsRevision === input.settingsRevision &&
        input.processingSelection.policyVersion === input.disclosureVersion &&
        (await resolve(input.processingSelection)) !== null
      );
    },
  };
}
