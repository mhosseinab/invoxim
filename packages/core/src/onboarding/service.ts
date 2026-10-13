import {
  hasControlCharacters,
  onboardingQuerySchema,
  onboardingStartRequestSchema,
  processingDisclosureQuerySchema,
} from "@invoxim/contracts";
import type { DiscoveryProviderFactory } from "../discovery/types";
import { DiscoveryError } from "../discovery/types";
import type { OnboardingRepository, OnboardingSession } from "./types";
import { OnboardingError } from "./types";
export function createOnboardingUsecases(options: {
  repository: OnboardingRepository;
  providers: DiscoveryProviderFactory | null;
}) {
  return {
    async view(session: OnboardingSession, input: unknown = {}) {
      const checked = onboardingQuerySchema.safeParse(input);
      if (!checked.success) throw new OnboardingError("INVALID_REQUEST");
      return options.repository.view(session, checked.data.connectionId);
    },
    async disclosure(session: OnboardingSession, input: unknown) {
      const checked = processingDisclosureQuerySchema.safeParse(input);
      if (!checked.success) throw new OnboardingError("INVALID_REQUEST");
      return options.repository.disclosure(session, checked.data);
    },
    async start(session: OnboardingSession, input: unknown, key: string) {
      const checked = onboardingStartRequestSchema.safeParse(input);
      if (
        !checked.success ||
        !key ||
        key.length > 200 ||
        hasControlCharacters(key)
      )
        throw new OnboardingError("INVALID_REQUEST");
      const ready = await options.repository.prepareStart(
        session,
        checked.data,
        key,
      );
      if (ready.kind === "existing") return ready.result;
      if (ready.prepared.resume)
        return options.repository.commitStart(session, ready.prepared, "");
      if (!options.providers) throw new OnboardingError("UNAVAILABLE");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const provider = await options.providers.open(
          session.tenant,
          {
            connectionId: ready.prepared.connectionId,
            generation: ready.prepared.generation,
          },
          controller.signal,
        );
        const anchor = await provider.anchor(controller.signal);
        if (!/^[0-9]{1,100}$/.test(anchor))
          throw new OnboardingError("UNAVAILABLE");
        return await options.repository.commitStart(
          session,
          ready.prepared,
          anchor,
        );
      } catch (cause) {
        if (cause instanceof OnboardingError) throw cause;
        if (
          cause instanceof DiscoveryError &&
          ["AUTH_REQUIRED", "UNAUTHORIZED"].includes(cause.code)
        )
          throw new OnboardingError("AUTH_REQUIRED");
        throw new OnboardingError("UNAVAILABLE");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
