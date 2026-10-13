import type {
  DiscoveryProviderFactory,
  OnboardingStartDiscoveryFactory,
  OnboardingStartPreparationPort,
} from "@invoxim/core";
import { DiscoveryError } from "@invoxim/core";

/** Outlook starts durable inventory after consent; only Gmail captures pre-import history. */
export function createOnboardingImportPreparation(
  gmail:
    | (DiscoveryProviderFactory &
        Partial<Pick<OnboardingStartDiscoveryFactory, "openForStart">>)
    | null,
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
      const openForStart = gmail.openForStart;
      const opened = openForStart
        ? await (() => {
            if (
              input.credentialVersion === undefined ||
              input.scopes === undefined
            )
              throw new DiscoveryError("CONFLICT");
            return openForStart(
              context,
              {
                connectionId: input.connectionId,
                generation: input.generation,
                credentialVersion: input.credentialVersion,
                scopes: input.scopes,
              },
              signal,
            );
          })()
        : { provider: await gmail.open(context, input, signal) };
      const provider = opened.provider;
      if (signal.aborted) throw new DiscoveryError("UNAVAILABLE");
      const historyAnchor = await provider.anchor(signal);
      if (signal.aborted) throw new DiscoveryError("UNAVAILABLE");
      return {
        provider: "gmail",
        historyAnchor,
        ...("credentialVersion" in opened
          ? { credentialFence: { credentialVersion: opened.credentialVersion } }
          : {}),
      };
    },
  };
}
