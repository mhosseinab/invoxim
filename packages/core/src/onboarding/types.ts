import type {
  OnboardingDisclosure,
  OnboardingResponse,
  OnboardingStartRequest,
  OnboardingStartResponse,
  ProcessingDisclosureQuery,
} from "@invoxim/contracts";
import type { TenantContext } from "../tenant-context";
export interface OnboardingSession {
  readonly tenant: TenantContext;
  readonly sessionId: string;
  readonly loginEmail: string;
}
export interface PreparedOnboardingStart {
  readonly resume?: {
    readonly runId: string;
    readonly consentId: string;
    readonly priorGeneration: number;
  };
  readonly connectionId: string;
  readonly generation: number;
  readonly credentialVersion: number;
  readonly expectedProfileVersion: number;
  readonly expectedAiSettingsRevision: number;
  readonly selectedAiSettingsRevision: number;
  readonly settingsGeneration: number;
  readonly settingsCredentialVersion: number;
  readonly initializeHosted: boolean;
  readonly mode: "hosted" | "byok";
  readonly destinationId: string;
  readonly modelId: string;
  readonly configVersion: string;
  readonly policyVersion: number;
  readonly configurationDigest: string;
  readonly disclosureVersion: string;
  readonly parserDestination: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly startMs: number;
  readonly cutoffMs: number;
  readonly timezone: string;
  readonly reportingCurrency: string;
  readonly keyHash: string;
  readonly bodyHash: string;
  readonly intervalKey: string;
  readonly fingerprint: string;
}
export interface OnboardingRepository {
  view(
    session: OnboardingSession,
    connectionId?: string,
  ): Promise<OnboardingResponse>;
  disclosure(
    session: OnboardingSession,
    query: ProcessingDisclosureQuery,
  ): Promise<OnboardingDisclosure>;
  prepareStart(
    session: OnboardingSession,
    input: OnboardingStartRequest,
    key: string,
  ): Promise<
    | { kind: "existing"; result: OnboardingStartResponse }
    | { kind: "ready"; prepared: PreparedOnboardingStart }
  >;
  commitStart(
    session: OnboardingSession,
    prepared: PreparedOnboardingStart,
    historyAnchor: string,
  ): Promise<OnboardingStartResponse>;
}
export class OnboardingError extends Error {
  constructor(
    readonly code:
      | "UNAUTHORIZED"
      | "INVALID_REQUEST"
      | "CONFLICT"
      | "PROCESSING_REVIEW_REQUIRED"
      | "UNAVAILABLE"
      | "BUDGET"
      | "AUTH_REQUIRED",
  ) {
    super(code);
  }
}
