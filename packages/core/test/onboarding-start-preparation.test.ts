import { expect, it, vi } from "vitest";
import { createOnboardingUsecases } from "../src/onboarding/service";
import type {
  OnboardingRepository,
  OnboardingSession,
  PreparedOnboardingStart,
} from "../src/onboarding/types";
import type { TenantContext } from "../src/tenant-context";

const session: OnboardingSession = {
  tenant: {
    userId: "synthetic-start-owner",
    authority: "session",
  } as TenantContext,
  sessionId: "synthetic-session",
  loginEmail: "synthetic@example.invalid",
};
const input = {
  connectionId: "synthetic-mailbox",
  expectedConnectionGeneration: 1,
  expectedAiSettingsRevision: 0,
  expectedProfileVersion: 1,
  acceptedDisclosureVersion: "a".repeat(64),
  reviewToken: "synthetic-review-token",
  startDate: "2025-10-01",
  endDate: "2026-10-01",
  timezone: "UTC",
  reportingCurrency: "EUR",
  authorizeHourlySync: true,
};
function prepared(
  provider: "gmail" | "outlook",
  resume = false,
): PreparedOnboardingStart {
  return {
    provider,
    scopes: JSON.stringify(
      provider === "gmail"
        ? ["https://www.googleapis.com/auth/gmail.readonly"]
        : ["https://graph.microsoft.com/Mail.Read"],
    ),
    connectionId: input.connectionId,
    generation: 1,
    credentialVersion: 1,
    expectedProfileVersion: 1,
    expectedAiSettingsRevision: 0,
    selectedAiSettingsRevision: 1,
    settingsGeneration: 1,
    settingsCredentialVersion: 0,
    initializeHosted: true,
    mode: "hosted",
    destinationId: "synthetic-ai",
    modelId: "synthetic-model",
    configVersion: "v1",
    policyVersion: 1,
    configurationDigest: "b".repeat(64),
    disclosureVersion: input.acceptedDisclosureVersion,
    parserDestination: "local",
    startDate: input.startDate,
    endDate: input.endDate,
    startMs: Date.parse("2025-10-01T00:00:00Z"),
    cutoffMs: Date.parse("2026-10-01T00:00:00Z"),
    timezone: "UTC",
    reportingCurrency: "EUR",
    keyHash: "c".repeat(64),
    bodyHash: "d".repeat(64),
    intervalKey: "e".repeat(64),
    fingerprint: "f".repeat(64),
    ...(resume
      ? {
          resume: {
            runId: "synthetic-existing-run",
            consentId: "synthetic-old-consent",
            priorGeneration: 1,
          },
        }
      : {}),
  };
}
function repository(value: PreparedOnboardingStart) {
  const commit = vi.fn().mockResolvedValue({
    importRunId: "synthetic-run",
    reused: Boolean(value.resume),
  });
  const port: OnboardingRepository = {
    view: async () => {
      throw new Error("Unused view");
    },
    disclosure: async () => {
      throw new Error("Unused disclosure");
    },
    prepareStart: async () => ({ kind: "ready", prepared: value }),
    commitStart: commit,
  };
  return { port, commit };
}

it.each(["gmail", "outlook"] as const)(
  "ONBOARD-06 prepares %s through the narrow Start port and passes its actual seed to atomic commit",
  async (provider) => {
    const value = prepared(provider);
    const repo = repository(value);
    const seed =
      provider === "gmail"
        ? { provider, historyAnchor: "12345" }
        : { provider };
    const prepare = vi.fn().mockResolvedValue(seed);
    const usecases = createOnboardingUsecases({
      repository: repo.port,
      preparation: { prepare },
    });
    await expect(
      usecases.start(session, input, "synthetic-key"),
    ).resolves.toEqual({ importRunId: "synthetic-run", reused: false });
    expect(prepare).toHaveBeenCalledWith(
      session.tenant,
      { provider, connectionId: input.connectionId, generation: 1 },
      expect.any(AbortSignal),
    );
    expect(repo.commit).toHaveBeenCalledWith(session, value, seed);
  },
);

it.each(["gmail", "outlook"] as const)(
  "ONBOARD-06 resumed %s Start commits null seed without recapturing provider state",
  async (provider) => {
    const value = prepared(provider, true);
    const repo = repository(value);
    const prepare = vi
      .fn()
      .mockRejectedValue(new Error("Resume must not prepare"));
    await createOnboardingUsecases({
      repository: repo.port,
      preparation: { prepare },
    }).start(session, input, "synthetic-resume");
    expect(prepare).not.toHaveBeenCalled();
    expect(repo.commit).toHaveBeenCalledWith(session, value, null);
  },
);

it("ONBOARD-06 a mismatched preparation provider cannot reach commit", async () => {
  const repo = repository(prepared("outlook"));
  const prepare = vi
    .fn()
    .mockResolvedValue({ provider: "gmail", historyAnchor: "12345" });
  await expect(
    createOnboardingUsecases({
      repository: repo.port,
      preparation: { prepare },
    }).start(session, input, "synthetic-mismatch"),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(repo.commit).not.toHaveBeenCalled();
});

it.each(["", "not-a-history-id"])(
  "ONBOARD-06 invalid Gmail anchor %s cannot reach commit",
  async (historyAnchor) => {
    const repo = repository(prepared("gmail"));
    const prepare = vi
      .fn()
      .mockResolvedValue({ provider: "gmail", historyAnchor });
    await expect(
      createOnboardingUsecases({
        repository: repo.port,
        preparation: { prepare },
      }).start(session, input, "synthetic-invalid-anchor"),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(repo.commit).not.toHaveBeenCalled();
  },
);
