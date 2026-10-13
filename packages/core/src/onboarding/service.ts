import {
  hasControlCharacters,
  onboardingQuerySchema,
  onboardingStartRequestSchema,
  processingDisclosureQuerySchema,
} from "@invoxim/contracts";
import { DiscoveryError } from "../discovery/types";
import type {
  OnboardingRepository,
  OnboardingSession,
  OnboardingStartPreparationPort,
} from "./types";
import { OnboardingError } from "./types";
export function createOnboardingUsecases(options: {
  repository: OnboardingRepository;
  preparation: OnboardingStartPreparationPort | null;
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
        return options.repository.commitStart(session, ready.prepared, null);
      if (!options.preparation) throw new OnboardingError("UNAVAILABLE");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const seed = await options.preparation.prepare(
          session.tenant,
          {
            provider: ready.prepared.provider,
            connectionId: ready.prepared.connectionId,
            generation: ready.prepared.generation,
            credentialVersion: ready.prepared.credentialVersion,
            scopes: ready.prepared.scopes,
          },
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          seed.provider !== ready.prepared.provider ||
          (seed.provider === "gmail" &&
            (typeof seed.historyAnchor !== "string" ||
              !/^[0-9]{1,100}$/.test(seed.historyAnchor)))
        )
          throw new OnboardingError("UNAVAILABLE");
        const version =
          seed.provider === "gmail"
            ? seed.credentialFence?.credentialVersion
            : undefined;
        if (
          version !== undefined &&
          (!Number.isSafeInteger(version) ||
            version < 0 ||
            (version !== ready.prepared.credentialVersion &&
              (ready.prepared.credentialVersion >= Number.MAX_SAFE_INTEGER ||
                version !== ready.prepared.credentialVersion + 1)))
        )
          throw new OnboardingError("CONFLICT");
        return await options.repository.commitStart(
          session,
          version === undefined
            ? ready.prepared
            : { ...ready.prepared, credentialVersion: version },
          seed,
        );
      } catch (cause) {
        if (cause instanceof OnboardingError) throw cause;
        if (cause instanceof DiscoveryError && cause.code === "API_DISABLED")
          throw new OnboardingError("API_DISABLED");
        if (cause instanceof DiscoveryError && cause.code === "CONFLICT")
          throw new OnboardingError("CONFLICT");
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
