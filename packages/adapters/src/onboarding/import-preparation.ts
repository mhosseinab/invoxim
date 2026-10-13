import type {
  DiscoveryProviderFactory,
  OnboardingStartPreparationPort,
} from "@invoxim/core";
import { DiscoveryError } from "@invoxim/core";

/** Outlook starts durable inventory after consent; only Gmail captures pre-import history. */
export function createOnboardingImportPreparation(
  gmail: DiscoveryProviderFactory | null,
  outlookEnabled: boolean,
): OnboardingStartPreparationPort {
  return {
    async prepare(context, input, signal) {
      if (signal.aborted) throw new DiscoveryError("UNAVAILABLE");
      if (input.provider === "outlook") {
        if (!outlookEnabled) throw new DiscoveryError("UNAVAILABLE");
        return { provider: "outlook" };
      }
      if (!gmail || input.provider !== "gmail")
        throw new DiscoveryError("UNAVAILABLE");
      const provider = await gmail.open(context, input, signal);
      if (signal.aborted) throw new DiscoveryError("UNAVAILABLE");
      const historyAnchor = await provider.anchor(signal);
      if (signal.aborted) throw new DiscoveryError("UNAVAILABLE");
      return { provider: "gmail", historyAnchor };
    },
  };
}
